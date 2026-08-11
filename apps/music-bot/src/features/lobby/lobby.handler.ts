import { MusicScoringPreset } from "@bisya/db";
import { Composer } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { ActionCodec } from "../../codec/action.codec";
import { BotContext } from "../../context";
import { MusicGameService } from "../../services/music-game.service";
import { LobbyGameConfig, LobbyUi } from "./lobby.ui";

type Keyboard = { inline_keyboard: InlineKeyboardButton[][] };

/**
 * Ported from bschat-bot's
 * `src/modules/musicGame/features/lobby/lobby.handler.ts`.
 *
 * The old handler was an Inversify `@injectable()` with `@inject(...)`
 * constructor params and a `@RequirePermission('MANAGE_MUSIC_GAME')`
 * method decorator. Neither survives here: this monorepo's Music Bot uses
 * plain-constructor DI throughout (see `container.ts`'s note on why
 * Inversify wasn't carried forward), and `@bisya/bot-kit`'s ported
 * permission check (`requirePermission`) is a grammY middleware factory,
 * not a decorator - wiring it onto `/music` is `index.ts`'s job (issue #29)
 * once the container is threaded through there, not this file's.
 *
 * The old `ActionHelper<CallbackQueryContext>` (per-action `.handle()`
 * registry + its own `encode`/`dispatch`) is also gone - `ActionCodec` only
 * does `encode`/`decode` (see codec/action.codec.ts's B4 length guard), so
 * dispatch on the decoded action name is inlined in the constructor below
 * instead of going through a second helper class.
 *
 * `LobbyHandler extends Composer<BotContext>` and self-registers in the
 * constructor, the same shape `InfoHandler` (issue #28, already landed on
 * main) settled on for the same "no wrapper module yet, #29 wires
 * composers straight in" reason - see that file's note. Lets `#29` do
 * `bot.use(new LobbyHandler(container.musicGameService, container.actionCodec))`
 * the same way it does for the other feature composers.
 *
 * Scope note: bschat-bot's `music_game`/`music_lobby` distinction collapses
 * per spec.md 3.4 - `/music` is now the single group entry point, and it
 * renders the same panel `renderLobby` used to build for `/music_lobby`.
 * `handleMusicGame`'s old "ping everyone who has a track queued" behavior on
 * first setup isn't preserved 1:1 - the new lobby panel shows the same
 * "who's ready" info inline instead (see `LobbyUi.lobbyText`), which is a
 * strict improvement for the ticket's actual ask ("organizer can see who's
 * ready") over polling for a stale reply once at setup time.
 */
export class LobbyHandler extends Composer<BotContext> {
  constructor(
    private readonly musicGameService: MusicGameService,
    private readonly actionCodec: ActionCodec,
    private readonly ui: LobbyUi = new LobbyUi(),
  ) {
    super();

    this.command("music", (ctx) => this.handleMusic(ctx));

    // Callback data outside this handler's three namespaces is passed to
    // `next()` so other feature composers (gameplay's `guess:*`,
    // `round_*:*`, etc.) registered alongside this one still get a turn.
    this.on("callback_query:data", async (ctx, next) => {
      const decoded = this.actionCodec.decode(ctx.callbackQuery.data);
      if (!decoded) return next();

      switch (decoded.action) {
        case "lobby":
          return this.handleLobbyAction(ctx, decoded.args);
        case "settings":
          return this.handleSettingsAction(ctx, decoded.args);
        case "players":
          return this.handlePlayersAction(ctx, decoded.args);
        default:
          return next();
      }
    });
  }

  /**
   * `/music` - render the lobby interface. The single group-side entry
   * point (replaces `/music_lobby`).
   */
  async handleMusic(ctx: BotContext): Promise<void> {
    await this.renderLobby(ctx);
  }

  /**
   * Render the lobby interface: game status, who's ready, and the panel's
   * action buttons.
   */
  private async renderLobby(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;

    const [game, players] = await Promise.all([
      this.musicGameService.getCurrentGame(ctx.chat.id),
      this.musicGameService.getSubmissionPlayers(ctx.chat.id),
    ]);

    const keyboard = this.ui.lobbyKeyboard({
      start: this.actionCodec.encode("lobby", "start"),
      settings: this.actionCodec.encode("lobby", "settings"),
      info: this.actionCodec.encode("lobby", "info"),
      players: this.actionCodec.encode("lobby", "players"),
    });

    await this.respond(ctx, this.ui.lobbyText(game?.status ?? null, players), keyboard);
  }

  /**
   * Handle lobby button actions.
   */
  private async handleLobbyAction(ctx: BotContext, args: string[]): Promise<void> {
    const [action] = args;
    switch (action) {
      case "start":
        await this.musicGameService.startGame(ctx);
        await ctx.answerCallbackQuery();
        break;
      case "settings":
        await this.showSettings(ctx);
        await ctx.answerCallbackQuery();
        break;
      case "info":
        await this.musicGameService.showActiveGameInfo(ctx);
        await ctx.answerCallbackQuery();
        break;
      case "players":
        await this.showPlayers(ctx);
        await ctx.answerCallbackQuery();
        break;
      case "back":
        await this.renderLobby(ctx);
        await ctx.answerCallbackQuery();
        break;
      default:
        await ctx.answerCallbackQuery("Unknown action");
    }
  }

