import type { ITextService, MemberService } from '@bisya/bot-kit';
import { MusicGameStatus, MusicRoundPhase } from '@bisya/db';
import { Composer, Filter, NextFunction } from 'grammy';
import { ActionCodec } from '../../codec/action.codec';
import { BotContext } from '../../context';
import { GameWithData, MusicGameRepository } from '../../repository/music-game.repository';

type CallbackDataContext = Filter<BotContext, 'callback_query:data'>;
type AudioMessageContext = Filter<BotContext, 'message:audio'>;
type TextMessageContext = Filter<BotContext, 'message:text'>;

/** `ActionCodec` action name used for the group-selection inline buttons. */
const CHAT_SELECT_ACTION = 'chat_select';

/**
 * Upload composer - lets a user DM the bot to submit a track for one of
 * their group's games.
 *
 * Ported from bschat-bot's `src/modules/musicGame/music-game-upload.module.ts`
 * (`MusicGameUploadModule`). Notable deviations from the original:
 *
 * - Dropped the Inversify `@injectable()`/`@inject()` wiring - this repo's
 *   services are plain classes taking constructor params (see
 *   `container.ts`), same pattern used here.
 * - Dropped `ZazuService` ("cute"/"funny" reaction) entirely - it's
 *   bschat-bot's joke module, which isn't part of Music Bot's ported scope
 *   (see `container.ts`'s note about `JokerModule` et al. being dropped).
 * - Dropped the debug-only `/play <file_id>` command - it wasn't part of the
 *   real upload flow and isn't called out by this ticket's acceptance
 *   criteria.
 * - `handleChatSelectAction`'s callback data used to be a hand-rolled
 *   `chat_select_<chatId>` string matched with a regex on the raw update.
 *   This uses `ActionCodec` instead (`chat_select:<chatId>`, matching the
 *   `action:arg1:arg2` convention `RoundOrchestratorService` already
 *   established), matched via grammY's built-in `callbackQuery()` filter.
 * - `handleAudioMessage`/`handleHintMessage` used to go through
 *   `MemberService.saveSubmission`/`getSubmission`/`addMusicHint` - those
 *   methods were music-game-specific and were intentionally left out of
 *   `@bisya/bot-kit`'s ported `MemberService` (see that file's module
 *   comment). `MusicGameRepository.upsertDraftRound` is the ported
 *   equivalent: a single upsert that carries both the track's file id and
 *   (optionally) the hint's chat/message id, keyed on `(gameId, userId)`.
 *   Storing a hint re-sends the round's current `musicFileId` alongside the
 *   new hint fields so the upsert doesn't clobber the track that's already
 *   on file.
 * - The old `handleHintMessage` matched a long list of non-audio message
 *   types (photo, sticker, document, video, ...). This ticket's acceptance
 *   criteria narrows that to text messages only (`':message:text'`), so
 *   that's the only hint path ported here.
 * - The acceptance criteria's `':message:audio'` filter string doesn't match
 *   grammY's filter-query grammar (a leading `:` omits the *update* type,
 *   e.g. `:audio` also matches audio in channel posts; `message:audio` is
 *   the one that means "only `message` updates with `audio`"). Used
 *   `'message:audio'` / `'message:text'` here, since that's what actually
 *   scopes the handlers to private-chat messages the way the rest of this
 *   composer expects.
 * - Every Telegram API call goes through `ctx.api`/`ctx.reply`/
 *   `ctx.answerCallbackQuery` (grammY), never `ctx.telegram` (Telegraf).
 *
 * No new repository/service methods were needed - `getCurrentGameByChatId`,
 * `createEmptyLobby`, and `upsertDraftRound` (all pre-existing on
 * `MusicGameRepository`) are enough to find-or-create the chat's LOBBY game
 * and attach a track/hint to it.
 */
export class UploadComposer extends Composer<BotContext> {
  constructor(
    private readonly memberService: MemberService,
    private readonly text: ITextService,
    private readonly gameRepository: MusicGameRepository,
    private readonly codec: ActionCodec,
  ) {
    super();

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.command('start', this.handleStartCommand.bind(this));
    this.callbackQuery(
      new RegExp(`^${CHAT_SELECT_ACTION}:`),
      this.handleChatSelectAction.bind(this),
    );
    this.on('message:audio', this.handleAudioMessage.bind(this));
    this.on('message:text', this.handleHintMessage.bind(this));
  }

