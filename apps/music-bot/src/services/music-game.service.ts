import type { ITextService, MemberService } from '@bisya/bot-kit';
import { GameStatus, RoundPhase, ScoringPreset, User } from '@bisya/db';
import { Api } from 'grammy';
import type { InlineKeyboardButton } from 'grammy/types';
import { BotContext } from '../context';
import {
  GameConfigInput,
  GameWithData,
  MusicGameRepository,
  RoundWithGuesses,
} from '../repository/music-game.repository';
import { GameLifecycleService } from './game-lifecycle.service';
import { GuessService } from './guess.service';
import { RoundOrchestratorService } from './round-orchestrator.service';

/**
 * TODO(GameConfig): bschat-bot's `GameConfig` was a zod schema
 * (`src/modules/musicGame/config/game-config.ts`) with parsed defaults and a
 * `gameConfigToPrisma` converter. That module hasn't been ported into
 * music-bot yet - same gap `MusicGameRepository.GameConfigInput` already
 * flags. `MusicGameConfig`/`defaultGameConfig` below are a plain,
 * non-validating stand-in with the same shape and defaults as the old zod
 * schema; swap them for the real thing once that module lands.
 */
type MusicGameConfig = Required<GameConfigInput>;

const defaultGameConfig: MusicGameConfig = {
  hintDelaySec: 30,
  autoAdvance: false,
  advanceDelaySec: 60,
  allowSelfGuess: false,
  shuffle: true,
  scoringPreset: ScoringPreset.classic,
};

/**
 * MusicGameService - Single service handling the entire music guessing game
 *
 * This service consolidates all game logic into one place, eliminating
 * the complexity of multiple fragmented services and circular dependencies.
 *
 * Responsibilities:
 * - Complete game lifecycle management
 * - Round progression and management
 * - Player interaction and scoring
 * - Game state and configuration
 * - UI rendering and user feedback
 *
 * Ported from bschat-bot's `src/modules/musicGame/music-game.service.ts`.
 * Dropped two constructor dependencies that turned out to be unused in the
 * method bodies once ported:
 * - `SchedulerService` - never referenced (`this.scheduler` had zero call
 *   sites in the old file beyond the constructor).
 * - `ActionCodec` - its only call site was the private `playRound` method
 *   below, which was itself dead code (see the note on `roundControls`).
 *
 * Also dropped the private `playRound(ctx, participants, currentRound)`
 * method entirely: it duplicated `RoundOrchestratorService.playRound` with
 * near-identical logic, but nothing in the old codebase ever called it - the
 * real round-start path always went through `roundOrchestrator.playRound`
 * instead. Porting known-dead code forward just to keep a 1:1 line count
 * didn't seem worth it; `roundOrchestrator.playRound` is the one real
 * implementation.
 */
export class MusicGameService {
  constructor(
    private readonly gameRepository: MusicGameRepository,
    private readonly text: ITextService,
    private readonly memberService: MemberService,
    private readonly guessService: GuessService,
    private readonly roundOrchestrator: RoundOrchestratorService,
    private readonly lifecycle: GameLifecycleService,
  ) {}

  // ==================== GAME LIFECYCLE ====================

  /**
   * Sets up a new music guessing game instance
   */
  async initiateGameSetup(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;

    await ctx.reply(this.text.get('musicGame.welcome'), {
      reply_markup: {
        inline_keyboard: [[{ text: 'Начать игру', callback_data: 'game:start' }]],
      },
    });

    // Notify all participants in the current chat
    const users = await this.gameRepository.getDraftSubmissionUsers(ctx.chat.id);
    this.memberService.formatPingNames(users).forEach((batch) => {
      ctx.reply(batch, {
        parse_mode: 'Markdown',
      });
    });
  }

  /**
   * Starts a new game if none exists or continues the current one
   */
  async startGame(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    const result = await this.lifecycle.start(ctx.chat.id);
    if (result === 'ALREADY_ACTIVE') {
      await ctx.reply(this.text.get('musicGame.activeExists'));
      return;
    }
    if (result === 'NO_TRACKS') {
      await ctx.reply(this.text.get('musicGame.noTracks'));
      return;
    }
    if (result === 'NO_LOBBY') {
      await ctx.reply('No lobby exists. Tracks will create one automatically when uploaded.');
      return;
    }
    if (result === 'ERROR') {
      await ctx.reply(this.text.get('musicGame.startError'));
      return;
    }
    await ctx.reply(this.text.get('musicGame.gameStarted'));
    await this.startRound(result.chatId, ctx.api);
  }