  /**
   * Show settings panel.
   */
  private async showSettings(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;

    let game = await this.musicGameService.getCurrentGame(ctx.chat.id);

    // If no game exists, create a LOBBY game with default config
    if (!game) {
      const created = await this.musicGameService.createLobbyForSettings(ctx.chat.id);
      if (!created) {
        await ctx.answerCallbackQuery("Failed to create game. Upload tracks first.");
        return;
      }
      game = await this.musicGameService.getCurrentGame(ctx.chat.id);
      if (!game) {
        await ctx.answerCallbackQuery("Failed to create game");
        return;
      }
    }

    const config = this.musicGameService.getGameConfig(game);
    const keyboard = this.ui.settingsKeyboard(config, {
      toggle: (key) => this.actionCodec.encode("settings", "toggle", key),
      setPreset: (preset) => this.actionCodec.encode("settings", "preset", preset),
      setDelay: (key, value) => this.actionCodec.encode("settings", "delay", key, value),
      back: this.actionCodec.encode("lobby", "back"),
    });

    await this.respond(ctx, this.ui.settingsText(config), keyboard);
  }

  /**
   * Handle settings actions.
   */
  private async handleSettingsAction(ctx: BotContext, args: string[]): Promise<void> {
    if (!ctx.chat) return;

    const [action, ...rest] = args;
    const game = await this.musicGameService.getCurrentGame(ctx.chat.id);
    if (!game) {
      await ctx.answerCallbackQuery("No active game found");
      return;
    }

    const currentConfig = this.musicGameService.getGameConfig(game);
    const newConfig: LobbyGameConfig = { ...currentConfig };

    switch (action) {
      case "toggle": {
        const key = rest[0];
        if (key === "autoAdvance") {
          newConfig.autoAdvance = !newConfig.autoAdvance;
        } else if (key === "shuffle") {
          newConfig.shuffle = !newConfig.shuffle;
        } else if (key === "allowSelfGuess") {
          newConfig.allowSelfGuess = !newConfig.allowSelfGuess;
        }
        break;
      }
      case "preset": {
        const preset = rest[0];
        if (preset === "classic" || preset === "aggressive" || preset === "gentle") {
          newConfig.scoringPreset = preset as MusicScoringPreset;
        }
        break;
      }
      case "delay": {
        const key = rest[0];
        const valueStr = rest[1];
        if (!key || !valueStr) {
          await ctx.answerCallbackQuery("Invalid delay parameters");
          return;
        }
        const value = parseInt(valueStr, 10);
        if (isNaN(value)) {
          await ctx.answerCallbackQuery("Invalid delay value");
          return;
        }
        if (key === "hintDelaySec") {
          newConfig.hintDelaySec = value;
        } else if (key === "advanceDelaySec") {
          newConfig.advanceDelaySec = value;
        }
        break;
      }
      default:
        await ctx.answerCallbackQuery("Unknown settings action");
        return;
    }

    await this.musicGameService.updateGameConfig(ctx.chat.id, newConfig);
    await this.showSettings(ctx);
    await ctx.answerCallbackQuery("Settings updated");
  }

  /**
   * Show players panel.
   */
  private async showPlayers(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;

    const players = await this.musicGameService.getSubmissionPlayers(ctx.chat.id);

    const keyboard = this.ui.playersKeyboard(players, {
      remove: (userId) => this.actionCodec.encode("players", "remove", userId),
      ping: this.actionCodec.encode("players", "ping"),
      back: this.actionCodec.encode("lobby", "back"),
    });

    await this.respond(ctx, this.ui.playersText(players), keyboard);
  }

  /**
   * Handle players actions.
   */
  private async handlePlayersAction(ctx: BotContext, args: string[]): Promise<void> {
    if (!ctx.chat) return;

    const [action, ...rest] = args;
    switch (action) {
      case "remove": {
        const userIdStr = rest[0];
        if (!userIdStr) {
          await ctx.answerCallbackQuery("Invalid player ID");
          return;
        }
        const userId = parseInt(userIdStr, 10);
        if (isNaN(userId)) {
          await ctx.answerCallbackQuery("Invalid player ID");
          return;
        }

        const result = await this.musicGameService.removePlayerTrack(ctx.chat.id, userId);
        if (result === "NO_GAME") {
          await ctx.answerCallbackQuery("No game found");
          return;
        }
        if (result === "NO_TRACK") {
          await ctx.answerCallbackQuery("Player has no track to remove");
          return;
        }

        await this.showPlayers(ctx);
        await ctx.answerCallbackQuery("Player track removed");
        break;
      }
      case "ping": {
        await this.musicGameService.pingPlayers(ctx);
        await ctx.answerCallbackQuery("Players pinged");
        break;
      }
      default:
        await ctx.answerCallbackQuery("Unknown players action");
    }
  }

  /**
   * Edits the triggering callback query's message in place when there is
   * one to edit, otherwise sends a fresh message (e.g. the `/music`
   * command itself, which has no callback query to edit).
   */
  private async respond(ctx: BotContext, text: string, replyMarkup: Keyboard): Promise<void> {
    if (ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: replyMarkup });
        return;
      } catch (error) {
        // Message may not be editable (e.g. it isn't a text message) -
        // fall back to sending a new one rather than dropping the update.
        console.error("Failed to edit lobby message, sending a new one:", error);
      }
    }
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: replyMarkup });
  }
}
