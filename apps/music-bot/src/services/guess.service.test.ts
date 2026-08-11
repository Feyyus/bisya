import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { GameStatus, RoundPhase } from '@bisya/db';
import { GuessService } from './guess.service.js';
import { GameLifecycleService } from './game-lifecycle.service.js';
import { MusicGameRepository } from '../repository/music-game.repository.js';
import { ClassicScoring } from './scoring.js';
import {
  createTestPrisma,
  seedLobbyWithTracks,
  uniqueId,
  withIdentityShuffle,
} from './test-support/db.js';

describe('GuessService', () => {
  const prisma = createTestPrisma();
  const repository = new MusicGameRepository(prisma);
  const lifecycle = new GameLifecycleService(repository);
  const guessService = new GuessService(repository);
  const classicScoring = new ClassicScoring();

  after(async () => {
    await prisma.$disconnect();
  });

  /** Starts a game with a single LIVE round owned by `roundOwner` and one
   * other participant who can guess on it. Returns the round id along with
   * both user ids so tests can drive `processGuess` directly. */
  async function startSingleRoundGame() {
    const chatId = uniqueId();
    const roundOwner = uniqueId();
    const guesser = uniqueId();
    await seedLobbyWithTracks(prisma, chatId, [
      { id: roundOwner, name: 'Owner' },
      { id: guesser, name: 'Guesser' },
    ]);
    // Pinned to an identity shuffle - see `withIdentityShuffle`'s doc comment
    // for the unrelated shuffle/unique-constraint gap this sidesteps so
    // scoring tests don't flake on it.
    const started = await withIdentityShuffle(() => lifecycle.start(chatId));
    assert.ok(typeof started === 'object' && 'chatId' in started, `setup failed: ${JSON.stringify(started)}`);
    const game = await repository.getCurrentGameByChatId(chatId);
    assert.ok(game);
    const round = game.rounds.find((r) => Number(r.userId) === roundOwner);
    assert.ok(round);
    return { chatId, gameId: game.id, roundId: round.id, roundOwner, guesser };
  }

  describe('time-elapsed scoring (relative to startedAt)', () => {
    test('a quick correct guess (<=30s elapsed) scores the fast-guess bonus', async () => {
      const { chatId, roundId, roundOwner, guesser } = await startSingleRoundGame();
      await prisma.gameRound.update({
        where: { id: roundId },
        data: { startedAt: new Date(Date.now() - 5_000) },
      });

      const result = await guessService.processGuess({
        chatId,
        roundId,
        guessingUserId: guesser,
        guessedUserId: roundOwner,
      });

      assert.ok(typeof result === 'object' && 'points' in result, `expected a score, got ${JSON.stringify(result)}`);
      const expected = classicScoring.score({
        isCorrect: true,
        isSelfGuess: false,
        timeElapsedSec: 5,
        hintShown: false,
        roundNumber: 0,
      });
      assert.equal((result as { points: number }).points, expected);
    });

    test('a slow correct guess (>120s elapsed) loses the fast-guess bonus', async () => {
      const { chatId, roundId, roundOwner, guesser } = await startSingleRoundGame();
      await prisma.gameRound.update({
        where: { id: roundId },
        data: { startedAt: new Date(Date.now() - 150_000) },
      });

      const result = await guessService.processGuess({
        chatId,
        roundId,
        guessingUserId: guesser,
        guessedUserId: roundOwner,
      });

      assert.ok(typeof result === 'object' && 'points' in result);
      const fast = classicScoring.score({
        isCorrect: true,
        isSelfGuess: false,
        timeElapsedSec: 5,
        hintShown: false,
        roundNumber: 0,
      });
      const slow = classicScoring.score({
        isCorrect: true,
        isSelfGuess: false,
        timeElapsedSec: 150,
        hintShown: false,
        roundNumber: 0,
      });
      assert.equal((result as { points: number }).points, slow);
      assert.ok(slow < fast, 'a slow guess must score strictly less than a fast one');
    });

    /**
     * B1 regression / null-safety: `guess.service.ts`'s doc comment says a
     * guess on a round whose `startedAt` is null should score 0 elapsed
     * time rather than crash on `null.getTime()`. This shouldn't be
     * reachable through the normal flow (guesses are gated on
     * `RoundPhase.LIVE`, and the only two places a round becomes LIVE -
     * `startGameFromLobby` and `setRoundLive` - both set `startedAt` in the
     * same write) - so this test forces the state directly via Prisma to
     * exercise the guard as insurance against that invariant breaking
     * elsewhere, per the acceptance criteria.
     */
    test('a LIVE round with startedAt somehow still null does not crash and scores 0 elapsed time', async () => {
      const { chatId, roundId, roundOwner, guesser } = await startSingleRoundGame();
      await prisma.gameRound.update({ where: { id: roundId }, data: { startedAt: null } });

      const result = await guessService.processGuess({
        chatId,
        roundId,
        guessingUserId: guesser,
        guessedUserId: roundOwner,
      });

      assert.ok(typeof result === 'object' && 'points' in result, `expected a score, not a crash: ${JSON.stringify(result)}`);
      const expected = classicScoring.score({
        isCorrect: true,
        isSelfGuess: false,
        timeElapsedSec: 0,
        hintShown: false,
        roundNumber: 0,
      });
      assert.equal((result as { points: number }).points, expected);
    });
  });

  describe('guards', () => {
    test('NO_ROUND for an unknown roundId', async () => {
      const result = await guessService.processGuess({
        chatId: 0,
        // GameRound.id is a Postgres INT4, unlike the BigInt Chat/User ids
        // `uniqueId()` produces elsewhere in this suite - a comfortably
        // out-of-range but still INT4-valid id, guaranteed not to exist.
        roundId: 999_999_999,
        guessingUserId: uniqueId(),
      });
      assert.equal(result, 'NO_ROUND');
    });

    test('ROUND_NOT_LIVE for a round still in DRAFT', async () => {
      const chatId = uniqueId();
      const owner = uniqueId();
      await seedLobbyWithTracks(prisma, chatId, [{ id: owner, name: 'Owner' }]);
      const game = await repository.getCurrentGameByChatId(chatId);
      const draftRound = game?.rounds[0];
      assert.ok(draftRound);
      assert.equal(draftRound.phase, RoundPhase.DRAFT);

      const result = await guessService.processGuess({
        chatId,
        roundId: draftRound.id,
        guessingUserId: uniqueId(),
      });
      assert.equal(result, 'ROUND_NOT_LIVE');
    });

    test('GAME_NOT_ACTIVE for a LIVE round whose game is not currently ACTIVE', async () => {
      const { chatId, gameId, roundId, guesser } = await startSingleRoundGame();
      // Force the game back to LOBBY without touching the round's own LIVE
      // phase, to exercise the GAME_NOT_ACTIVE guard in isolation from the
      // ROUND_NOT_LIVE guard checked just before it (ending the game via
      // `GameLifecycleService.end` also flips LIVE rounds to COMPLETED,
      // which would trip ROUND_NOT_LIVE first and never reach this branch)
      // - this state shouldn't occur via the normal service methods, it's
      // constructed directly to prove this specific guard fires.
      await prisma.game.update({ where: { id: gameId }, data: { status: GameStatus.LOBBY } });

      const result = await guessService.processGuess({ chatId, roundId, guessingUserId: guesser });
      assert.equal(result, 'GAME_NOT_ACTIVE');
    });
  });

  describe('re-entrancy: double-submitting a guess for the same round', () => {
    test('a second sequential guess from the same user on the same round returns ALREADY_GUESSED', async () => {
      const { chatId, roundId, roundOwner, guesser } = await startSingleRoundGame();

      const first = await guessService.processGuess({
        chatId,
        roundId,
        guessingUserId: guesser,
        guessedUserId: roundOwner,
      });
      assert.ok(typeof first === 'object');

      const second = await guessService.processGuess({
        chatId,
        roundId,
        guessingUserId: guesser,
        guessedUserId: roundOwner,
      });
      assert.equal(second, 'ALREADY_GUESSED');

      const guessRows = await prisma.guess.count({ where: { roundId, userId: BigInt(guesser) } });
      assert.equal(guessRows, 1);
    });

    /**
     * Real gap: the `ALREADY_GUESSED` guard is a check-then-insert
     * (`findGuess` followed by `createGuess`) with no transaction or
     * locking between the two, so two truly concurrent submissions from
     * the same user can both pass the `findGuess` check before either has
     * written anything - neither would observe `ALREADY_GUESSED` for what
     * is, at the millisecond level, a double submission.
     *
     * What saves this from being a data-integrity bug: `createGuess` goes
     * through `MusicGameRepository`'s `prisma.guess.upsert` keyed on the
     * `Guess`'s `@@unique([roundId, userId])` constraint, so even when both
     * calls "win" the race and neither sees `ALREADY_GUESSED`, Postgres
     * still guarantees exactly one `Guess` row for that
     * (round, user) pair - the second write updates the first row in place
     * rather than erroring or duplicating it. So the guard is racy, but the
     * invariant the acceptance criteria actually cares about (no duplicate
     * scored guesses) is enforced one layer down, at the database. This
     * test documents both halves: the guard *can* be bypassed, and the
     * unique constraint *does* still hold.
     */
    test('concurrent double-submit never produces two Guess rows, even though the ALREADY_GUESSED guard itself is racy', async () => {
      const { chatId, roundId, roundOwner, guesser } = await startSingleRoundGame();

      const results = await Promise.all([
        guessService.processGuess({ chatId, roundId, guessingUserId: guesser, guessedUserId: roundOwner }),
        guessService.processGuess({ chatId, roundId, guessingUserId: guesser, guessedUserId: roundOwner }),
      ]);
      // Neither call should ever throw/crash regardless of how the race
      // resolves - both a real score object and 'ALREADY_GUESSED' are
      // acceptable outcomes per result.
      for (const result of results) {
        assert.ok(
          result === 'ALREADY_GUESSED' || (typeof result === 'object' && 'points' in result),
          `unexpected result: ${JSON.stringify(result)}`,
        );
      }

      const guessRows = await prisma.guess.count({ where: { roundId, userId: BigInt(guesser) } });
      assert.equal(guessRows, 1, 'the unique (roundId, userId) constraint must prevent a duplicate row');
    });
  });
});
