# 0001 - Separate container per bot, not one process for all bots

## Status
Accepted

## Context
The monorepo is designed to host more than one Telegram bot (`requirements.md` §2.2: one more bot expected within 6-12 months), all sharing one Postgres database and one wallet ledger via `packages/db` and `packages/wallet`.

Two runtime shapes were on the table:
- Each bot (`apps/music-bot`, future `apps/*`) runs as its own container/process.
- All bots run as separate `grammY` `Bot` instances inside one process/container.

Running everything in one process is less to operate (one container, one deploy, one log stream) — relevant for a solo operator on a homelab.

## Decision
Each bot gets its own container. They share packages (`@bisya/db`, `@bisya/wallet`, `@bisya/scheduler`, `@bisya/bot-kit`) and one Postgres instance, but not a runtime process.

This is already how `infra/docker-compose.yml` is heading (each bot as its own `docker-compose` service per `spec.md` §11.1) — this ADR makes explicit that it's a deliberate choice, not just the default the spec happened to describe.

## Consequences
- A crash or bad deploy in one bot's game logic cannot take down another bot's process — including that bot's in-flight payment/wallet handling, which matters once real money is involved.
- Each bot can be restarted or redeployed independently (`docker compose restart music-bot` doesn't touch other bots).
- Slightly more `docker-compose.yml` per new bot (one more service block) — judged cheap relative to the isolation gained.
- If this turns out to be overkill (e.g. the homelab genuinely can't carry N containers), collapsing into one process later is possible but not free — code should avoid assuming per-bot global/module-level state that would need to be pulled apart.