  /** `/start` in a private chat: shows the group selector. */
  private async handleStartCommand(ctx: BotContext, next: NextFunction): Promise<void> {
    if (ctx.chat?.type !== 'private' || !ctx.from) {
      await next();
      return;
    }

    const chats = await this.memberService.getChatsByUserId(ctx.from.id);
    if (chats.length === 0) {
      await ctx.reply(this.text.get('upload.noChats'));
      return;
    }

    const inlineKeyboard = chats.map((chat) => [
      {
        text: chat.title || `Chat ${Number(chat.id)}`,
        callback_data: this.codec.encode(CHAT_SELECT_ACTION, Number(chat.id)),
      },
    ]);

    await ctx.reply(this.text.get('upload.chooseChat'), {
      reply_markup: { inline_keyboard: inlineKeyboard },
    });
  }

  /** Handles a group-selection button press, storing the choice in the session. */
  private async handleChatSelectAction(
    ctx: CallbackDataContext,
    next: NextFunction,
  ): Promise<void> {
    if (ctx.chat?.type !== 'private' || !ctx.from) {
      await next();
      return;
    }

    const decoded = this.codec.decode(ctx.callbackQuery.data);
    const chatId = decoded?.args[0] ? Number(decoded.args[0]) : NaN;
    if (!decoded || Number.isNaN(chatId)) {
      await ctx.answerCallbackQuery();
      await ctx.reply(this.text.get('upload.invalidSelection'));
      return;
    }

    // Confirm the chat is one this user is actually a member of before
    // trusting the callback data.
    const chats = await this.memberService.getChatsByUserId(ctx.from.id);
    const selectedChat = chats.find((chat) => Number(chat.id) === chatId);
    if (!selectedChat) {
      await ctx.answerCallbackQuery();
      await ctx.reply(this.text.get('upload.invalidSelection'));
      return;
    }

    ctx.session.selectedChatId = chatId;
    await ctx.answerCallbackQuery();
    await ctx.reply(this.text.get('upload.chatSelected', { chatId } as never));
  }

  /** Handles an uploaded audio file, storing it against the selected game. */
  private async handleAudioMessage(ctx: AudioMessageContext, next: NextFunction): Promise<void> {
    if (ctx.chat.type !== 'private' || !ctx.from) {
      await next();
      return;
    }

    const groupChatId = ctx.session.selectedChatId;
    if (!groupChatId) {
      await ctx.reply(this.text.get('upload.noChatSelected'));
      return;
    }

    const userId = ctx.from.id;
    const isMember = await this.memberService.existsMember(userId, groupChatId);
    if (!isMember) {
      await ctx.reply(this.text.get('upload.notAMember', { userId, chatId: groupChatId } as never));
      return;
    }

    const game = await this.getOrCreateLobby(groupChatId);
    if (!game) {
      await ctx.reply(this.text.get('upload.gameInProgress'));
      return;
    }

    await this.gameRepository.upsertDraftRound(game.id, {
      userId,
      musicFileId: ctx.message.audio.file_id,
    });

    await ctx.reply(this.text.get('upload.trackSent'));
  }

  /**
   * Handles a text message after a track has been uploaded, associating it
   * as that track's hint (ported `handleHintMessage` logic, narrowed to
   * text messages - see the class doc comment).
   */
  private async handleHintMessage(ctx: TextMessageContext, next: NextFunction): Promise<void> {
    if (ctx.chat.type !== 'private' || !ctx.from) {
      await next();
      return;
    }

    const chatId = ctx.session.selectedChatId;
    if (!chatId) {
      await ctx.reply(this.text.get('upload.noChatSelected'));
      return;
    }

    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    const draftRound = game?.rounds.find(
      (round) => Number(round.userId) === ctx.from!.id && round.phase === MusicRoundPhase.DRAFT,
    );
    if (!game || !draftRound) {
      await ctx.reply(this.text.get('upload.trackNotFound'));
      return;
    }

    await this.gameRepository.upsertDraftRound(game.id, {
      userId: ctx.from.id,
      musicFileId: draftRound.musicFileId,
      hintChatId: ctx.chat.id,
      hintMessageId: ctx.message.message_id,
    });

    await ctx.reply(this.text.get('upload.hintSent'));
  }

  /**
   * Finds the chat's current LOBBY game, creating one if none exists yet.
   * Returns `null` if a game exists but is already `ACTIVE` - tracks can
   * only be added while a game is still in its lobby (matches
   * `MusicGameRepository.upsertDraftRound`'s own "LOBBY games only" check).
   */
  private async getOrCreateLobby(chatId: number): Promise<GameWithData | null> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (game) {
      return game.status === MusicGameStatus.LOBBY ? game : null;
    }
    return this.gameRepository.createEmptyLobby(chatId);
  }
}
