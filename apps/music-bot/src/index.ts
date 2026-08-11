import { Router } from "@grammyjs/router";
import { membershipSyncMiddleware } from "@bisya/bot-kit";
import { Bot, Context, session } from "grammy";
import { createContainer } from "./container";
import { BotContext, SessionData } from "./context";
import { GameplayHandler } from "./features/gameplay";
import { InfoHandler } from "./features/info";
import { LobbyHandler } from "./features/lobby";
import { UploadComposer } from "./features/upload/upload.composer";

/**
 * Music Bot's bootstrap - wires every feature composer built by the
 * preceding tickets (#25-#28) onto one running `Bot<BotContext>` instance.
 *
 * Follows food-bot's `apps/food-bot/src/bot.ts` for the token-env-var and
 * graceful-shutdown conventions (see that file), and docs/spec.md Section
 * 3.2/3.4 for the middleware order and the scoped command lists.
 *
 * v0.1.0 explicitly has no BullMQ worker registration - `SchedulerService`
 * (`@bisya/scheduler`) is a plain in-memory scheduler, and
 * `RoundOrchestratorService.registerSchedulerHandlers` below wires its
 * hint/auto-advance handlers straight onto `bot.api` in-process. A BullMQ
 * worker process is deferred to v0.2.0 (see docs/spec.md Section 3.1's
 * "Register BullMQ workers" step, which doesn't apply yet).
 */

const token = process.env.MUSIC_BOT_TOKEN;
if (!token) {
    throw new Error("MUSIC_BOT_TOKEN environment variable is required");
}

const bot = new Bot<BotContext>(token);
const container = createContainer();

// ---- Middleware stack (docs/spec.md 3.2: session -> membership sync -> router) ----

bot.use(session<SessionData, Context>({ initial: () => ({}) }));
bot.use(membershipSyncMiddleware(container.memberService));

/**
 * Private/group split (docs/spec.md 3.2/3.4): a DM routes to the upload
 * flow (group selection + track/hint submission); anything else (group,
 * supergroup, channel) routes to the three group-side feature composers,
 * chained so each one's `next()` fallthrough (see their own doc comments)
 * gives the next a turn.
 */
const router = new Router<BotContext>((ctx) => (ctx.chat?.type === "private" ? "private" : "group"));

router.route(
    "private",
    new UploadComposer(container.memberService, container.textService, container.gameRepository, container.actionCodec),
);

router.route(
    "group",
    new LobbyHandler(container.musicGameService, container.actionCodec),
    new GameplayHandler(container.musicGameService, container.actionCodec),
    new InfoHandler(container.musicGameService),
);

bot.use(router);

bot.catch((err) => {
    console.error("Bot error:", err);
});

/**
 * Binds `RoundOrchestratorService`'s scheduler handlers to `bot.api`. Must
 * happen once, after `bot.api` exists (it does as soon as `Bot` is
 * constructed - no need to wait for `bot.start()`) and before the bot
 * starts polling, since a `/music_start` in the very first update could
 * otherwise schedule a hint/advance job with no handler registered to
 * receive it. This is the fix issues #25-#28 all flagged as a gap they
 * couldn't close themselves.
 */
container.roundOrchestrator.registerSchedulerHandlers(bot.api);

/** Scoped command lists, per docs/spec.md Section 3.4. */
async function registerCommands(): Promise<void> {
    await bot.api.setMyCommands([{ command: "start", description: "Select a group and submit your track" }], {
        scope: { type: "all_private_chats" },
    });

    await bot.api.setMyCommands(
        [
            { command: "music", description: "Open the music game lobby" },
            { command: "music_stats", description: "Show current game stats" },
            { command: "music_ping", description: "Ping all players" },
            { command: "music_help", description: "How to play" },
        ],
        { scope: { type: "all_group_chats" } },
    );
}

async function main(): Promise<void> {
    console.log("Starting Bisya Music Bot...");

    await registerCommands();

    await bot.start({
        onStart: (info) => console.log(`Polling started: @${info.username}`),
    });
}

/** Graceful shutdown - mirrors food-bot's `apps/food-bot/src/bot.ts` pattern. */
async function shutdown(): Promise<void> {
    console.log("Shutting down gracefully...");
    await bot.stop();
    await container.prisma.$disconnect();
    process.exit(0);
}

process.removeAllListeners("SIGTERM");
process.removeAllListeners("SIGINT");
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch((error) => {
    console.error("Failed to start bot:", error);
    process.exit(1);
});
