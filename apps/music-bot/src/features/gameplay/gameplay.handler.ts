import { Composer, NextFunction } from 'grammy';
import { ActionCodec } from '../../codec/action.codec';
import { BotContext } from '../../context';
import { MusicGameService } from '../../services/music-game.service';

/**
 * Gameplay Handler - active game round interactions.
 *
 * Ported from bschat-bot's
 * `src/modules/musicGame/features/gameplay/gameplay.handler.ts`. Handles:
 * - `/music_start`, `/music_end`
 * - `guess:<roundId>:<userId>` - a player's guess at whose track is playing
 * - `round_hint:<roundId>`, `round_replay:<roundId>`, `round_skip:<roundId>`,
 *   `round_reveal:<roundId>` - the round-control buttons rendered by
 *   `GameplayUi.roundControls`
 *
 * B2-style port (same shape as `RoundOrchestratorService`/`MusicGameService`):
 * the old file was an `@injectable()` class registered into an
 * `ActionHelper<CallbackQueryContext>` owned by a parent `Composer`
 * (`MusicGameModule`) that ran one shared `bot.on(callbackQuery('data'), ...)`
 * dispatcher for every music-game feature. Neither Inversify nor
 * `ActionHelper` exist in this monorepo (see `container.ts`'s notes on why
 * DI is a plain factory function here), and no `MusicGameModule`-equivalent
 * has been ported yet either - wiring multiple feature composers together
 * under one bot instance is bootstrap-ticket territory, not this one (see
 * the note on `RoundOrchestratorService.registerSchedulerHandlers` for the
 * same kind of gap).
 *
 * `GameplayHandler` is therefore its own grammY `Composer<BotContext>`,
 * self-contained: it registers its own commands and its own
 * `callback_query:data` listener, decoding `callback_data` via
 * `ActionCodec.decode` (replacing `ActionHelper.dispatch`) and calling
 * `next()` for any action it doesn't own. That makes it safe to `bot.use()`
 * directly, and composable with sibling feature composers (lobby/info/
 * upload) once those exist and something mounts them all - each composer's
 * `callback_query:data` listener falls through to the next one via `next()`
 * until someone's `ActionCodec.decode(...).action` matches.
 *
 * Dropped `game_start` (`actions.handle('game_start', ...)` in the old
 * file): the only place that ever sent that callback_data was
 * `MusicGameService.initiateGameSetup`, which built it as the *literal*
 * string `'game:start'` (see `Markup.button.callback('Начать игру',
 * 'game:start')` in bschat-bot's `music-game.service.ts`) - `:`-delimited,
 * so `ActionHelper`/`ActionCodec` would decode it as action `"game"` with
 * arg `"start"`, never `"game_start"`. That button never actually reached
 * this handler; the real "start game from a button" path is
 * `LobbyHandler`'s `lobby:start` action, which already calls
 * `musicGameService.startGame(ctx)` (lobby feature, out of this ticket's
 * scope - see issue #27's resolution comment for a note pointing this out).
 *
 * Also dropped `@RequirePermission('MANAGE_MUSIC_GAME')` on
 * `/music_start`/`/music_end`. `@bisya/bot-kit` has the mechanism
 * (`requirePermission` middleware, ported from the same decorator's logic),
 * but no bot-specific permission bit registry exists yet in this app (the
 * old `PERMISSIONS.MANAGE_MUSIC_GAME` constant was bschat-bot-specific and
 * wasn't ported - see `packages/bot-kit/src/permissions/permission.ts`'s
 * notes on that). Left ungated rather than inventing a bit value here that
 * a parallel lobby-composer ticket (which had the same
 * `@RequirePermission('MANAGE_MUSIC_GAME')` on `/music_game`/`/music_lobby`)
 * might independently invent a different value for - flagged in the
 * resolution comment on issue #27.
 */
