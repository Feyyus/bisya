import { Bot, BotConfig, Context, SessionFlavor } from "grammy";
import { PrismaClient } from "@prisma/client";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as https from "https";
import { TriggerService } from "./services/trigger.service";
import { UnsplashService } from "./services/unsplash.service";

/**
 * A minimal Fetch-API-compatible wrapper around Node's raw https.request,
 * used instead of node-fetch v2 when proxying through a custom Agent.
 *
 * node-fetch v2's fetch() wrapper doesn't reliably propagate abort/timeout
 * signals down into a custom agent's connect() (confirmed by reading
 * socks-proxy-agent's source: the SocksClient.createConnection() call it
 * awaits has no cancellation path at all), so a stalled SOCKS handshake
 * just hangs forever regardless of any timeout set elsewhere. Telegraf,
 * proven working in production through this exact same tunnel and agent,
 * passes the agent straight to https.request() with no such wrapper - this
 * mirrors that. See docs/research/ssh-socks5-longpoll-hang.md.
 */
function createHttpsFetch(agent: https.Agent): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const { hostname, pathname, search } = new URL(url);
    const method = init?.method ?? "GET";
    const headers = (init?.headers as Record<string, string>) ?? {};
    const body = init?.body as string | undefined;

    return new Promise<Response>((resolve, reject) => {
      const req = https.request(
        {
          agent,
          hostname,
          path: pathname + search,
          method,
          headers,
          // Longer than the ~10s long-poll window requested from Telegram
          // (bot.start({ timeout: 10 })), so a healthy empty poll never
          // trips this - only a genuinely stalled connection does.
          timeout: 25000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks);
            resolve(
              new Response(responseBody, {
                status: res.statusCode,
                headers: res.headers as Record<string, string>,
              })
            );
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error("Request timed out after 25 seconds"));
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  }) as typeof fetch;
}

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

let clientOptions: BotConfig<BotContext>["client"];
if (proxyHost) {
  console.log(`Routing Telegram API calls through SOCKS5 proxy at ${proxyHost}:${proxyPort}`);
  const socksAgent = new SocksProxyAgent(`socks5://${proxyHost}:${proxyPort}`);
  clientOptions = {
    // node-fetch v2 (grammY's default) doesn't propagate cancellation
    // into a custom agent's connect(), so a stalled SOCKS handshake
    // hangs forever no matter what timeout is set elsewhere. A raw
    // https.request-based fetch, matching what works in production
    // for this exact tunnel via Telegraf, doesn't have that problem.
    fetch: createHttpsFetch(socksAgent),
    timeoutSeconds: 30,
  };
}

const bot = new Bot<BotContext>(token, { client: clientOptions });
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

    await bot.start({
      // A shorter long-poll window (vs. the ~30-50s default) shrinks the
      // window during which a proxied connection can go idle-and-die
      // mid-poll. See docs/research/ssh-socks5-longpoll-hang.md.
      timeout: 10,
      onStart: (info) => console.log(`Polling started: @${info.username}`),
    });
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
