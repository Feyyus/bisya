/**
 * InfoUi - placeholder for future info-surface rendering.
 *
 * Ported from bschat-bot's `src/modules/musicGame/features/info/info.ui.ts`,
 * which was itself just an `@injectable()` marker class with no members and
 * a comment noting that formatting was still done in the service layer,
 * "prepared for future UI extraction" (a plan that was never carried out -
 * stats/help text still lives entirely in `MusicGameService.getGameStats` /
 * `pingPlayers` / `showPlayerHelp`).
 *
 * Kept as the same intentionally-empty placeholder here, minus the
 * Inversify decorator (this monorepo wires dependencies via plain
 * constructor factories - see `container.ts`). Left in place per the
 * ticket's acceptance criteria (port `InfoUi` alongside `InfoHandler` since
 * it exists as a separate file in the old code); fill it in if/when
 * leaderboard/stats formatting actually gets extracted out of the service.
 */
export class InfoUi {}
