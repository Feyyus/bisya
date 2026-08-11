import { MusicGameStatus, MusicRoundPhase } from '@bisya/db';
import { MusicGameRepository } from '../repository/music-game.repository';
import { ScoringStrategy, scoringByPreset } from './scoring';

/**
 * Ported from bschat-bot's `src/modules/musicGame/guess.service.ts`.
 *
 * Framework-agnostic by construction: no Telegraf/grammY imports, no
 * captured `ctx` - callers pass plain `chatId`/user ids and get back a
 * result they can render however they like.
 *
 * B1 fix: the old time-elapsed calculation used `round.createdAt` (when the
 * DRAFT round row was created, unrelated to when the round actually went
 * LIVE). It now uses `round.startedAt`, which `MusicGameRepository.setRoundLive`
 * guarantees gets set at the LOBBY->LIVE transition. `startedAt` is nullable
 * in the schema (a round that's DRAFT has never gone live), so this guards
 * against `null` by scoring 0 elapsed time rather than crashing on
 * `null.getTime()`. In practice this branch shouldn't be reachable here -
 * guesses are only accepted on `MusicRoundPhase.LIVE` rounds, and `setRoundLive`
 * is the only way a round becomes LIVE - but it's cheap insurance against
 * that invariant breaking elsewhere.
 */
export class GuessService {
  constructor(private readonly gameRepository: MusicGameRepository) {}

  async processGuess(params: {
    chatId: number;
    roundId: number;
    guessingUserId: number;
    guessedUserId?: number; // Optional: who the user is guessing uploaded the track
  }): Promise<
    | { isCorrect: boolean; points: number }
    | 'ALREADY_GUESSED'
    | 'NO_GAME'
    | 'NO_ROUND'
    | 'ROUND_NOT_LIVE'
    | 'GAME_NOT_ACTIVE'
  > {
    const { chatId, roundId, guessingUserId, guessedUserId } = params;

    const round = await this.gameRepository.findRoundById(roundId);
    if (!round) return 'NO_ROUND';

    // Guard: only allow guesses on LIVE rounds
    if (round.phase !== MusicRoundPhase.LIVE) return 'ROUND_NOT_LIVE';

    const game = await this.gameRepository.getCurrentGameByChatId(chatId);
    if (!game) return 'NO_GAME';

    // Guard: only allow guesses in ACTIVE games
    if (game.status !== MusicGameStatus.ACTIVE) return 'GAME_NOT_ACTIVE';

    const existingGuess = await this.gameRepository.findGuess(roundId, guessingUserId);
    if (existingGuess) return 'ALREADY_GUESSED';

    // B1 fix: startedAt instead of createdAt, with a null-safe fallback.
    const timeElapsed = round.startedAt ? (Date.now() - round.startedAt.getTime()) / 1000 : 0;
    const isLateGuess = round.sequence < game.currentSequence;

    const preset = game.scoringPreset ?? 'classic';
    const strategy: ScoringStrategy = scoringByPreset(preset);

    // If guessedUserId is provided and valid, use it; otherwise fall back to guessingUserId
    // (for backward compatibility with old behavior)
    const actualGuessedId =
      guessedUserId !== undefined && !isNaN(guessedUserId) ? guessedUserId : guessingUserId;
    const isCorrect = Number(round.userId) === actualGuessedId;
    const isSelfGuess = guessingUserId === Number(round.userId);
    const points = strategy.score({
      isCorrect,
      isSelfGuess,
      timeElapsedSec: timeElapsed,
      hintShown: !!round.hintShownAt,
      roundNumber: game.currentSequence,
    });

    await this.gameRepository.createGuess({
      roundId,
      userId: guessingUserId,
      guessedId: actualGuessedId,
      isCorrect,
      points,
      isLateGuess,
    });

    return { isCorrect, points };
  }
}
