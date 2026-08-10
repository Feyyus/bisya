# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). One version number for the whole `music-bot` deployment — see [docs/releases.md](docs/releases.md) for what each version promises and the tagging process.

## [Unreleased]

Working towards v0.1.0 — "playable in one chat" (see [docs/releases.md](docs/releases.md)).

### Added
- Monorepo scaffold: pnpm workspaces, `apps/music-bot`, `packages/{db,wallet,scheduler,bot-kit}` (plan.md Phase 0)
- Prisma schema for users, chats, memberships, roles, games/rounds/guesses, wallet (plan.md Phase 1, still needs the B3/rename/wallet-table migrations)
- `@bisya/wallet` `WalletService`: idempotent credit/debit, balance, history (plan.md Phase 2 — built early, not yet wired to any bot code)
- Docker Compose for Postgres + Redis (bot itself not containerized yet)
- `docs/` — moved `requirements.md`, `spec.md`, `plan.md` out of repo root, added `docs/releases.md`

## [0.0.0] - Scaffold

Pre-release. Repo exists, nothing runs yet.
