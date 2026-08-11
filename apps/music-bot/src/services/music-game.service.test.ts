import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { MemberService } from '@bisya/bot-kit';
import { GameStatus } from '@bisya/db';
import { SchedulerService } from '@bisya/scheduler';
import { ActionCodec } from '../codec/action.codec.js';
import { MusicGameService } from './music-game.service.js';
import { GameLifecycleService } from './game-lifecycle.service.js';
import { GuessService } from './guess.service.js';
import { RoundOrchestratorService } from './round-orchestrator.service.js';
import { MusicGameRepository } from '../repository/music-game.repository.js';
import { ClassicScoring } from './scoring.js';
import {
  createFakeApi,
  createTestPrisma,
  fakeTextService,
  seedLobbyWithTracks,
  uniqueId,
  withIdentityShuffle,
} from './test-support/db.js';

/**
 * These tests are not calling out to real Telegram/grammY - `memberService`
 * is unused by the code paths under test here (game-ending and leaderboard
 * generation never touch chat membership), so a cast stands in for it
 * rather than pulling in `@bisya/bot-kit`'s `MemberService` for a dependency
 * this test never exercises.
 */
const fakeMemberService = {} as unknown as MemberService;

describe('MusicGameService: game ending and leaderboard', () => {
  const prisma = createTestPrisma();
  const repository = new MusicGameRepository(prisma);
  const guessService = new GuessService(repository);
  const lifecycle = new GameLifecycleService(repository);
  const roundOrchestrator = new RoundOrchestratorService(
    repository,
    new SchedulerService(),
    fakeTextService,
    new ActionCodec(),
  );
  const musicGameService = new MusicGameService(
    repository,
    fakeTextService,
    fakeMemberService,
    guessService,
    roundOrchestrator,
    lifecycle,
  );
  const classicScoring = new ClassicScoring();

  after(async () => {
    await prisma.$disconnect();
  });

  /** Starts a 2-round game (one round per user) and returns each user's own
   * round id, so tests can have each user guess on the *other's* round. */
  async function startTwoPlayerGame(names: { a: string; b: string }) {
    const chatId = uniqueId();
    const userA = uniqueId();
    const userB = uniqueId();
    await seedLobbyWithTracks(prisma, chatId, [
      { id: userA, name: names.a },
      { id: userB, name: names.b },
    ]);
    // Identity shuffle - see `withIdentityShuffle`'s doc comment for the
    // unrelated shuffle/unique-constraint gap this sidesteps.
    const started = await withIdentityShuffle(() => lifecycle.start(chatId));
    assert.ok(typeof started === 'object' && 'chatId' in started, `setup failed: ${JSON.stringify(started)}`);
    const game = await repository.getCurrentGameByChatId(chatId);
    assert.ok(game);
    const roundOfA = game.rounds.find((r) => Number(r.userId) === userA);
    const roundOfB = game.rounds.find((r) => Number(r.userId) === userB);
    assert.ok(roundOfA && roundOfB);

    // Fast, deterministic scoring bucket for every guess in these tests.
    await prisma.gameRound.updateMany({
      where: { gameId: game.id },
      data: { startedAt: new Date(Date.now() - 5_000) },
    });

    return { chatId, gameId: game.id, userA, userB, roundOfA: roundOfA.id, roundOfB: roundOfB.id };
  }

  /** Ends the game via the public path the bot actually uses: calling
   * `startRound` once the game's `currentSequence` has run past its last
   * round, exactly like `RoundOrchestratorService.advanceToNextRound` would
   * eventually do. Forcing `currentSequence` directly (rather than calling
   * `advanceToNextRound` twice) keeps this test from depending on
   * `SchedulerService` timers with the default 30s hint delay. */
  async function endGameAndCaptureMessages(chatId: number, gameId: number) {
    await repository.updateGameRound(gameId, 2);
    const fake = createFakeApi();
    await musicGameService.startRound(chatId, fake.api);
    return fake;
  }

  test('leaderboard totals match recorded guesses when every guess is correct', async () => {
    const { chatId, gameId, userA, userB, roundOfA, roundOfB } = await startTwoPlayerGame({
      a: 'Alice',
      b: 'Bob',
    });

    // B correctly guesses A's round; A correctly guesses B's round.
    await guessService.processGuess({ chatId, roundId: roundOfA, guessingUserId: userB, guessedUserId: userA });
    await guessService.processGuess({ chatId, roundId: roundOfB, guessingUserId: userA, guessedUserId: userB });

    const expectedPoints = classicScoring.score({
      isCorrect: true,
      isSelfGuess: false,
      timeElapsedSec: 5,
      hintShown: false,
      roundNumber: 0,
    });

    const sumA = await prisma.guess.aggregate({ where: { userId: BigInt(userA) }, _sum: { points: true } });
    const sumB = await prisma.guess.aggregate({ where: { userId: BigInt(userB) }, _sum: { points: true } });
    assert.equal(sumA._sum.points, expectedPoints);
    assert.equal(sumB._sum.points, expectedPoints);

    const fake = await endGameAndCaptureMessages(chatId, gameId);

    const leaderboardMessage = fake.calls.find((c) => c.method === 'sendMessage' && String(c.args[1]).includes('🏆'));
    assert.ok(leaderboardMessage, 'expected a leaderboard message to be sent');
    const text = String(leaderboardMessage!.args[1]);
    assert.ok(text.includes(`Alice — 🏆 ${expectedPoints} очков`));
    assert.ok(text.includes(`Bob — 🏆 ${expectedPoints} очков`));

    const endedGame = await repository.getGameById(gameId);
    assert.equal(endedGame?.status, GameStatus.ENDED);
  });

  /**
   * Real gap, not a fixed bug: `MusicGameService`'s private
   * `calculateUserStats` only adds `guess.points` into a user's
   * `totalPoints` inside the "guessed correctly" branch:
   *
   * ```
   * if (round.userId === guess.guessedId) {
   *   stats.correct++;
   *   stats.totalPoints += guess.points;
   * } else {
   *   stats.incorrect++;
   * }
   * ```
   *
   * `GuessService`/`ClassicScoring` do compute and persist a real negative
   * `points` value (-2 by default) on the `Guess` row for a wrong answer -
   * that part works. But the leaderboard/stats aggregation silently drops
   * it: a wrong guess only increments `incorrect`, its penalty never
   * reaches `totalPoints`. So "leaderboard calculation matches the actual
   * guesses/scores recorded" (this ticket's acceptance criterion) does
   * *not* hold whenever a player has at least one incorrect guess - their
   * displayed total is higher than what's actually in the `Guess` table.
   *
   * This test pins down the actual (buggy) behavior rather than the
   * intended one, so it'll fail loudly if someone changes
   * `calculateUserStats` without also revisiting this test - flagging this
   * here instead of silently asserting the mismatch as correct.
   */
  test('gap: a wrong guess is scored (negative points persisted) but silently excluded from the leaderboard total', async () => {
    const { chatId, gameId, userA, userB, roundOfA, roundOfB } = await startTwoPlayerGame({
      a: 'Carol',
      b: 'Dave',
    });

    // B correctly guesses A's round (+points). A incorrectly guesses B's
    // round (guesses themselves instead of Dave) - a flat -2 under classic
    // scoring, independent of elapsed time.
    await guessService.processGuess({ chatId, roundId: roundOfA, guessingUserId: userB, guessedUserId: userA });
    const wrongGuess = await guessService.processGuess({
      chatId,
      roundId: roundOfB,
      guessingUserId: userA,
      guessedUserId: userA,
    });
    assert.ok(typeof wrongGuess === 'object' && 'points' in wrongGuess);
    assert.equal((wrongGuess as { isCorrect: boolean; points: number }).isCorrect, false);
    assert.equal((wrongGuess as { points: number }).points, -2);

    // Ground truth: A really does have a -2 point guess recorded.
    const recordedSumForA = await prisma.guess.aggregate({
      where: { userId: BigInt(userA) },
      _sum: { points: true },
    });
    assert.equal(recordedSumForA._sum.points, -2);

    const fake = await endGameAndCaptureMessages(chatId, gameId);
    const leaderboardMessage = fake.calls.find((c) => c.method === 'sendMessage' && String(c.args[1]).includes('🏆'));
    assert.ok(leaderboardMessage);
    const text = String(leaderboardMessage!.args[1]);

    // The leaderboard shows Carol (userA) at 0 points with one wrong guess
    // tallied - not -2. This is the gap: the displayed total (0) doesn't
    // match what's actually recorded in the Guess table (-2).
    assert.ok(
      text.includes('Carol — 🏆 0 очков (🎯 0 угадано, ❌ 1 не угадано)'),
      `leaderboard text did not match expected (buggy) shape:\n${text}`,
    );
  });
});
