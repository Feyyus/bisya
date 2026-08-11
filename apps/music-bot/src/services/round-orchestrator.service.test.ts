import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { MusicRoundPhase } from '@bisya/db';
import { SchedulerService } from '@bisya/scheduler';
import { ActionCodec } from '../codec/action.codec.js';
import { RoundOrchestratorService } from './round-orchestrator.service.js';
import { GameLifecycleService } from './game-lifecycle.service.js';
import { MusicGameRepository } from '../repository/music-game.repository.js';
import {
  createFakeApi,
  createTestPrisma,
  fakeTextService,
  seedLobbyWithTracks,
  uniqueId,
  withIdentityShuffle,
} from './test-support/db.js';

/** Waits until `predicate()` is true or `timeoutMs` elapses, polling every
 * `stepMs`. Used to observe the effect of `SchedulerService`'s real
 * `setTimeout`-based jobs firing, without coupling the test to an exact
 * delay. */
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 3000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
}

describe('RoundOrchestratorService', () => {
  const prisma = createTestPrisma();
  const repository = new MusicGameRepository(prisma);
  const lifecycle = new GameLifecycleService(repository);

  after(async () => {
    await prisma.$disconnect();
  });

  /** Starts a 2-round game with hints/auto-advance disabled by default, so
   * `startRound` doesn't leave a live `setTimeout` behind for tests that
   * aren't specifically exercising the scheduler - a stray timer would just
   * silently never fire (jobId reused per round, no assertions depend on
   * it), but there's no reason to leave the process's event loop occupied
   * for tests that don't need it. */
  async function startTwoRoundGame(overrides: { hintDelaySec?: number } = {}) {
    const chatId = uniqueId();
    const userA = uniqueId();
    const userB = uniqueId();
    await seedLobbyWithTracks(prisma, chatId, [
      { id: userA, name: 'Alice' },
      { id: userB, name: 'Bob' },
    ]);
    // Identity shuffle - see `withIdentityShuffle`'s doc comment for the
    // unrelated shuffle/unique-constraint gap this sidesteps.
    const started = await withIdentityShuffle(() =>
      lifecycle.startWithConfig(chatId, {
        hintDelaySec: overrides.hintDelaySec ?? 0,
        autoAdvance: false,
      }),
    );
    assert.ok(typeof started === 'object' && 'chatId' in started, `setup failed: ${JSON.stringify(started)}`);
    const game = await repository.getCurrentGameByChatId(chatId);
    assert.ok(game);
    return { chatId, gameId: game.id };
  }

  test('B1 regression: setRoundLive sets startedAt', async () => {
    const { gameId } = await startTwoRoundGame();
    const round = await repository.getRoundBySequence(gameId, 0);
    assert.ok(round);
    // startGameFromLobby already set startedAt once; force a distinguishably
    // stale value so this test actually proves setRoundLive touches it,
    // rather than passing because the earlier transition already did.
    const stale = new Date(Date.now() - 60_000);
    await prisma.musicGameRound.update({ where: { id: round.id }, data: { startedAt: stale } });

    await repository.setRoundLive(round.id);

    const updated = await repository.findRoundById(round.id);
    assert.ok(updated?.startedAt instanceof Date);
    assert.ok(
      updated!.startedAt!.getTime() > stale.getTime(),
      'setRoundLive must refresh startedAt, not leave the stale value in place',
    );
    assert.equal(updated?.phase, MusicRoundPhase.LIVE);
  });

  test('startRound sets startedAt on the round it plays and sends the audio to the right chat', async () => {
    const scheduler = new SchedulerService();
    const codec = new ActionCodec();
    const orchestrator = new RoundOrchestratorService(repository, scheduler, fakeTextService, codec);
    const { chatId, gameId } = await startTwoRoundGame();
    const fake = createFakeApi();

    await orchestrator.startRound(chatId, fake.api);

    const round = await repository.getRoundBySequence(gameId, 0);
    assert.ok(round?.startedAt instanceof Date);

    const audioCalls = fake.callsTo('sendAudio');
    assert.equal(audioCalls.length, 1);
    assert.equal(audioCalls[0]?.args[0], chatId);
  });

  test('a hint scheduled via SchedulerService fires and reaches showHintById for the right round/chat', async () => {
    const scheduler = new SchedulerService();
    const codec = new ActionCodec();
    const orchestrator = new RoundOrchestratorService(repository, scheduler, fakeTextService, codec);
    const { chatId, gameId } = await startTwoRoundGame({ hintDelaySec: 1 });
    const fake = createFakeApi();

    orchestrator.registerSchedulerHandlers(fake.api);
    await orchestrator.startRound(chatId, fake.api);

    const round = await repository.getRoundBySequence(gameId, 0);
    const otherRound = await repository.getRoundBySequence(gameId, 1);
    assert.ok(round && otherRound);
    assert.equal(round.hintShownAt, null);

    await waitUntil(async () => {
      const r = await repository.findRoundById(round.id);
      return r?.hintShownAt != null;
    });

    const hintRound = await repository.findRoundById(round.id);
    assert.ok(hintRound?.hintShownAt instanceof Date);

    // The other round in the same game must be untouched - the hint job is
    // keyed by roundId, not "whatever the current round happens to be".
    const untouchedRound = await repository.findRoundById(otherRound.id);
    assert.equal(untouchedRound?.hintShownAt, null);

    // No hintChatId/hintMessageId was ever saved for this DRAFT round (the
    // upload flow that captures those hasn't been exercised here), so
    // showHintById falls back to sending the generic hint-layout message to
    // the round's own chat.
    const hintMessages = fake.callsTo('sendMessage').filter((c) => c.args[0] === chatId);
    assert.ok(hintMessages.length >= 1, 'expected at least one message sent to the chat once the hint fired');
  });

  test('showHintById is idempotent: showing an already-shown hint again does not error and does not resend the layout message', async () => {
    const scheduler = new SchedulerService();
    const codec = new ActionCodec();
    const orchestrator = new RoundOrchestratorService(repository, scheduler, fakeTextService, codec);
    const { chatId, gameId } = await startTwoRoundGame();
    const round = await repository.getRoundBySequence(gameId, 0);
    assert.ok(round);

    const fake = createFakeApi();
    await orchestrator.showHintById(round.id, chatId, fake.api);
    assert.equal(fake.callsTo('sendMessage').length, 1);

    await orchestrator.showHintById(round.id, chatId, fake.api);
    // Second call short-circuits on `round.hintShownAt` already being set -
    // it still sends a ("already shown") notice, but must not touch the DB
    // again or send the hint layout a second time.
    assert.equal(fake.callsTo('sendMessage').length, 2);
  });

  test('advancing to the next round increments the sequence and starts a clean round (no leaked hint/guess state)', async () => {
    const scheduler = new SchedulerService();
    const codec = new ActionCodec();
    const orchestrator = new RoundOrchestratorService(repository, scheduler, fakeTextService, codec);
    const { chatId, gameId } = await startTwoRoundGame();
    const fake = createFakeApi();

    const firstRound = await repository.getRoundBySequence(gameId, 0);
    assert.ok(firstRound);
    // Give round 0 some state that must not leak into round 1.
    await repository.showHint(firstRound.id);

    await orchestrator.advanceToNextRound(chatId, gameId, fake.api);

    const game = await repository.getGameById(gameId);
    assert.equal(game?.currentSequence, 1);

    const nextRound = await repository.getRoundBySequence(gameId, 1);
    assert.ok(nextRound);
    assert.equal(nextRound.phase, MusicRoundPhase.LIVE);
    assert.ok(nextRound.startedAt instanceof Date);
    assert.equal(nextRound.hintShownAt, null, "the new round's hint state must not inherit the previous round's");
    assert.equal(nextRound.guesses.length, 0);

    // The old round is untouched by advancing past it - still LIVE, still
    // carrying its own hint state. (Nothing in this codebase currently
    // marks a round COMPLETED except ending the whole game - see
    // GameLifecycleService.end - so a stale round remains queryable as
    // LIVE. Documented here as existing/intended behavior, not asserted as
    // a defect.)
    const untouchedFirstRound = await repository.findRoundById(firstRound.id);
    assert.equal(untouchedFirstRound?.phase, MusicRoundPhase.LIVE);
    assert.ok(untouchedFirstRound?.hintShownAt instanceof Date);
  });
});
