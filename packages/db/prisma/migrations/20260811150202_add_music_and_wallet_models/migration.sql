-- CreateEnum
CREATE TYPE "GameStatus" AS ENUM ('LOBBY', 'ACTIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "RoundPhase" AS ENUM ('DRAFT', 'LIVE', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ScoringPreset" AS ENUM ('classic', 'aggressive', 'gentle');

-- CreateTable
CREATE TABLE "User" (
    "id" BIGINT NOT NULL,
    "tag" TEXT,
    "name" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMembership" (
    "userId" BIGINT NOT NULL,
    "chatId" BIGINT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ChatMembership_pkey" PRIMARY KEY ("userId","chatId")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" INTEGER NOT NULL DEFAULT 0,
    "chatId" BIGINT NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" BIGINT NOT NULL,
    "roleId" INTEGER NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" BIGINT NOT NULL,
    "title" TEXT NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Game" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "GameStatus" NOT NULL DEFAULT 'LOBBY',
    "currentSequence" INTEGER NOT NULL DEFAULT 0,
    "hintDelaySec" INTEGER NOT NULL DEFAULT 30,
    "autoAdvance" BOOLEAN NOT NULL DEFAULT false,
    "advanceDelaySec" INTEGER NOT NULL DEFAULT 10,
    "allowSelfGuess" BOOLEAN NOT NULL DEFAULT false,
    "shuffle" BOOLEAN NOT NULL DEFAULT true,
    "scoringPreset" "ScoringPreset" NOT NULL DEFAULT 'classic',
    "chatId" BIGINT NOT NULL,

    CONSTRAINT "Game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameRound" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" INTEGER NOT NULL,
    "phase" "RoundPhase" NOT NULL DEFAULT 'DRAFT',
    "startedAt" TIMESTAMP(3),
    "hintShownAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "musicFileId" TEXT NOT NULL,
    "hintChatId" BIGINT,
    "hintMessageId" BIGINT,
    "infoMessageId" BIGINT,
    "userId" BIGINT NOT NULL,
    "gameId" INTEGER NOT NULL,

    CONSTRAINT "GameRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Guess" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "guessedId" BIGINT NOT NULL,
    "points" INTEGER NOT NULL,
    "roundId" INTEGER NOT NULL,
    "userId" BIGINT NOT NULL,

    CONSTRAINT "Guess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" SERIAL NOT NULL,
    "userId" BIGINT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletTransaction" (
    "id" SERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "walletId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "relatedEntityId" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatMembership_chatId_isActive_idx" ON "ChatMembership"("chatId", "isActive");

-- CreateIndex
CREATE INDEX "ChatMembership_userId_isActive_idx" ON "ChatMembership"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_chatId_key" ON "Role"("name", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "GameRound_gameId_sequence_key" ON "GameRound"("gameId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "GameRound_gameId_userId_key" ON "GameRound"("gameId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Guess_roundId_userId_key" ON "Guess"("roundId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WalletTransaction_idempotencyKey_key" ON "WalletTransaction"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "ChatMembership" ADD CONSTRAINT "ChatMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMembership" ADD CONSTRAINT "ChatMembership_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Game" ADD CONSTRAINT "Game_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guess" ADD CONSTRAINT "Guess_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "GameRound"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Guess" ADD CONSTRAINT "Guess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletTransaction" ADD CONSTRAINT "WalletTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
