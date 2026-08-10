# Releases

This isn't a published-package monorepo — nothing in `packages/*` goes to npm, every `package.json` sits at `0.0.0`, and the only thing that actually ships is the `music-bot` Docker/process deployment. So "release" here means: *cut a tag when there's a version of the bot you'd actually let your friends play, and write down what it can and can't do yet.*

The guiding rule: get something real running in the friend-group chat as early as possible, even if it's missing features from [spec.md](./spec.md) — then harden it in place. Don't gold-plate before it's been played.

## Milestones

Each milestone below is a slice of [plan.md](./plan.md)'s phases, chosen so the slice is independently playable — not just independently buildable.

### v0.1.0 — Playable in one chat
**Phases:** 0, 1, 4, 5, 6, 7, 9, 11 (see plan.md for the exact checkbox list; each phase is tagged `Target: v0.1.0`).

A real game runs start-to-finish in your friend group: submit tracks privately, lobby panel, rounds with guesses and scoring, leaderboard. Runs as one long-lived process against local/manual Postgres — no Docker packaging of the bot itself, no Redis, no BullMQ, no wallet wired in.

Known gaps, accepted on purpose:
- **B2 only half-fixed.** Services take `chatId`/`api` instead of a captured `ctx` (the part of B2 that's just correctness), but hint/auto-advance timers are still in-memory `setTimeout`s — a bot restart mid-round silently drops them. Fine for a single always-on process with no rolling deploys.
- **No monetization.** `@bisya/wallet` exists (built in Phase 2 because it was cheap and isolated) but nothing calls `credit`/`debit` yet.
- **No containerized bot.** `docker compose up postgres redis` for the DB; the bot process itself runs directly (`pnpm --filter @bisya/music-bot dev` or equivalent).

**Release gate:** Phase 11's checklist, played for real with at least 2 friends, end to end, once.

### v0.2.0 — Durable
**Phases:** 3, 8, 10, plus the deferred half of Phase 6/9 (registering BullMQ workers) and the deferred Phase 11 checkbox (restart mid-round).

Hints and auto-advance move to BullMQ/Redis — a restart no longer eats a scheduled event. The bot gets a Dockerfile and joins `infra/docker-compose.yml` as a real service, so it can run unattended instead of in a terminal.

**Release gate:** kill the bot process mid-round on purpose, confirm the hint/advance still fires on restart.

### v0.3.0 — Monetizable
**Phases:** 12 (Phase 2's `WalletService` finally gets wired to a payment handler and a real spend point).

Pick the payment provider (Stars preferred per spec.md §2), implement the payment handler, credit on purchase, debit on the first purchasable feature, confirm duplicate webhook delivery only credits once.

**Release gate:** the integration test in Phase 12 (double-fired webhook → one credit) plus one real purchase by you.

### v0.4.0+ — Public-launch hardening
Not planned in detail yet. Candidates, pulled from plan.md's "Deferred" section: second bot scaffolding, Redis session storage if session loss becomes a real complaint, Turborepo caching if builds get slow. Don't plan these in depth until v0.3.0 is out and actually being used.

## Process

No changesets, no npm publish, no per-package version bumps — one version number for the whole `music-bot` deployment, since it's one deployable unit.

1. When a milestone's release gate passes, bump the root `package.json` `version` if you want one source of truth for "what's running" (optional — the git tag is the real record).
2. Add a dated entry to [CHANGELOG.md](../CHANGELOG.md) under the new version, moving items out of `Unreleased`.
3. `git tag v0.1.0 -m "Playable in one chat"` and push the tag.
4. Deploy that tag's commit to wherever the bot actually runs.

Tag *after* the friend-chat playtest passes, not before — the tag should mean "this commit was verified working," not "this commit was intended to work."