  /**
   * Starts a game using a provided config (from lobby)
   */
  async startGameWithConfig(ctx: BotContext, config: GameConfigInput): Promise<void> {
    if (!ctx.chat) return;
    const result = await this.lifecycle.startWithConfig(ctx.chat.id, config);
    if (result === 'ALREADY_ACTIVE') {
      await ctx.reply(this.text.get('musicGame.activeExists'));
      return;
    }
    if (result === 'NO_TRACKS') {
      await ctx.reply(this.text.get('musicGame.noTracks'));
      return;
    }
    if (result === 'ERROR') {
      await ctx.reply(this.text.get('musicGame.startError'));
      return;
    }
    await ctx.reply(this.text.get('musicGame.gameStarted'));
    await this.startRound(result.chatId, ctx.api);
  }

  /**
   * Ends the current active game
   */
  async endGame(chatId: number, api: Api): Promise<void> {
    const result = await this.lifecycle.end(chatId);
    if (result === 'NO_ACTIVE') {
      await api.sendMessage(chatId, this.text.get('musicGame.noActive'));
      return;
    }
    await api.sendMessage(chatId, this.text.get('musicGame.ended'));
  }

  // ==================== ROUND MANAGEMENT ====================

  /**
   * Starts a new round for the current game.
   *
   * This is the method the acceptance criteria calls out directly: it used
   * to delegate to `roundOrchestrator.startRound(ctx, chatId)`; now that
   * `RoundOrchestratorService` takes `(chatId, api)` instead of `ctx` (see
   * that file for the full B2 writeup), this passes `chatId` and `api`
   * through instead.
   */
  async startRound(chatId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      await api.sendMessage(chatId, this.text.get('musicGame.noGame'));
      return;
    }
    const hasRound = await this.gameRepository.getRoundBySequence(game.id, game.currentSequence);
    if (!hasRound) {
      await this.handleGameEnd(chatId, api);
      return;
    }
    await this.roundOrchestrator.startRound(chatId, api);
  }

  /**
   * Processes a player's guess
   */
  async processGuess(ctx: BotContext, roundId: number, guessedUserId: number): Promise<void> {
    if (!ctx.chat) return;

    try {
      const guessingUserId = ctx.from!.id;
      // Only pass guessedUserId if it's a valid number
      const guessParams: {
        chatId: number;
        roundId: number;
        guessingUserId: number;
        guessedUserId?: number;
      } = {
        chatId: ctx.chat.id,
        roundId,
        guessingUserId,
      };
      if (guessedUserId && !isNaN(guessedUserId)) {
        guessParams.guessedUserId = guessedUserId;
      }
      const result = await this.guessService.processGuess(guessParams);

      if (result === 'NO_ROUND') {
        await ctx.reply(this.text.get('rounds.notFound'));
        return;
      }
      if (result === 'NO_GAME') {
        await ctx.reply(this.text.get('musicGame.notFound'));
        return;
      }
      if (result === 'ALREADY_GUESSED') {
        await ctx.answerCallbackQuery(this.text.get('guessing.alreadyGuessed'));
        return;
      }
      if (result === 'ROUND_NOT_LIVE') {
        await ctx.answerCallbackQuery('This round is not active');
        return;
      }
      if (result === 'GAME_NOT_ACTIVE') {
        await ctx.answerCallbackQuery('Game is not active');
        return;
      }

      // Update round info
      await this.updateRoundInfo(ctx, roundId);

      await ctx.answerCallbackQuery(
        result.isCorrect
          ? this.text.get('guessing.correctGuess', { points: result.points })
          : this.text.get('guessing.wrongGuess'),
      );
    } catch (error) {
      console.error('Error processing guess:', error);
      await ctx.answerCallbackQuery(this.text.get('guessing.error'));
    }
  }

  /**
   * Shows a hint for the current round
   */
  async showHint(chatId: number, api: Api): Promise<void> {
    await this.roundOrchestrator.showHint(chatId, api);
  }

  /**
   * Advances to the next round
   */
  async advanceToNextRound(chatId: number, gameId: number, api: Api): Promise<void> {
    await this.roundOrchestrator.advanceToNextRound(chatId, gameId, api);
  }

  /**
   * Replays the current round's music
   */
  async replayCurrentRound(chatId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      await api.sendMessage(chatId, this.text.get('musicGame.noGame'));
      return;
    }

    const round = await this.gameRepository.getRoundBySequence(game.id, game.currentSequence);
    if (!round) {
      await api.sendMessage(chatId, this.text.get('rounds.noRound'));
      return;
    }

    const participants = await this.gameRepository.getParticipants(game.id);
    await this.roundOrchestrator.playRound(chatId, api, participants, round);
  }

  /**
   * Skips the current round and advances to the next
   */
  async skipCurrentRound(chatId: number, api: Api): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      await api.sendMessage(chatId, this.text.get('musicGame.noGame'));
      return;
    }

    await api.sendMessage(chatId, this.text.get('rounds.skipped'));
    await this.advanceToNextRound(chatId, game.id, api);
  }

  /**
   * Reveals the answer for the current round
   */
  async revealCurrentRound(chatId: number, api: Api): Promise<void> {
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

    const participants = await this.gameRepository.getParticipants(game.id);
    const correctUser = participants.find((u) => u.id === round.userId);
    await api.sendMessage(
      chatId,
      this.text.get('rounds.reveal', { player: correctUser?.name || 'Unknown' } as any),
    );
  }

  // ==================== GAME STATE & INFO ====================

  /**
   * Lists all games for the current chat
   */
  async listGames(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    const games = await this.gameRepository.getGamesOfChat(ctx.chat.id);

    if (!games.length) {
      await ctx.reply(this.text.get('musicGame.noSaved'));
      return;
    }

    const gamesList = games
      .map((game) => {
        return `ID: ${game.id} | Создана: ${game.createdAt.toLocaleDateString()} | Статус: ${this.formatGameStatus(game.status)}`;
      })
      .join('\n');

    await ctx.reply(this.text.get('musicGame.savedList', { gamesList } as any));
  }

  /**
   * Shows information about the current active game
   */
  async showActiveGameInfo(ctx: BotContext): Promise<void> {
    if (!ctx.chat) {
      await ctx.reply(this.text.get('chat.notFound'));
      return;
    }
    const game = await this.gameRepository.getCurrentGameByChatId(ctx.chat.id);

    if (!game) {
      await ctx.reply(this.text.get('musicGame.activeNotFound', { chatId: ctx.chat.id } as any));
      return;
    }

    const gameInfo = [
      `Информация об игре:`,
      `ID: ${game.id}`,
      `Создана: ${game.createdAt.toLocaleDateString()}`,
      `Статус: ${this.formatGameStatus(game.status)}`,
      `Текущий раунд: ${game.currentSequence + 1}`,
      `Всего раундов: ${game.rounds.length}`,
    ];

    await ctx.reply(this.text.get('musicGame.activeInfo', { info: gameInfo.join('\n') } as any));
  }

  /**
   * Gets the current game state
   */
  async getGameState(chatId: number) {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) return null;

    const currentRound = game.rounds.find((r) => r.sequence === game.currentSequence);
    const participants = await this.gameRepository.getParticipants(game.id);

    return {
      gameId: game.id,
      currentRound: game.currentSequence,
      totalRounds: game.rounds.length,
      status: game.status,
      participants: participants.length,
      currentRoundData: currentRound,
    };
  }

  /**
   * List all players in the current game
   */
  async listPlayers(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    const submissionUsers = await this.gameRepository.getDraftSubmissionUsers(ctx.chat.id);

    if (!submissionUsers.length) {
      await ctx.reply(this.text.get('musicGame.noPlayers'));
      return;
    }

    const users = this.memberService.formatPingNames(submissionUsers).join('\n');

    await ctx.reply(
      this.text.get('musicGame.listPlayers', {
        playersCount: submissionUsers.length,
        playersList: users,
      }),
      {
        parse_mode: 'Markdown',
        disable_notification: true,
      },
    );
  }

  /**
   * Get submission players for chat
   */
  async getSubmissionPlayers(chatId: number): Promise<User[]> {
    return this.gameRepository.getDraftSubmissionUsers(chatId);
  }

  /**
   * Remove player's track from the game
   */
  async removePlayerTrack(
    chatId: number,
    userId: number,
  ): Promise<'NO_GAME' | 'NO_TRACK' | 'SUCCESS'> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      return 'NO_GAME';
    }

    // Check if player has a DRAFT round
    const draftRound = game.rounds.find(
      (round) => Number(round.userId) === userId && round.phase === RoundPhase.DRAFT,
    );

    if (!draftRound) {
      return 'NO_TRACK';
    }

    await this.gameRepository.deleteDraftRound(game.id, userId);
    return 'SUCCESS';
  }

  /**
   * Ping all players in the current game
   */
  async pingPlayers(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;

    const users = await this.gameRepository.getDraftSubmissionUsers(ctx.chat.id);

    if (!users.length) {
      await ctx.reply(this.text.get('musicGame.noPlayers'));
      return;
    }

    this.memberService.formatPingNames(users).forEach((batch) => {
      ctx.reply(batch, {
        parse_mode: 'Markdown',
        disable_notification: false,
      });
    });
  }

  /**
   * Get game statistics
   */
  async getGameStats(ctx: BotContext): Promise<void> {
    if (!ctx.chat) return;
    const game = await this.gameRepository.getCurrentGameByChatId(ctx.chat.id);
    if (!game) {
      await ctx.reply(this.text.get('musicGame.noActive'));
      return;
    }

    const userStats = await this.calculateUserStats(game.id);
    const trackDifficulty = await this.calculateTrackDifficulty(game.id);

    const statsText = [
      '📊 Статистика игры:',
      `🎯 Текущий раунд: ${game.currentSequence + 1}/${game.rounds.length}`,
      `👥 Участников: ${userStats.size}`,
      '',
      '🏆 Топ игроков:',
      ...Array.from(userStats.entries())
        .sort(([, a], [, b]) => b.totalPoints - a.totalPoints)
        .slice(0, 3)
        .map(
          ([, stats], index) =>
            `${index + 1}. ${stats.totalPoints} очков (🎯 ${stats.correct}, ❌ ${stats.incorrect})`,
        ),
      '',
      '🎵 Сложность треков:',
      ...trackDifficulty
        .sort((a, b) => b.correctGuesses - a.correctGuesses)
        .slice(0, 3)
        .map((item) => `${item.player}: ${item.correctGuesses} угадано`),
    ].join('\n');

    await ctx.reply(this.text.get('musicGame.stats', { stats: statsText }));
  }

  // ==================== GAME CONFIG MANAGEMENT ====================

  /**
   * Get current game for chat (LOBBY or ACTIVE)
   */
  async getCurrentGame(chatId: number): Promise<GameWithData | null> {
    return this.gameRepository.getCurrentGameByChatId(chatId);
  }

  /**
   * Get game config from game object
   */
  getGameConfig(game: Awaited<ReturnType<typeof this.getCurrentGame>>): MusicGameConfig {
    if (!game) {
      return defaultGameConfig;
    }
    return {
      hintDelaySec: game.hintDelaySec,
      autoAdvance: game.autoAdvance,
      advanceDelaySec: game.advanceDelaySec,
      allowSelfGuess: game.allowSelfGuess,
      shuffle: game.shuffle,
      scoringPreset: game.scoringPreset,
    };
  }

  /**
   * Update game config
   */
  async updateGameConfig(chatId: number, config: MusicGameConfig): Promise<void> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      throw new Error('Game not found');
    }
    await this.gameRepository.updateGameConfig(game.id, { config });
  }

  /**
   * Create a LOBBY game for settings (even without tracks)
   */
  async createLobbyForSettings(chatId: number): Promise<boolean> {
    try {
      const existingGame = await this.gameRepository.getCurrentGameByChatId(chatId);
      if (existingGame) {
        return true; // Game already exists
      }
      await this.gameRepository.createEmptyLobby(chatId);
      return true;
    } catch (error) {
      console.error('Error creating lobby for settings:', error);
      return false;
    }
  }

  // ==================== PRIVATE HELPER METHODS ====================

  private async handleGameEnd(chatId: number, api: Api): Promise<void> {
    await api.sendMessage(chatId, this.text.get('rounds.noMoreRounds'));
    await this.showLeaderboard(chatId, api);
    await this.endGame(chatId, api);
  }

  private async updateRoundInfo(ctx: BotContext, roundId: number): Promise<void> {
    const round = await this.gameRepository.findRoundById(roundId);
    if (!round) return;

    await this.sendRoundInfo(ctx, roundId);
  }

  private async sendRoundInfo(ctx: BotContext, roundId: number): Promise<void> {
    const round = await this.gameRepository.findRoundById(roundId);
    if (!round) {
      await ctx.reply(this.text.get('rounds.notFound'));
      return;
    }

    const info = await this.formatRoundInfo(round);

    if (round.infoMessageId) {
      try {
        await ctx.api.editMessageText(round.game.chatId.toString(), Number(round.infoMessageId), info, {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: this.roundControls(round.id) },
        });
      } catch (error) {
        console.error('Failed to edit message, sending new one:', error);
        await this.sendNewRoundInfo(ctx, round, info);
      }
    } else {
      await this.sendNewRoundInfo(ctx, round, info);
    }
  }

  private async sendNewRoundInfo(
    ctx: BotContext,
    round: RoundWithGuesses,
    info: string,
  ): Promise<void> {
    const message = await ctx.reply(info, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: this.roundControls(round.id) },
    });
    await this.gameRepository.updateRoundMessageInfo(round.id, message.message_id);
  }

  private async formatRoundInfo(round: RoundWithGuesses): Promise<string> {
    const notYetGuessed = await this.gameRepository.getUsersNotGuessed(round.id);

    return `
      🎯 Раунд ${round.sequence + 1} - продолжаем веселиться!
      ${round.hintShownAt ? '💡 Подсказка была показана (для особо одарённых)' : ''}

      ${this.text.get('rounds.roundInfo.thinking')}: ${notYetGuessed.map((u) => u.name).join(', ')}

      ${this.text.get('rounds.roundInfo.correct')}: ${
        round.guesses
          .filter((g) => g.guessedId === round.userId)
          .map((g) => `${g.user.name} (${g.points} ${this.getPointsWord(g.points)})`)
          .join(', ') || 'Пока никто! Неужели так сложно?'
      }

      ${this.text.get('rounds.roundInfo.wrong')}: ${
        round.guesses
          .filter((g) => g.guessedId !== round.userId)
          .map((g) => g.user.name)
          .join(', ') || 'Пока никто не ошибся. Но это ненадолго!'
      }
    `;
  }

  private async showLeaderboard(chatId: number, api: Api): Promise<void> {
    const leaderboard = await this.generateLeaderboard(chatId);
    if (!leaderboard) {
      await api.sendMessage(chatId, this.text.get('leaderboard.error'));
      return;
    }
    await api.sendMessage(chatId, leaderboard);
  }

  private async generateLeaderboard(chatId: number): Promise<string | null> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) {
      return null;
    }

    const userStats = await this.calculateUserStats(game.id);

    const getUserByIdMap = new Map<number, User>();
    for (const round of game.rounds) {
      getUserByIdMap.set(Number(round.userId), round.user);
    }

    const sortedLeaderboard = [...userStats.entries()]
      .sort(([, a], [, b]) => b.totalPoints - a.totalPoints)
      .map(
        ([userId, stats], index) =>
          `${index + 1}. ${getUserByIdMap.get(userId)?.name || 'Unknown'} — 🏆 ${
            stats.totalPoints
          } очков (🎯 ${stats.correct} угадано, ❌ ${stats.incorrect} не угадано)`,
      );

    const trackDifficulty = await this.calculateTrackDifficulty(game.id);
    const sortedTrackDifficulty = trackDifficulty
      .sort((a, b) => b.correctGuesses - a.correctGuesses)
      .map((item) => `${item.index + 1}. ${item.player} — 🎯 ${item.correctGuesses}`);

    const mostPoints = sortedLeaderboard.join('\n');

    return [
      this.text.get('leaderboard.mostPoints'),
      mostPoints,
      this.text.get('leaderboard.leastGuessed'),
      sortedTrackDifficulty.join('\n'),
    ].join('\n\n');
  }

  private formatGameStatus(status: GameStatus): string {
    switch (status) {
      case GameStatus.ACTIVE:
        return 'Активная';
      case GameStatus.LOBBY:
        return 'В лобби';
      case GameStatus.ENDED:
        return 'Завершена';
      default:
        return 'Неизвестно';
    }
  }

  private async calculateUserStats(gameId: number) {
    const game = await this.gameRepository.getGameById(gameId);
    if (!game) throw new Error('Game not found');

    const userStats = new Map<
      number,
      {
        correct: number;
        incorrect: number;
        totalPoints: number;
      }
    >();

    for (const round of game.rounds) {
      for (const guess of round.guesses) {
        const stats = userStats.get(Number(guess.userId)) || {
          correct: 0,
          incorrect: 0,
          totalPoints: 0,
        };
        stats.totalPoints += guess.points;
        if (round.userId === guess.guessedId) {
          stats.correct++;
        } else {
          stats.incorrect++;
        }
        userStats.set(Number(guess.userId), stats);
      }
    }

    return userStats;
  }

  private async calculateTrackDifficulty(gameId: number) {
    const game = await this.gameRepository.getGameById(gameId);
    if (!game) throw new Error('Game not found');

    return game.rounds.map((round) => {
      const correctGuesses = round.guesses.filter((g) => g.guessedId === round.userId).length;
      return {
        player: round.user.name || 'Unknown',
        correctGuesses,
        index: round.sequence,
      };
    });
  }

  private getPointsWord(points: number): string {
    if (points === 1) return 'очко';
    if (points >= 2 && points <= 4) return 'очка';
    return 'очков';
  }

  /**
   * TODO(GameplayUi): stand-in for bschat-bot's `GameplayUi.roundControls`
   * (`features/gameplay/gameplay.ui.ts`), which hasn't been ported as its own
   * module in this monorepo yet. Inlined here since this file is currently
   * the only caller; pull it out into a shared UI module if/when a second
   * caller needs it.
   */
  private roundControls(roundId: number): InlineKeyboardButton[][] {
    return [
      [
        { text: '💡 Hint Now', callback_data: `round_hint:${roundId}` },
        { text: '🔁 Replay', callback_data: `round_replay:${roundId}` },
      ],
      [
        { text: '⏭️ Skip', callback_data: `round_skip:${roundId}` },
        { text: '🏁 Reveal', callback_data: `round_reveal:${roundId}` },
      ],
    ];
  }

  // ==================== HELP COMMANDS ====================

  /**
   * Show help for players
   */
  async showPlayerHelp(ctx: BotContext): Promise<void> {
    const helpText = `🎵 <b>Музыкальная игра - Помощь для игроков</b>

<b>Как играть:</b>
1. Отправьте аудиофайл в чат, чтобы добавить свой трек в игру
2. Дождитесь начала игры (организатор запустит её командой /music_start)
3. Когда начнётся раунд, вы услышите трек и увидите список игроков
4. Нажмите на имя игрока, чей трек, по вашему мнению, сейчас играет
5. За правильный ответ вы получите очки, за неправильный - потеряете

<b>Подсказки:</b>
• Вы можете сохранить подсказку для каждого раунда (кнопка "💡 Сохранить подсказку")
• Подсказка будет показана автоматически через некоторое время
• Использование подсказки уменьшает ваши очки за правильный ответ

<b>Очки:</b>
• Правильный ответ без подсказки: +5 очков
• Правильный ответ с подсказкой: +3 очка
• Неправильный ответ: -2 очка

<b>Команды:</b>
• /music_info - информация о текущей игре
• /music_stats - статистика игры
• /music_players - список игроков
• /music_ping - уведомить всех игроков

<b>Советы:</b>
• Внимательно слушайте треки - иногда подсказки могут быть обманчивыми
• Не спешите с ответом, но и не затягивайте - время ограничено
• Играйте честно и получайте удовольствие! 🎶`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  }

  /**
   * Show help for organizers
   */
  async showOrganizerHelp(ctx: BotContext): Promise<void> {
    const helpText = `🎮 <b>Музыкальная игра - Помощь для организаторов</b>

<b>Настройка игры:</b>
1. Попросите игроков отправить аудиофайлы в чат
2. Используйте /music_lobby для управления лобби
3. В лобби вы можете настроить параметры игры:
   • ⏱️ Задержка подсказки (30s, 1min, 1.5min, 2min)
   • ⏭️ Автоматический переход к следующему раунду
   • ⏱️ Задержка перед переходом (1-5 минут)
   • 🔀 Перемешивание треков
   • 🎯 Пресет подсчёта очков (classic, aggressive, gentle)
   • 👤 Разрешить угадывание своего трека

<b>Управление игрой:</b>
• /music_start - начать игру
• /music_end - завершить игру досрочно
• /music_lobby - открыть панель управления лобби
• /music_info - информация о текущей игре
• /music_stats - статистика игры
• /music_players - список игроков и управление ими
• /music_ping - уведомить всех игроков

<b>Панель игроков:</b>
• Просмотр всех участников
• Удаление игроков из игры
• Отправка уведомлений конкретным игрокам

<b>Панель настроек:</b>
• Все настройки можно изменить до начала игры
• После начала игры настройки фиксируются

<b>Советы:</b>
• Убедитесь, что все треки загружены перед началом
• Проверьте настройки перед запуском
• Используйте /music_ping для привлечения внимания игроков
• Следите за прогрессом через /music_stats`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  }

  /**
   * Show help for developers
   */
  async showDeveloperHelp(ctx: BotContext): Promise<void> {
    const helpText = `🔧 <b>Музыкальная игра - Техническая документация</b>

<b>Архитектура:</b>
• Плоская структура сервисов, без DI-фреймворка (см. bschat-bot's Inversify
  setup для сравнения) - каждый сервис получает зависимости через конструктор
• Prisma ORM (пакет @bisya/db) для работы с базой данных
• grammY для Telegram Bot API

<b>Основные компоненты:</b>
• <code>MusicGameService</code> - основной сервис игры
• <code>MusicGameRepository</code> - работа с БД
• <code>GameLifecycleService</code> - жизненный цикл игры
• <code>RoundOrchestratorService</code> - управление раундами
• <code>GuessService</code> - обработка догадок и подсчёт очков
• <code>SchedulerService</code> (@bisya/scheduler) - планирование задач (подсказки, переходы)

<b>Состояния игры:</b>
• <code>LOBBY</code> - ожидание начала, настройка
• <code>ACTIVE</code> - игра идёт
• <code>ENDED</code> - игра завершена

<b>Фазы раунда:</b>
• <code>DRAFT</code> - трек загружен, но раунд не начат
• <code>LIVE</code> - раунд активен, принимаются догадки
• <code>COMPLETED</code> - раунд завершён

<b>База данных:</b>
• <code>Game</code> - игра (статус, настройки, чат)
• <code>GameRound</code> - раунд (трек, игрок, фаза)
• <code>Guess</code> - догадка (игрок, угаданный игрок, очки)
• <code>ChatMembership</code> - участники чата

<b>Настройки игры:</b>
• <code>hintDelaySec</code> - задержка перед показом подсказки
• <code>autoAdvance</code> - автоматический переход к следующему раунду
• <code>advanceDelaySec</code> - задержка перед переходом
• <code>allowSelfGuess</code> - разрешить угадывание своего трека
• <code>shuffle</code> - перемешивать треки
• <code>scoringPreset</code> - пресет подсчёта очков

<b>Подсчёт очков:</b>
• Правильный ответ без подсказки: +5
• Правильный ответ с подсказкой: +3
• Неправильный ответ: -2
• Пресеты могут изменять эти значения

<b>Callback Data:</b>
• Используется <code>ActionCodec</code> для кодирования/декодирования
• Формат: <code>action:param1:param2:...</code>
• Примеры: <code>guess:roundId:userId</code>

<b>Планировщик:</b>
• Используется <code>SchedulerService</code> для отложенных задач
• Подсказки показываются через <code>hintDelaySec</code>
• Автопереход происходит через <code>advanceDelaySec</code>`;

    await ctx.reply(helpText, { parse_mode: 'HTML' });
  }
}
