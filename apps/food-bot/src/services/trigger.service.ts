import { PrismaClient } from "@prisma/client";
import Snowball from "snowball";

interface TriggerMatch {
  searchQuery: string;
  matchedWord: string;
}

/**
 * Loads all global food triggers from the database (chatId = 0)
 */
async function loadGlobalTriggers(prisma: PrismaClient) {
  return prisma.foodTrigger.findMany({
    where: { chatId: 0n },
  });
}

/**
 * Stems a word using the Snowball stemmer (Russian language)
 */
function stemWord(word: string): string {
  try {
    // Create a stemmer instance for Russian
    const stemmer = new Snowball("russian");
    stemmer.setCurrent(word);
    stemmer.stem();
    return stemmer.getCurrent();
  } catch {
    // If stemming fails, return the word in lowercase
    return word.toLowerCase();
  }
}

/**
 * Extracts and stems words from a message
 */
function extractAndStemWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .match(/\b\w+\b/g)
    ?.map((word) => stemWord(word)) ?? [];

  return [...new Set(words)]; // Remove duplicates
}

/**
 * Checks if any word in the message matches a food trigger
 * Uses stem-based matching for Russian language support
 */
function findTriggerMatch(
  messageWords: string[],
  triggers: Array<{ trigger: string; searchQuery: string }>
): TriggerMatch | null {
  // Pre-stem all triggers
  const stemmedTriggers = triggers.map((t) => ({
    stemmed: stemWord(t.trigger),
    searchQuery: t.searchQuery,
    original: t.trigger,
  }));

  // Check if any message word matches a trigger's stem
  for (const word of messageWords) {
    for (const trigger of stemmedTriggers) {
      if (word === trigger.stemmed) {
        return {
          searchQuery: trigger.searchQuery,
          matchedWord: trigger.original,
        };
      }
    }
  }

  return null;
}

/**
 * Gets the response probability for a chat
 * Returns 0-100 percentage
 */
async function getResponseChance(prisma: PrismaClient, chatId: bigint) {
  const config = await prisma.foodChatConfig.findUnique({
    where: { chatId },
  });

  // Default to 100% if no config exists
  return config?.responseChance ?? 100;
}

/**
 * Determines if the bot should respond based on the probability chance
 */
function shouldRespond(responseChance: number): boolean {
  const chance = Math.max(0, Math.min(100, responseChance));
  return Math.random() * 100 < chance;
}

export const TriggerService = {
  loadGlobalTriggers,
  stemWord,
  extractAndStemWords,
  findTriggerMatch,
  getResponseChance,
  shouldRespond,
};
