-- Rename Music Bot's Game/GameRound/Guess models to the Music-prefixed
-- convention Food Bot established (FoodTrigger, FoodChatConfig) - see
-- CONTEXT.md's "Table naming" section. Additive migration on top of
-- 20260811150202_add_music_and_wallet_models - that migration is not
-- edited or squashed.
--
-- Enums are prefixed too (GameStatus/RoundPhase/ScoringPreset ->
-- MusicGameStatus/MusicRoundPhase/MusicScoringPreset): they're Postgres
-- types in the same shared "public" schema as tables, exclusively used by
-- these three models, so the same collision-avoidance rationale that
-- applies to table names applies to them.
--
-- Uses RENAME everywhere (tables, enum types, constraints, indexes,
-- sequences) instead of drop/recreate so existing data and history survive
-- unchanged - this must apply cleanly against both a fresh database (right
-- after the previous migration) and an already-running one with live rows.

-- Rename enum types
ALTER TYPE "GameStatus" RENAME TO "MusicGameStatus";
ALTER TYPE "RoundPhase" RENAME TO "MusicRoundPhase";
ALTER TYPE "ScoringPreset" RENAME TO "MusicScoringPreset";

-- Rename tables
ALTER TABLE "Game" RENAME TO "MusicGame";
ALTER TABLE "GameRound" RENAME TO "MusicGameRound";
ALTER TABLE "Guess" RENAME TO "MusicGuess";

-- Rename primary key constraints (and their backing indexes, implicitly)
ALTER TABLE "MusicGame" RENAME CONSTRAINT "Game_pkey" TO "MusicGame_pkey";
ALTER TABLE "MusicGameRound" RENAME CONSTRAINT "GameRound_pkey" TO "MusicGameRound_pkey";
ALTER TABLE "MusicGuess" RENAME CONSTRAINT "Guess_pkey" TO "MusicGuess_pkey";

-- Rename foreign key constraints
ALTER TABLE "MusicGame" RENAME CONSTRAINT "Game_chatId_fkey" TO "MusicGame_chatId_fkey";
ALTER TABLE "MusicGameRound" RENAME CONSTRAINT "GameRound_userId_fkey" TO "MusicGameRound_userId_fkey";
ALTER TABLE "MusicGameRound" RENAME CONSTRAINT "GameRound_gameId_fkey" TO "MusicGameRound_gameId_fkey";
ALTER TABLE "MusicGuess" RENAME CONSTRAINT "Guess_roundId_fkey" TO "MusicGuess_roundId_fkey";
ALTER TABLE "MusicGuess" RENAME CONSTRAINT "Guess_userId_fkey" TO "MusicGuess_userId_fkey";

-- Rename unique indexes
ALTER INDEX "GameRound_gameId_sequence_key" RENAME TO "MusicGameRound_gameId_sequence_key";
ALTER INDEX "GameRound_gameId_userId_key" RENAME TO "MusicGameRound_gameId_userId_key";
ALTER INDEX "Guess_roundId_userId_key" RENAME TO "MusicGuess_roundId_userId_key";

-- Rename autoincrement sequences (and their owning-column defaults, implicitly)
ALTER SEQUENCE "Game_id_seq" RENAME TO "MusicGame_id_seq";
ALTER SEQUENCE "GameRound_id_seq" RENAME TO "MusicGameRound_id_seq";
ALTER SEQUENCE "Guess_id_seq" RENAME TO "MusicGuess_id_seq";
