# 0002 - Wallet as a shared package, not a separate service

## Status
Accepted

## Context
`requirements.md` §4.4 requires one coin wallet per Telegram user ID, shared across all bots. With [0001](./0001-separate-container-per-bot.md) giving each bot its own container, the question was whether `@bisya/wallet` should stay a package imported directly by each bot's process (calling Postgres in-process via Prisma), or become its own service that bots call over the network.

The case for a separate service: wallet code touches money, and 0001 just established "money-adjacent things get isolated."

## Decision
Keep `@bisya/wallet` as a directly-imported package, not a network service.

0001's isolation argument was about *bot-to-bot* blast radius — bot B's game-logic bug shouldn't take down bot A's payment handling. That's already solved by each bot being its own container: bot A's wallet calls run inside bot A's process regardless of whether `WalletService` is local code or an HTTP client. A wallet microservice would add a network hop between two things that don't need decoupling (a bot and its own container) without removing any risk that isn't already handled by the DB-level `idempotencyKey` unique constraint, which guarantees no-double-credit no matter how many processes call it directly.

## Consequences
- No new deployable, no internal auth boundary to design, no new failure mode (service reachable but DB fine, or vice versa) — cheap to operate, right for a solo project at this scale.
- Local dev stays simple: N bot processes + one Postgres, no wallet service to also run.
- Correctness for double-crediting continues to rely on the DB constraint, not on gatekeeping through a single service — this already holds today (see `packages/wallet/src/wallet.service.ts`).
- Revisit this decision if either becomes true:
  1. Something *other than these bots' own codebases* needs to touch wallets (a web dashboard, an admin panel, a third party) — that's a real trust-domain boundary, not just internal reuse.
  2. Defense-in-depth is wanted so a compromised or buggy bot process can't run arbitrary queries against the wallet tables even if it tried — a security boundary, not a crash boundary.
