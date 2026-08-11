# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). This monorepo hosts multiple bots (`@bisya/*`) with independent release tracks; entries are grouped by bot. See [docs/releases.md](docs/releases.md) for `music-bot`'s tagging process.

## Food Bot

### [1.0.0] - Live on the homelab

First release. Passive listener only (no admin/mutation commands yet — deferred pending `bot-kit`'s permission middleware).

- `/start` with a one-tap "add to group" deep link
- Russian word-stem trigger detection (216-row seed template, per-chat overrides via `chatId=0` sentinel)
- Unsplash photo replies with a "typing" indicator while fetching
- Deployed via Docker Compose on the homelab, routed through an SSH SOCKS5 proxy (Telegram and Unsplash are both blocked from that network - see `docs/research/ssh-socks5-longpoll-hang.md`)
- Push-to-deploy CI/CD via a self-hosted GitHub Actions runner on the homelab

## Music Bot

### [Unreleased]

Working towards v0.1.0 — "playable in one chat" (see [docs/releases.md](docs/releases.md)).

### Added
- Monorepo scaffold: pnpm workspaces, `apps/music-bot`, `packages/{db,wallet,scheduler,bot-kit}` (plan.md Phase 0)
- Prisma schema for users, chats, memberships, roles, games/rounds/guesses, wallet (plan.md Phase 1, still needs the B3/rename/wallet-table migrations)
- `@bisya/wallet` `WalletService`: idempotent credit/debit, balance, history (plan.md Phase 2 — built early, not yet wired to any bot code)
- Docker Compose for Postgres + Redis (bot itself not containerized yet)
- `docs/` — moved `requirements.md`, `spec.md`, `plan.md` out of repo root, added `docs/releases.md`

### [0.0.0] - Scaffold

Pre-release. Repo exists, nothing runs yet.
