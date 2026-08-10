# 0003 - Food Bot's trigger data model: per-chat, sentinel global template, no category table

## Status
Accepted

## Context

Food Bot's old implementation (`bschat-bot`'s `FoodModule`) used a global `FoodCategory` (id, query, triggers) + `FoodTrigger` (trigger, categoryId) pair — no `chatId` at all, because the old bot only ever ran in one hardcoded group. Food Bot needs to run in arbitrary groups (same goal as Music Bot), which raises two questions the old schema never had to answer: does each group get its own trigger list, and does the category/trigger split still earn its keep.

Also inherited from the old code: `responseChance` (the probability the bot reacts to a detected trigger) was never persisted — it lived as `private responseChance = 100` on the bot's in-memory `FoodModule` instance, silently resetting to 100 on every restart. A real bug, not a design choice.

## Decision

**Per-chat data, seeded from a global template using a sentinel `chatId`, not `NULL`.** Every table carries `chatId BigInt`. Rows with `chatId = 0` are the global template (Telegram chat IDs are never 0, so it's a safe, always-distinguishable sentinel). When Food Bot joins a new chat, template rows are copied into that chat's own `chatId`. "Reset to defaults" deletes a chat's rows and re-copies from the template. Nullable `chatId` was considered and rejected: Postgres treats every `NULL` as distinct under a unique constraint, so `@@unique([trigger, chatId])` would silently allow duplicate "global" rows — the sentinel avoids that gotcha for zero practical cost.

**No separate category table.** The old `FoodCategory`/`FoodTrigger` split existed so renaming a category could update every trigger's association in one write. That's a real but small win (`updateMany` handles it in one call regardless), and the schema is small (~200 rows) and admin-curated, not free user input — so the typo-drift risk of denormalizing is low. Collapsed into one table:

```prisma
model FoodTrigger {
  id          Int      @id @default(autoincrement())
  chatId      BigInt   // 0 = global template
  trigger     String
  searchQuery String   // both the Unsplash search term and the display/group identity
  createdAt   DateTime @default(now())

  @@unique([trigger, chatId])
}

model FoodChatConfig {
  chatId         BigInt   @id
  responseChance Int      @default(100)   // now persisted — fixes the old in-memory-only bug
  seededAt       DateTime @default(now())
}
```

`/listfood` becomes a `DISTINCT searchQuery` query; `/renamefood` becomes a bulk `updateMany` on `searchQuery`.

**Seed data:** the global template (`chatId = 0`) is seeded from `bschat-bot`'s real production data (216 trigger words after removing a handful of crude/joke categories not appropriate for a template that could seed arbitrary public groups), not a fresh curated list.

## Consequences

- Two tables instead of three; no join for the bot's hot path (matching an incoming message against triggers).
- Renaming a category is a bulk update across matching rows, not a single-row edit — acceptable given admin-only curation at this scale.
- `chatId = 0` must be treated as reserved everywhere this table is queried per-chat (always filter it out of "real" per-chat listings unless explicitly reading the template).
- `responseChance` surviving a restart is a genuine behavior change from the old bot, not just a port.
