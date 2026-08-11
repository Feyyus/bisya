# bisya

A monorepo hosting the `@bisya` family of Telegram bots, sharing infrastructure (DB, wallet, scheduler, bot-kit middleware) instead of repeating it per bot.

- **Food Bot** (`BisyaFoodBot`) — live. Detects food words in group chats and replies with a matching Unsplash photo.
- **Music Bot** — in progress. A music-guessing party game: players submit tracks privately, the bot plays them anonymously in a group, and players guess whose track it is. Migrating out of a private friend-group monolith into a standalone bot.

Not public yet.

## Layout

```
apps/food-bot/       grammY bot process for Food Bot (deployed, live)
apps/music-bot/      grammY bot process for Music Bot (in progress)
packages/db/         Prisma schema, client, migrations — shared by all bots
packages/wallet/     coin ledger (credit/debit/balance), shared by all bots
packages/scheduler/  delayed-job wrapper for hint/auto-advance timers
packages/bot-kit/    shared grammY middleware (session, membership sync, permissions)
infra/               docker-compose.yml (Postgres, Redis) for local dev
```

## Docs

Start at [docs/README.md](docs/README.md) — links to requirements, spec, the phased implementation plan, and the release roadmap. Food Bot's deployment notes and the SOCKS5-proxy debugging writeup live in `docs/research/`.

## Status

See [CHANGELOG.md](CHANGELOG.md) for what's built and [docs/releases.md](docs/releases.md) for what's next. Food Bot's release plan and decisions are tracked in the wayfinder map at [issue #1](https://github.com/Feyyus/bisya/issues/1).

## Development

```sh
pnpm install
pnpm build
docker compose -f infra/docker-compose.yml up postgres redis
```
