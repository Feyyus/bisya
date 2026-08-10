-- CreateTable
CREATE TABLE "FoodTrigger" (
    "id" SERIAL NOT NULL,
    "chatId" BIGINT NOT NULL,
    "trigger" TEXT NOT NULL,
    "searchQuery" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FoodChatConfig" (
    "chatId" BIGINT NOT NULL,
    "responseChance" INTEGER NOT NULL DEFAULT 100,
    "seededAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FoodChatConfig_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE UNIQUE INDEX "FoodTrigger_trigger_chatId_key" ON "FoodTrigger"("trigger", "chatId");
