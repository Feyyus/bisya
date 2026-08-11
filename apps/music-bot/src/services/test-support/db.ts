import type { Api } from 'grammy';
import type { ITextService } from '@bisya/bot-kit';
import { PrismaClient } from '@bisya/db';
import { MusicGameRepository } from '../../repository/music-game.repository';

/**
 * Shared test infrastructure for the service-layer test suite
 * (`*.service.test.ts` files next to this directory).
 *
 * These tests exercise the real service classes against a real Postgres
 * database rather than mocking Prisma - `game-lifecycle.service.ts`,
 * `round-orchestrator.service.ts`, and `guess.service.ts` all lean on
 * Postgres-level guarantees (transactions, unique constraints) for their
 * correctness, so a mocked Prisma client would test the mock's behavior
 * instead of the real one. See the top of `music-game-flow.md`-equivalent
 * ticket discussion (issue #32) for why.
 *
 * ## Running these tests
 *
 * 1. Bring up Postgres: `docker compose -f infra/docker-compose.yml up -d postgres`
 *    (or point `TEST_DATABASE_URL` at any Postgres instance you have).
 * 2. Create a dedicated test database once and apply migrations to it:
 *    ```
 *    docker exec <postgres-container> psql -U postgres -c "CREATE DATABASE music_guess_bot_test;"
 *    cd packages/db && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/music_guess_bot_test npx prisma migrate deploy
 *    ```
 *    A dedicated database (not the shared dev `music_guess_bot` one) is
 *    deliberate - these tests create/delete real rows and shouldn't collide
 *    with manual testing or other agents' work against the dev database.
 * 3. `pnpm --filter @bisya/music-bot test`.
 */

/**
 * Defaults to a local Postgres with the same credentials
 * `infra/docker-compose.yml` provisions, pointed at a database named
 * `music_guess_bot_test` (sibling to the `music_guess_bot` dev database,
 * not the same one - see the module doc above). Override with
 * `TEST_DATABASE_URL` to point at a different instance/CI service.
 */
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:postgres@localhost:5432/music_guess_bot_test';

export function createTestPrisma(): PrismaClient {
  const datasourceUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  return new PrismaClient({ datasourceUrl });
}

/**
 * Generates ids that are unique within a test process and (with high
 * probability) across concurrently-running test files, so fixtures in
 * different tests never collide on `Chat.id`/`User.id`/etc. even though
 * node:test runs each test file in its own process against the same shared
 * test database.
 *
 * Seeded from `Date.now()` (folding in `process.pid` so two test files
 * launched within the same millisecond still get different ranges) at
 * module load, plus a per-process monotonic counter. `* 1_000` leaves the
 * result at roughly 1.8e15 - comfortably under `Number.MAX_SAFE_INTEGER`
 * (2^53 ~= 9.007e15), unlike an earlier version of this helper that
 * multiplied by 1_000_000 and silently rounded every id to the same
 * imprecise value once the product exceeded the safe-integer range
 * (surfaced as Postgres foreign-key violations between values that were
 * only "different" in JS before losing precision).
 */
const idProcessBase = (Date.now() + (process.pid % 1000)) * 1_000;
let idCounter = 0;
export function uniqueId(): number {
  idCounter += 1;
  return idProcessBase + idCounter;
}

/** Minimal `ITextService` fake: returns the lookup key verbatim, ignoring
 * interpolation args. These tests assert on service *behavior* (return
 * values, DB state, which API calls fired), not on user-facing copy, so a
 * real i18next-backed `TextService` (which also needs a `locales/` dir this
 * app doesn't ship yet) would only add noise. */
export const fakeTextService: ITextService = {
  get: ((key: unknown) => String(key)) as ITextService['get'],
};

export interface RecordedApiCall {
  method: string;
  args: unknown[];
}

export interface FakeApi {
  /** Cast to grammY's `Api` type for passing into service methods. */
  api: Api;
  calls: RecordedApiCall[];
  callsTo(method: string): RecordedApiCall[];
}

