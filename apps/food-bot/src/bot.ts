import { Bot, Context, SessionFlavor } from "grammy";
import { PrismaClient } from "@prisma/client";
import { SocksProxyAgent } from "socks-proxy-agent";
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

// Telegram is unreachable directly from the homelab network. When
// TELEGRAM_PROXY_HOST is set, route API calls through an SSH SOCKS5 tunnel
// instead, per grammY's documented proxy setup (grammy.dev/advanced/proxy).
const proxyHost = process.env.TELEGRAM_PROXY_HOST;
const proxyPort = process.env.TELEGRAM_PROXY_PORT ?? "1080";
const socksAgent = proxyHost
  ? new SocksProxyAgent(`socks5://${proxyHost}:${proxyPort}`)
  : undefined;
if (socksAgent) {
  console.log(`Routing Telegram API calls through SOCKS5 proxy at ${proxyHost}:${proxyPort}`);
}

const bot = new Bot<BotContext>(token, {
  client: socksAgent
    ? {
        baseFetchConfig: { agent: socksAgent, compress: true },
        // grammY's default 500s timeout means a silently-dead tunnel
        // connection (SSH's ServerAliveInterval is off by default, so it
        // can't detect this either) just hangs forever with no error. A
        // short timeout turns that into a fast, retryable failure instead.
        // See docs/research/ssh-socks5-longpoll-hang.md.
        timeoutSeconds: 30,
      }
    : undefined,
});
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
  const deepLink = "tg://resolve?domain=BisyaFoodBot&startgroup=true";

  await ctx.reply(message, {
    reply_markup: {
      inline_keyboard: [[{ text: "Add to group", url: deepLink }]],
    },
  });
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

    // Telegram only shows the "typing" indicator for ~5s per call, so keep
    // re-sending it while the Unsplash fetch is in flight.
    await ctx.replyWithChatAction("typing");
    const chatActionInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {
        // Best-effort - a failed chat action shouldn't interrupt the reply.
      });
    }, 4000);

    let photoData: Awaited<ReturnType<typeof UnsplashService.fetchPhoto>>;
    try {
      photoData = await UnsplashService.fetchPhoto(match.searchQuery);
    } finally {
      clearInterval(chatActionInterval);
    }

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
        await ctx.reply(
          `Found 🍕 ${match.matchedWord}, but couldn't send the photo - try again in a bit!`
        );
      }
    } else {
      // Unsplash didn't respond - let the user know the bot recognized the
      // word rather than just going quiet, since a bare "Found" reads the
      // same whether Unsplash failed or nothing was even detected.
      await ctx.reply(
        `Found 🍕 ${match.matchedWord}, but couldn't reach Unsplash for a photo right now - try again in a bit!`
      );
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

    console.log("Calling getMe() to validate connectivity...");
    const me = await bot.api.getMe();
    console.log(`getMe() succeeded: @${me.username}`);

    console.log("Calling bot.start()...");
    await bot.start({
      // A shorter long-poll window (vs. the ~30-50s default) shrinks the
      // window during which a proxied connection can go idle-and-die
      // mid-poll. See docs/research/ssh-socks5-longpoll-hang.md.
      timeout: 10,
      onStart: (info) => console.log(`Polling started: @${info.username}`),
    });
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
