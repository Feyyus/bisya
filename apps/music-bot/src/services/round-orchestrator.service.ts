import type { ITextService } from '@bisya/bot-kit';
import { SchedulerService } from '@bisya/scheduler';
import { User } from '@bisya/db';
import { Api } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { ActionCodec } from '../codec/action.codec';
import { MusicGameRepository, RoundWithGuesses } from '../repository/music-game.repository';

/** Scheduler queues this service registers handlers for. */
const HINT_QUEUE = 'music-game:hint';
const ADVANCE_QUEUE = 'music-game:advance';

interface HintJobData {
  roundId: number;
  chatId: number;
}

interface AdvanceJobData {
  gameId: number;
  chatId: number;
}

/**
 * Ported from bschat-bot's `src/modules/musicGame/round-orchestrator.service.ts`.
 *
 * B2 fix (ctx-removal half): every method that used to take a Telegraf
 * `Context` now takes `chatId: number, api: Api` instead. `ctx.reply(...)`
 * becomes `api.sendMessage(chatId, ...)`, `ctx.telegram.copyMessage(...)`
 * becomes `api.copyMessage(...)`, `ctx.replyWithAudio(...)` becomes
 * `api.sendAudio(chatId, ...)`.
 *
 * Scheduler callbacks used to close over the `ctx` of whichever update
 * triggered `startRound` - fine in-process, fatal across a restart, since a
 * `setTimeout` firing after redeploy would call methods on a `ctx` object
 * that no longer corresponds to anything live. Jobs are now scheduled with
 * plain serializable data (`{ roundId, chatId }` / `{ gameId, chatId }`) via
 * `SchedulerService.scheduleOnce`, and `registerSchedulerHandlers(api)` wires
 * up the handlers that receive that data back. `api` (grammY's bot API
 * client) is safe to close over here, unlike `ctx` - it's a single long-lived
 * object for the whole bot process, not scoped to one incoming update.
 * `registerSchedulerHandlers` must be called once at bot startup before any
 * round can schedule a hint/advance job.
 */
export class RoundOrchestratorService {
  constructor(
    private readonly gameRepository: MusicGameRepository,
    private readonly scheduler: SchedulerService,
    private readonly text: ITextService,
    private readonly codec: ActionCodec,
  ) {}

  /**
   * Binds this service's scheduler handlers to `api`. Call once at bot
   * startup.
   */
  registerSchedulerHandlers(api: Api): void {
    this.scheduler.registerHandler(HINT_QUEUE, (data) => {
      const { roundId, chatId } = data as HintJobData;
      void this.showHintById(roundId, chatId, api);
    });

    this.scheduler.registerHandler(ADVANCE_QUEUE, (data) => {
      const { gameId, chatId } = data as AdvanceJobData;
      void this.advanceToNextRound(chatId, gameId, api);
    });
  }

  async startRound(chatId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      await api.sendMessage(chatId, this.text.get('musicGame.noGame'));
      return;
    }

    const round = await this.gameRepository.getRoundBySequence(game.id, game.currentSequence);
    if (!round) {
      await api.sendMessage(chatId, this.text.get('rounds.noMoreRounds'));
      return;
    }

    // B1 fix (orchestrator side): this is the one reliable place a round
    // transitions to LIVE with `startedAt` set, so scoring's time-elapsed
    // calculation (see GuessService) always has a real value to work from.
    // Set before sending the round's audio so `startedAt` reflects when the
    // round actually became guessable, not when the audio finished sending.
    await this.gameRepository.setRoundLive(round.id);

    const participants = await this.gameRepository.getParticipants(game.id);
    await this.playRound(chatId, api, participants, round);

    try {
      if (game.hintDelaySec) {
        const hintKey = `hint:${round.id}`;
        this.scheduler.scheduleOnce(
          hintKey,
          new Date(Date.now() + game.hintDelaySec * 1000),
          HINT_QUEUE,
          { roundId: round.id, chatId } satisfies HintJobData,
        );
      }

      if (game.autoAdvance && game.advanceDelaySec) {
        const advanceKey = `advance:${round.id}`;
        this.scheduler.scheduleOnce(
          advanceKey,
          new Date(Date.now() + game.advanceDelaySec * 1000),
          ADVANCE_QUEUE,
          { gameId: game.id, chatId } satisfies AdvanceJobData,
        );
      }
    } catch (error) {
      console.error('Failed to schedule round events:', error);
    }
  }

  async playRound(
    chatId: number,
    api: Api,
    participants: User[],
    currentRound: RoundWithGuesses,
  ): Promise<void> {
    // Ensure roundId and userId are valid numbers before encoding
    const roundId =
      typeof currentRound.id === 'bigint' ? Number(currentRound.id) : currentRound.id;
    if (!roundId || isNaN(roundId)) {
      console.error('Invalid roundId in playRound:', currentRound.id);
      throw new Error('Invalid roundId');
    }
    const buttons = participants.map((user) => {
      const userId = typeof user.id === 'bigint' ? Number(user.id) : user.id;
      if (!userId || isNaN(userId)) {
        console.error('Invalid userId in playRound:', user.id);
        throw new Error('Invalid userId');
      }
      return {
        text: user.name,
        callback_data: this.codec.encode('guess', roundId, userId),
      };
    });

    await api.sendAudio(chatId, currentRound.musicFileId, {
      caption: this.text.get('rounds.playRound'),
      reply_markup: { inline_keyboard: this.chunkButtons(buttons, 3) },
    });
  }

  /**
   * Looks up the current round for `chatId` and shows its hint. Used by the
   * "hint now" control path, where the caller only knows the chat, not the
   * round id.
   */
  async showHint(chatId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      await api.sendMessage(chatId, this.text.get('musicGame.noGame'));
      return;
    }
    const round = game.rounds.find((r) => r.sequence === game.currentSequence);
    if (!round) {
      await api.sendMessage(chatId, this.text.get('rounds.noCurrentRound'));
      return;
    }
    await this.showHintById(round.id, chatId, api);
  }

  /**
   * Shows the hint for a known round id. This is the entry point the
   * scheduler's hint-queue handler calls - it's keyed by `roundId` (captured
   * in the job data at schedule time) rather than re-deriving "the current
   * round" from `chatId`, so it stays correct even if the game has already
   * advanced past that round by the time the timer fires.
   */
  async showHintById(roundId: number, chatId: number, api: Api): Promise<void> {
    const round = await this.gameRepository.getRoundByDatabaseId(roundId);
    if (!round) return;

    if (round.hintShownAt) {
      await api.sendMessage(chatId, this.text.get('hints.hintAlreadyShown'));
      return;
    }
    await this.gameRepository.showHint(round.id);

    if (round.hintChatId && round.hintMessageId) {
      try {
        await api.copyMessage(chatId, Number(round.hintChatId), Number(round.hintMessageId));
      } catch (error) {
        console.error('Failed to copy hint message:', error);
        await api.sendMessage(chatId, this.text.get('hints.hintLayout'));
      }
      return;
    }
    await api.sendMessage(chatId, this.text.get('hints.hintLayout'));
  }

  async advanceToNextRound(chatId: number, gameId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getGameById(gameId);
    if (!game) return;
    await api.sendMessage(chatId, this.text.get('rounds.nextRound'));
    await this.gameRepository.updateGameRound(gameId, game.currentSequence + 1);
    await this.startRound(chatId, api);
  }

  private chunkButtons(buttons: InlineKeyboardButton[], size: number) {
    return Array.from({ length: Math.ceil(buttons.length / size) }, (_, i) =>
      buttons.slice(i * size, i * size + size),
    );
  }
}
