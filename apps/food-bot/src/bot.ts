import { Bot, Context, SessionFlavor } from "grammy";

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
bot.on("message", async (ctx) => {
  if (ctx.message?.group_chat_created || ctx.message?.new_chat_members) {
    // Deep link to add bot to other groups
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
  }
});

// Error handler
bot.catch((err) => {
  console.error("Bot error:", err);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  bot.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  bot.stop();
  process.exit(0);
});

// Start the bot
async function main() {
  try {
    console.log("Starting Bisya Food Bot...");
    await bot.start();
    console.log("Bot started successfully");
  } catch (error) {
    console.error("Failed to start bot:", error);
    process.exit(1);
  }
}

main();
