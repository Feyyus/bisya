import { MusicGameStatus } from '@bisya/db';
import { GameConfigInput, MusicGameRepository } from '../repository/music-game.repository';

/**
 * Ported from bschat-bot's `src/modules/musicGame/game-lifecycle.service.ts`.
 *
 * No Telegraf/grammY types here at all - every method takes a plain
 * `chatId: number` instead of `ctx`, so this service is restart-safe and
 * framework-agnostic by construction.
 *
 * The old `MemberService.getSubmissionUsers(chatId)` dependency is gone:
 * that method was music-game-specific (it queried DRAFT rounds, not general
 * chat membership) and was intentionally left out of `@bisya/bot-kit`'s
 * ported `MemberService` for that reason - see the comment atop
 * `packages/bot-kit/src/member/member.service.ts`. `MusicGameRepository`
 * already has the equivalent query (`getDraftSubmissionUsers`), so this
 * service goes straight to the repository instead of taking a `MemberService`
 * dependency it doesn't otherwise need.
 */
export class GameLifecycleService {
  constructor(private readonly gameRepository: MusicGameRepository) {}

  /**
   * Creates a lobby with DRAFT rounds from submissions.
   * Game stays in LOBBY state until explicitly started.
   */
  async createLobby(
    chatId: number,
  ): Promise<'ALREADY_ACTIVE' | 'NO_TRACKS' | { gameId: number; chatId: number } | 'ERROR'> {
    try {
      const activeGame = await this.gameRepository.getCurrentGameByChatId(chatId);
      if (activeGame) return 'ALREADY_ACTIVE';

      const users = await this.gameRepository.getDraftSubmissionUsers(chatId);
      if (!users.length) return 'NO_TRACKS';

      // Find or create LOBBY game
      let game = await this.gameRepository.getCurrentGameByChatId(chatId);
      if (!game || game.status !== MusicGameStatus.LOBBY) {
        game = await this.gameRepository.createEmptyLobby(chatId);
      }
      return { gameId: game.id, chatId: Number(game.chatId) };
    } catch (e) {
      console.error('Error creating lobby:', e);
      return 'ERROR';
    }
  }

  /**
   * Starts a game from LOBBY state.
   * Transitions DRAFT rounds to LIVE and sets game to ACTIVE.
   *
   * B3 fix: `getCurrentGameByChatId` now queries `MusicGame.status` directly (see
   * `MusicGameRepository`), so it returns reliably and the old multi-attempt
   * re-fetch/direct-search/create fallback chain (plus its pile of debug
   * logging) that used to live here is gone. This is now a straight line:
   * check for an ACTIVE game, check for tracks, find or create the LOBBY
   * game, start it.
   */
  async start(
    chatId: number,
  ): Promise<'ALREADY_ACTIVE' | 'NO_TRACKS' | 'NO_LOBBY' | { chatId: number } | 'ERROR'> {
    try {
      const activeGame = await this.gameRepository.getCurrentGameByChatId(chatId);

      if (activeGame && activeGame.status === MusicGameStatus.ACTIVE) {
        return 'ALREADY_ACTIVE';
      }

      const users = await this.gameRepository.getDraftSubmissionUsers(chatId);
      if (!users.length) {
        if (!activeGame || activeGame.status !== MusicGameStatus.LOBBY) {
          return 'NO_LOBBY';
        }
        return 'NO_TRACKS';
      }

      let lobbyGame = activeGame;
      if (!lobbyGame || lobbyGame.status !== MusicGameStatus.LOBBY) {
        lobbyGame = await this.gameRepository.createEmptyLobby(chatId);
      }

      const started = await this.gameRepository.startGameFromLobby(lobbyGame.id);
      return { chatId: Number(started.chatId) };
    } catch (e) {
      console.error('Error starting game:', e);
      return 'ERROR';
    }
  }

  /**
   * Starts a game with config (creates lobby if needed, then starts with config)
   */
  async startWithConfig(
    chatId: number,
    config: GameConfigInput,
  ): Promise<'ALREADY_ACTIVE' | 'NO_TRACKS' | { chatId: number } | 'ERROR'> {
    try {
      const activeGame = await this.gameRepository.getCurrentGameByChatId(chatId);

      if (activeGame && activeGame.status === MusicGameStatus.ACTIVE) {
        return 'ALREADY_ACTIVE';
      }

      if (activeGame && activeGame.status === MusicGameStatus.LOBBY) {
        const started = await this.gameRepository.startGameFromLobby(activeGame.id, config);
        return { chatId: Number(started.chatId) };
      }

      const users = await this.gameRepository.getDraftSubmissionUsers(chatId);
      if (!users.length) return 'NO_TRACKS';

      let lobby = await this.gameRepository.getCurrentGameByChatId(chatId);
      if (!lobby || lobby.status !== MusicGameStatus.LOBBY) {
        lobby = await this.gameRepository.createEmptyLobby(chatId);
      }

      const started = await this.gameRepository.startGameFromLobby(lobby.id, config);
      return { chatId: Number(started.chatId) };
    } catch (e) {
      console.error('Error starting game with config:', e);
      return 'ERROR';
    }
  }

  async end(chatId: number): Promise<'NO_ACTIVE' | 'ENDED'> {
    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) return 'NO_ACTIVE';
    await this.gameRepository.endGame(game.id);
    return 'ENDED';
  }
}