/**
 * A fake for grammY's `Api` client covering just the methods
 * `RoundOrchestratorService`/`MusicGameService` actually call
 * (`sendMessage`, `sendAudio`, `copyMessage`, `answerCallbackQuery`,
 * `editMessageText`). Records every call so tests can assert who got
 * messaged and with what, without needing a real bot token or hitting
 * Telegram's API.
 */
export function createFakeApi(): FakeApi {
  const calls: RecordedApiCall[] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return {} as never;
    };

  const api = {
    sendMessage: record('sendMessage'),
    sendAudio: record('sendAudio'),
    copyMessage: record('copyMessage'),
    answerCallbackQuery: record('answerCallbackQuery'),
    editMessageText: record('editMessageText'),
  };

  return {
    api: api as unknown as Api,
    calls,
    callsTo: (method: string) => calls.filter((c) => c.method === method),
  };
}

/** Bare-minimum Chat/User fixture creation, going straight to Prisma rather
 * than through `@bisya/bot-kit`'s `MemberService` - these tests only need
 * rows that satisfy `Game`/`GameRound`'s foreign keys, not membership
 * bookkeeping, and staying off `MemberService` keeps this test-support
 * module decoupled from a package under active development elsewhere in
 * this repo. */
export async function seedChatAndUsers(
  prisma: PrismaClient,
  chatId: number,
  users: { id: number; name: string }[],
): Promise<void> {
  await prisma.chat.upsert({
    where: { id: chatId },
    create: { id: chatId, title: `Test chat ${chatId}` },
    update: {},
  });
  for (const user of users) {
    await prisma.user.upsert({
      where: { id: user.id },
      create: { id: user.id, name: user.name },
      update: { name: user.name },
    });
  }
}

/**
 * Seeds a chat, its users, a LOBBY game, and one DRAFT round per user (as if
 * each user had already uploaded a track) - the state
 * `GameLifecycleService.start`/`startWithConfig` expect to find before a
 * game can transition out of LOBBY.
 */
export async function seedLobbyWithTracks(
  prisma: PrismaClient,
  chatId: number,
  users: { id: number; name: string }[],
): Promise<{ gameId: number }> {
  await seedChatAndUsers(prisma, chatId, users);

  const repository = new MusicGameRepository(prisma);
  const game = await repository.createEmptyLobby(chatId);
  for (const user of users) {
    await repository.upsertDraftRound(game.id, {
      userId: user.id,
      musicFileId: `file-${user.id}`,
    });
  }

  return { gameId: game.id };
}

/**
 * Temporarily stubs the global `Math.random` for the duration of `fn`, then
 * restores it - the only lever available to make
 * `MusicGameRepository.shuffleArray`'s outcome deterministic from a test,
 * since it calls `Math.random()` directly with no injectable source.
 *
 * Exists because of a real bug this suite found in
 * `startGameFromLobby` (see `game-lifecycle.service.test.ts`'s
 * "gap: ..." test): its shuffle-then-flip-to-LIVE loop writes each round's
 * new `sequence` one row at a time, and whenever the shuffle actually
 * reorders rounds (as opposed to leaving them in their original order),
 * that loop can transiently try to write a `sequence` value another
 * not-yet-updated row in the same game still holds, tripping
 * `GameRound`'s `@@unique([gameId, sequence])` constraint. That failure is
 * unrelated to whatever a given test is actually about, so most fixture
 * setup here pins `Math.random` to a value that keeps `shuffleArray`'s
 * Fisher-Yates pass an identity permutation (no reordering, so no
 * collision) for the small (<=3-round) games this suite uses - see
 * `withIdentityShuffle`.
 */
export async function withStubbedRandom<T>(value: number, fn: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = () => value;
  try {
    return await fn();
  } finally {
    Math.random = original;
  }
}

/**
 * `Math.random` pinned to a value that keeps `shuffleArray`'s Fisher-Yates
 * pass an identity permutation for arrays up to a few dozen elements
 * (`Math.floor(0.999999 * (i + 1)) === i` for every loop index i this
 * suite's fixtures ever reach). See `withStubbedRandom` for why.
 */
export function withIdentityShuffle<T>(fn: () => Promise<T>): Promise<T> {
  return withStubbedRandom(0.999999, fn);
}
