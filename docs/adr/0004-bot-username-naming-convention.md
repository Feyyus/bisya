# 0004 - Telegram bot username convention: `Bisya`-prefixed CamelCase

## Status
Accepted

## Context

Every bot in this platform needs a real Telegram username (via BotFather) before it can be tested live. With more than one bot planned, usernames chosen ad hoc risk not reading as a family — the explicit goal (echoing the `@bisya/*` package scope decision) is that all bots cluster together, e.g. under a Telegram bot search for "bisya".

Two axes were in play: prefix vs. suffix placement, and separator/casing style.

Prefix placement isn't really optional given the clustering goal — a suffix or feature-first shape (`food_bisya_bot`) still substring-matches a "bisya" search but doesn't read or sort as a cohesive family. That ruled out anything but a `bisya`-first shape.

Casing/separator was a real taste call: `bisya_food_bot` (snake_case, matching the `@bisya/*` package scope precedent) vs. `BisyaFoodBot` (CamelCase, matching the visual style of bots like `@BotFather`) vs. `bisyafoodbot` (compact, but word boundaries mush together on longer names).

## Decision

**Prefix + CamelCase**: `BisyaFoodBot`, `BisyaMusicBot`, and so on for future bots. Telegram usernames are case-insensitive for matching/search, so this is a purely cosmetic choice relative to snake_case — chosen because it reads better to non-technical users (the actual audience for a bot's displayed username), which was judged more important here than consistency with the `@bisya/*` npm scope's snake_case-adjacent style, since the two names serve different audiences (developers vs. Telegram users).

## Consequences

- Every future bot's username starts with `Bisya`, non-negotiably, to preserve the clustering property this ADR exists to establish.
- The npm package scope (`@bisya/*`) and the Telegram username prefix (`Bisya`) intentionally use different casing conventions — this is not an inconsistency to fix, they're different naming surfaces for different audiences.
