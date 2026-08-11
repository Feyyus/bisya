import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { MusicGameStatus, MusicRoundPhase } from '@bisya/db';
import { GameLifecycleService } from './game-lifecycle.service.js';
import { MusicGameRepository } from '../repository/music-game.repository.js';
import {
  createTestPrisma,
  seedChatAndUsers,
  seedLobbyWithTracks,
  uniqueId,
  withIdentityShuffle,
  withStubbedRandom,
} from './test-support/db.js';

describe('GameLifecycleService', () => {
  const prisma = createTestPrisma();
  const repository = new MusicGameRepository(prisma);
  const lifecycle = new GameLifecycleService(repository);

  after(async () => {
    await prisma.$disconnect();
  });

  describe('start()', () => {
    test('with no lobby at all returns NO_LOBBY', async () => {
      const chatId = uniqueId();
      const result = await lifecycle.start(chatId);
      assert.equal(result, 'NO_LOBBY');
    });

    test('with a lobby that has no submitted tracks returns NO_TRACKS', async () => {
      const chatId = uniqueId();
      await seedChatAndUsers(prisma, chatId, []);
      await repository.createEmptyLobby(chatId);
      const result = await lifecycle.start(chatId);
      assert.equal(result, 'NO_TRACKS');
    });

    test('transitions a LOBBY game with tracks to ACTIVE, flips DRAFT rounds to LIVE with startedAt set', async () => {
      const chatId = uniqueId();
      const userA = uniqueId();
      const userB = uniqueId();
      const { gameId } = await seedLobbyWithTracks(prisma, chatId, [
        { id: userA, name: 'Alice' },
        { id: userB, name: 'Bob' },
      ]);

      const gameBefore = await repository.getGameById(gameId);
      assert.equal(gameBefore?.status, MusicGameStatus.LOBBY);
      assert.ok(gameBefore?.rounds.every((r) => r.phase === MusicRoundPhase.DRAFT));
      assert.ok(gameBefore?.rounds.every((r) => r.startedAt === null));

      const result = await withIdentityShuffle(() => lifecycle.start(chatId));
      assert.ok(typeof result === 'object' && 'chatId' in result, `expected success, got ${JSON.stringify(result)}`);

      const gameAfter = await repository.getGameById(gameId);
      assert.equal(gameAfter?.status, MusicGameStatus.ACTIVE);
      assert.equal(gameAfter?.currentSequence, 0);
      assert.equal(gameAfter?.rounds.length, 2);
      for (const round of gameAfter?.rounds ?? []) {
        assert.equal(round.phase, MusicRoundPhase.LIVE);
        assert.ok(round.startedAt instanceof Date, 'startedAt should be set on the LOBBY->ACTIVE transition');
      }
      // Sequences got shuffled but must still be a contiguous 0..n-1 range,
      // one round per position.
      const sequences = (gameAfter?.rounds ?? []).map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, [0, 1]);
    });

    test('calling start() again once ACTIVE returns ALREADY_ACTIVE and does not touch round state', async () => {
      const chatId = uniqueId();
      const { gameId } = await seedLobbyWithTracks(prisma, chatId, [
        { id: uniqueId(), name: 'Alice' },
      ]);
      await lifecycle.start(chatId);
      const activeGame = await repository.getGameById(gameId);
      const startedAtBefore = activeGame?.rounds[0]?.startedAt?.getTime();

      const result = await lifecycle.start(chatId);
      assert.equal(result, 'ALREADY_ACTIVE');

      const stillActive = await repository.getGameById(gameId);
      assert.equal(stillActive?.rounds[0]?.startedAt?.getTime(), startedAtBefore);
    });

    /**
     * Real gap, not a regression test for a fix: `start()` reads the
     * current game status, and only *then* (in a separate DB round trip)
     * transitions it via `startGameFromLobby`'s transaction. Two concurrent
     * calls can both observe LOBBY before either commits, and both attempt
     * to flip the same DRAFT rounds to LIVE at sequences 0..n-1 -
     * `MusicGameRound`'s `@@unique([gameId, sequence])` constraint means the
     * second transaction to reach a given row's UPDATE collides and the
     * whole transaction fails with a Postgres unique-violation, which
     * `start()`'s try/catch turns into a plain `'ERROR'`.
     *
     * Empirically (see the race investigation for this ticket) this can
     * even mean *both* concurrent calls fail with `'ERROR'`, leaving the
     * game stuck in LOBBY - a real double-click/retry on `/music_start`
     * can require a second manual retry to actually start the game. There
     * is no advisory lock or `UPDATE ... WHERE status = 'LOBBY'` guard
     * making this transition atomic against itself.
     *
     * What *does* hold, and what this test asserts: no duplicate `MusicGame`
     * row is ever created for the chat - `start()` always operates on the
     * one existing LOBBY game rather than creating a second one, so the
     * failure mode is "transient error, safe to retry", not "duplicate
     * game/split-brain state".
     */
    test('concurrent double-start never creates a duplicate MusicGame row (gap: both calls can fail transiently, see comment)', async () => {
      const chatId = uniqueId();
      await seedLobbyWithTracks(prisma, chatId, [
        { id: uniqueId(), name: 'Alice' },
        { id: uniqueId(), name: 'Bob' },
      ]);

      // Both outcomes below are legitimate given the race described above -
      // this deliberately does not assert on the pair of results, only on
      // the invariant that must hold regardless of how the race resolves.
      // Pinned to an identity shuffle so this test's failures are only ever
      // about the concurrency race it's actually investigating, not the
      // separate shuffle/unique-constraint gap covered below.
      await withIdentityShuffle(() => Promise.all([lifecycle.start(chatId), lifecycle.start(chatId)]));

      const games = await repository.getGamesOfChat(chatId);
      assert.equal(games.length, 1, 'exactly one MusicGame row must exist for the chat, win or lose');
    });

    /**
     * Regression test for a fixed bug (not one of the known B1/B2/B3 bugs,
     * found while writing this suite): `startGameFromLobby`'s round-
     * shuffling loop used to write each round's new `sequence` one row at
     * a time -
     *
     * ```
     * for (let i = 0; i < shuffledRounds.length; i++) {
     *   await tx.musicGameRound.update({ where: { id: shuffledRounds[i].id }, data: { sequence: i, ... } });
     * }
     * ```
     *
     * - and whenever the shuffle actually reordered the rounds (as opposed
     * to leaving them in their original order), an early iteration could
     * try to write a `sequence` value that another round in the same game
     * still held (hadn't been updated yet in this same loop), tripping
     * `MusicGameRound`'s `@@unique([gameId, sequence])` constraint mid-transaction.
     * Since `shuffleArray` is a real Fisher-Yates shuffle, this wasn't a
     * corner case - for a 2-round game it happened on ~50% of starts where
     * the shuffle actually swapped the two rounds.
     *
     * Fixed by having `startGameFromLobby` assign sequences in two passes
     * inside the transaction: first offsetting every round's sequence
     * outside the live 0..n-1 range, then assigning the real shuffled
     * values - so no write ever targets a sequence another row is still
     * holding.
     *
     * `Math.random` is stubbed here (see `withStubbedRandom`) to force a
     * swap deterministically for a 2-round game, rather than relying on
     * chance to reproduce it.
     */
    test('starting a 2-round game succeeds even when the shuffle actually reorders rounds', async () => {
      const chatId = uniqueId();
      const { gameId } = await seedLobbyWithTracks(prisma, chatId, [
        { id: uniqueId(), name: 'Alice' },
        { id: uniqueId(), name: 'Bob' },
      ]);

      // Math.random() -> 0 forces shuffleArray's single swap (i=1, j=0) for
      // a 2-element array, guaranteeing a reordering.
      const result = await withStubbedRandom(0, () => lifecycle.start(chatId));

      assert.ok(
        typeof result === 'object' && 'chatId' in result,
        `expected success, got ${JSON.stringify(result)}`,
      );

      const started = await repository.getGameById(gameId);
      assert.equal(started?.status, MusicGameStatus.ACTIVE);
      assert.ok(started?.rounds.every((r) => r.phase === MusicRoundPhase.LIVE));
      const sequences = (started?.rounds ?? []).map((r) => r.sequence).sort((a, b) => a - b);
      assert.deepEqual(sequences, [0, 1]);
    });
  });

  describe('end()', () => {
    test('with no active/lobby game returns NO_ACTIVE', async () => {
      const chatId = uniqueId();
      const result = await lifecycle.end(chatId);
      assert.equal(result, 'NO_ACTIVE');
    });

    test('ends an ACTIVE game: status ENDED, LIVE rounds flip to COMPLETED', async () => {
      const chatId = uniqueId();
      const { gameId } = await seedLobbyWithTracks(prisma, chatId, [{ id: uniqueId(), name: 'Alice' }]);
      await lifecycle.start(chatId);

      const result = await lifecycle.end(chatId);
      assert.equal(result, 'ENDED');

      const ended = await repository.getGameById(gameId);
      assert.equal(ended?.status, MusicGameStatus.ENDED);
      assert.ok(ended?.rounds.every((r) => r.phase === MusicRoundPhase.COMPLETED));
      assert.ok(ended?.rounds.every((r) => r.endedAt instanceof Date));
    });
  });
});
