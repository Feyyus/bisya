import { Composer } from "grammy";
import { BotContext } from "../../context";
import { MusicGameService } from "../../services/music-game.service";

/**
 * InfoHandler - the supporting info/help surface for a group's game.
 *
 * Ported from bschat-bot's
 * `src/modules/musicGame/features/info/info.handler.ts`, which wired eight
 * commands as thin one-line delegations to `MusicGameService` (no logic of
 * its own - everything real lives in the service, already ported in
 * `music-game.service.ts`). Per docs/spec.md Section 3.4, most of those
 * commands are superseded by lobby-panel buttons now; only three survive as
 * slash commands:
 * - `/music_stats` -> `getGameStats`
 * - `/music_ping` -> `pingPlayers`
 * - `/music_help` -> `showPlayerHelp`
 *
 * Dropped as commands (spec.md 3.4 folds these into the lobby panel's
 * button flow instead - the underlying `MusicGameService` methods are left
 * in place for whichever feature ends up wiring them as buttons, that's
 * outside this ticket's scope):
 * - `/music_info` -> `showActiveGameInfo`
 * - `/music_list` -> `listGames`
 * - `/music_players` -> `listPlayers`
 * - `/music_organizer_help` -> `showOrganizerHelp`
 * - `/music_dev_help` -> `showDeveloperHelp`
 *
 * bschat-bot wired `InfoHandler` into a top-level `MusicGameModule`
 * (`extends Composer<IBotContext>`) alongside `LobbyHandler` and
 * `GameplayHandler`, plus a shared callback_query dispatcher - explicitly
 * noting "Info handler has no callback actions". Music Bot doesn't have
 * that wrapper module yet (main composer wiring is `#29`, still open), so
 * `InfoHandler` extends `Composer<BotContext>` directly and self-registers
 * its commands in the constructor. That lets `#29` do
 * `bot.use(new InfoHandler(container.musicGameService))` the same way it
 * will for the other feature composers, without needing a wrapper module
 * that (per the old code's own note) would have nothing to dispatch for
 * this feature anyway.
 */
export class InfoHandler extends Composer<BotContext> {
  constructor(private readonly musicGameService: MusicGameService) {
    super();

    this.command("music_stats", (ctx) => this.musicGameService.getGameStats(ctx));
    this.command("music_ping", (ctx) => this.musicGameService.pingPlayers(ctx));
    this.command("music_help", (ctx) => this.musicGameService.showPlayerHelp(ctx));
  }
}
