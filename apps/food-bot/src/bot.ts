import { Bot, Context, SessionFlavor } from "grammy";
import { PrismaClient } from "@prisma/client";
import { TriggerService } from "./services/trigger.service";
import { UnsplashService } from "./services/unsplash.service";

interface SessionData {
  // Placeholder for per-chat configuration
  // Will be populated by trigger detection (ticket #13)
}

type BotContext = Context & SessionFlavor<SessionData>;

const token = process.env.FOOD_BOT_TOKEN;
if (!token) {
  throw new Error("FOOD_BOT_TOKEN environment variable is required");
}

const bot = new Bot<BotContext>(token);
const prisma = new PrismaClient();

// Cache for global food triggers (loaded at startup)
let foodTriggers: Array<{ id: number; trigger: string; searchQuery: string }> =
  [];

// Session middleware - placeholder for future per-chat state management
bot.use(async (ctx, next) => {
  ctx.session = ctx.session ?? {};
  await next();
});

// /start command handler
bot.command("start", async (ctx) => {
  const message =
    "Welcome to Bisya Food Bot! Send a food-related word and I'll find a matching image.";
  await ctx.reply(message);
});

// Group join handler - send deep link button to add bot to other groups
bot.on(["message:new_chat_members", "message:group_chat_created"], async (ctx) => {
  const deepLink = "tg://resolve?domain=BisyaFoodBot";

  await ctx.reply("Thanks for adding me!", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Add to group",
            url: deepLink,
          },
        ],
      ],
    },
  });
});

// Message handler for food trigger detection (ticket #13)
bot.on("message:text", async (ctx) => {
  try {
    const chatId = BigInt(ctx.chat.id);
    const messageText = ctx.message.text;

    if (!messageText || foodTriggers.length === 0) {
      return; // No triggers loaded or empty message
    }

    // Extract and stem words from the message
    const stemmedWords = TriggerService.extractAndStemWords(messageText);

    // Check if any word matches a food trigger
    const match = TriggerService.findTriggerMatch(stemmedWords, foodTriggers);

    if (!match) {
      return; // No trigger match
    }

    // Check response probability
    const responseChance = await TriggerService.getResponseChance(
      prisma,
      chatId
    );

    if (!TriggerService.shouldRespond(responseChance)) {
      return; // Probabilistic decision to not respond
    }

    // Try to fetch a photo from Unsplash
    const photoData = await UnsplashService.fetchPhoto(match.searchQuery);

    if (photoData) {
      // Send photo with caption
      const caption = UnsplashService.generateCaption(
        match.matchedWord,
        photoData.author
      );

      try {
        await ctx.replyWithPhoto(photoData.url, {
          caption: caption,
        });
      } catch (error) {
        console.error("Failed to send photo, sending text fallback:", error);
        await ctx.reply(`Found: 🍕 ${match.matchedWord}`);
      }
    } else {
      // Fallback to text reply if photo fetch failed
      await ctx.reply(`Found: 🍕 ${match.matchedWord}`);
    }
  } catch (error) {
    console.error("Error in food trigger handler:", error);
    // Don't reply to avoid spam on errors
  }
});

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Start the bot
async function main() {
  try {
    console.log("Starting Bisya Food Bot...");

    // Load global food triggers from database
    try {
      foodTriggers = await TriggerService.loadGlobalTriggers(prisma);
      console.log(`Loaded ${foodTriggers.length} global food triggers`);
    } catch (error) {
      console.error("Failed to load food triggers from database:", error);
      // Continue without triggers rather than failing to start
    }

    // Set up periodic cache cleanup
    setInterval(() => {
      UnsplashService.clearExpiredCache();
    }, 30 * 60 * 1000); // Every 30 minutes

    await bot.start();
    console.log("Bot started successfully");
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
async function shutdown() {
  console.log("Shutting down gracefully...");
  await prisma.$disconnect();
  bot.stop();
  process.exit(0);
}

// Override signal handlers with shutdown logic
process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main();
