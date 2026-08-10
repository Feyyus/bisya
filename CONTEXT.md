# Context

Domain vocabulary and standing conventions for this repo. Read alongside `docs/adr/` — this file is for naming/vocabulary and small conventions; `docs/adr/` is for decisions with real tradeoffs and consequences.

## Table naming

Tables owned by a single bot are prefixed with that bot's name (`FoodTrigger`, `FoodChatConfig`). Tables meant to be shared across every bot are left unprefixed (`User`, `Wallet`, `WalletTransaction`). Same "own vs. shared" split as [ADR 0001](docs/adr/0001-separate-container-per-bot.md)/[ADR 0002](docs/adr/0002-shared-wallet-package-not-service.md), applied to table names instead of packages. Music Bot's existing tables (`Game`, `GameRound`, `Guess`) predate this convention and aren't being renamed retroactively — it applies going forward.