export class GameplayHandler extends Composer<BotContext> {
  constructor(
    private readonly musicGameService: MusicGameService,
    private readonly codec: ActionCodec,
  ) {
    super();

    this.command('music_start', (ctx) => this.handleMusicStart(ctx));
    this.command('music_end', (ctx) => this.handleMusicEnd(ctx));
    this.on('callback_query:data', (ctx, next) =>
      this.handleCallbackQuery(ctx, ctx.callbackQuery.data, next),
    );
  }

  /** `/music_start` - start a new game (or continue an existing lobby). */
  async handleMusicStart(ctx: BotContext): Promise<void> {
    await this.musicGameService.startGame(ctx);
  }

  /** `/music_end` - end the current active game. */
  async handleMusicEnd(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    await this.musicGameService.endGame(ctx.chat.id, ctx.api);
  }

  private async handleCallbackQuery(
    ctx: BotContext,
    data: string,
    next: NextFunction,
  ): Promise<void> {
    const decoded = this.codec.decode(data);
    if (!decoded) {
      await next();
      return;
    }

    switch (decoded.action) {
      case 'guess':
        await this.handleGuess(ctx, decoded.args);
        return;
      case 'round_hint':
        await this.handleRoundHint(ctx);
        return;
      case 'round_replay':
        await this.handleRoundReplay(ctx);
        return;
      case 'round_skip':
        await this.handleRoundSkip(ctx);
        return;
      case 'round_reveal':
        await this.handleRoundReveal(ctx);
        return;
      default:
        // Not a gameplay action - let a sibling composer (lobby/info/
        // upload) have a turn.
        await next();
    }
  }

  /**
   * `guess:<roundId>:<guessedUserId>` - a player guessing whose track is
   * currently playing. Parameter validation ported from the old handler
   * (invalid/unparseable args get a callback-query-only error, same as
   * before); the actual scoring/feedback happens inside
   * `MusicGameService.processGuess`, which owns answering the callback
   * query for every other outcome (already guessed, round not live, game
   * not active, correct/wrong) via `GuessService`.
   */
  private async handleGuess(ctx: BotContext, args: string[]): Promise<void> {
    const [roundIdRaw, guessedUserIdRaw] = args;
    if (!roundIdRaw || !guessedUserIdRaw) {
      console.error('Invalid guess parameters:', {
        args,
        callbackData: ctx.callbackQuery?.data,
      });
      await ctx.answerCallbackQuery('Ошибка: неверные параметры догадки');
      return;
    }

    const roundId = parseInt(roundIdRaw, 10);
    const guessedUserId = parseInt(guessedUserIdRaw, 10);
    if (isNaN(roundId) || isNaN(guessedUserId)) {
      console.error('Failed to parse guess parameters:', {
        roundIdRaw,
        guessedUserIdRaw,
        callbackData: ctx.callbackQuery?.data,
      });
      await ctx.answerCallbackQuery('Ошибка: неверные параметры догадки');
      return;
    }

    await this.musicGameService.processGuess(ctx, roundId, guessedUserId);
  }

  /** `round_hint:<roundId>` - show the current round's hint right now. */
  private async handleRoundHint(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    await this.musicGameService.showHint(ctx.chat.id, ctx.api);
    await ctx.answerCallbackQuery();
  }

  /** `round_replay:<roundId>` - resend the current round's audio. */
  private async handleRoundReplay(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    await this.musicGameService.replayCurrentRound(ctx.chat.id, ctx.api);
    await ctx.answerCallbackQuery();
  }

  /** `round_skip:<roundId>` - skip the current round and advance. */
  private async handleRoundSkip(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    await this.musicGameService.skipCurrentRound(ctx.chat.id, ctx.api);
    await ctx.answerCallbackQuery();
  }

  /** `round_reveal:<roundId>` - reveal the current round's answer. */
  private async handleRoundReveal(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    await this.musicGameService.revealCurrentRound(ctx.chat.id, ctx.api);
    await ctx.answerCallbackQuery();
  }
}
