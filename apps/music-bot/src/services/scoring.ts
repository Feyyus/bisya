/**
 * Scoring strategies for the music-guessing game.
 *
 * Ported from bschat-bot's `src/modules/musicGame/scoring.ts` verbatim - this
 * is pure, framework-agnostic scoring logic with no Telegraf/grammY or
 * Prisma dependencies, so nothing needed to change beyond the file's new
 * home. `GuessService` is the only caller.
 */

export interface ScoringInput {
  isCorrect: boolean;
  isSelfGuess: boolean;
  timeElapsedSec: number;
  hintShown: boolean;
  roundNumber: number;
}

export interface ScoringStrategy {
  score(input: ScoringInput): number;
}

export class ClassicScoring implements ScoringStrategy {
  score({ isCorrect, isSelfGuess, timeElapsedSec, hintShown, roundNumber }: ScoringInput): number {
    if (isSelfGuess) return 0;
    if (!isCorrect) return -2;
    let base = 4;
    if (timeElapsedSec <= 30) base += 2;
    else if (timeElapsedSec > 120) base -= 1;
    if (hintShown) base -= 1;
    base += Math.min(roundNumber, 3);
    return Math.max(1, base);
  }
}

export class AggressiveScoring implements ScoringStrategy {
  score({ isCorrect, isSelfGuess, timeElapsedSec }: ScoringInput): number {
    if (isSelfGuess) return 0;
    if (!isCorrect) return -3;
    return timeElapsedSec <= 20 ? 7 : 4;
  }
}

export class GentleScoring implements ScoringStrategy {
  score({ isCorrect, isSelfGuess, hintShown }: ScoringInput): number {
    if (isSelfGuess) return 0;
    if (!isCorrect) return 0;
    return hintShown ? 2 : 3;
  }
}

export function scoringByPreset(preset: 'classic' | 'aggressive' | 'gentle'): ScoringStrategy {
  switch (preset) {
    case 'aggressive':
      return new AggressiveScoring();
    case 'gentle':
      return new GentleScoring();
    default:
      return new ClassicScoring();
  }
}
