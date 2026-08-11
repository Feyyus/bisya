import { MemberService, TextService, TextServiceOptions } from "@bisya/bot-kit";
import { PrismaClient, prisma as defaultPrisma } from "@bisya/db";
import { SchedulerService } from "@bisya/scheduler";
import { ActionCodec } from "./codec/action.codec";
import { MusicGameRepository } from "./repository/music-game.repository";
import { GameLifecycleService } from "./services/game-lifecycle.service";
import { GuessService } from "./services/guess.service";
import { MusicGameService } from "./services/music-game.service";
import { RoundOrchestratorService } from "./services/round-orchestrator.service";

export interface ContainerOptions {
    /** Defaults to `@bisya/db`'s shared client. Override in tests with a fake/mock. */
    prisma?: PrismaClient;
    /** Forwarded to `TextService` (locale, fallback locale, locales dir). */
    text?: TextServiceOptions;
}

/**
 * Music Bot's dependency graph.
 *
 * Every ported service so far (`MusicGameRepository`, `GuessService`,
 * `GameLifecycleService`, `RoundOrchestratorService`, `MusicGameService`,
 * and bot-kit's `MemberService`/`TextService`) is a plain class taking its
 * dependencies as constructor params - none use Inversify's `@injectable()`
 * decorator, and Inversify isn't a dependency anywhere in this monorepo.
 * bschat-bot's `container.ts` (the Inversify-based reference for this
 * ticket) also bound a pile of modules Music Bot doesn't have
 * (`FoodModule`, `JokerModule`, `SorryModule`, `CraftyModule`, role/
 * permission services, etc.) - reflection-based DI made more sense there,
 * wiring one big app with many independent feature modules. Music Bot's
 * graph is small and fully known upfront, so a plain factory function
 * matches the pattern the repository/service porting tickets already
 * established and avoids pulling in a new dependency for this app alone.
 *
 * `createContainer` takes its `prisma` client as a parameter (rather than
 * having every service default to `@bisya/db`'s shared singleton) so tests
 * can swap in a fake without needing a real database - see the acceptance
 * criteria's note about the upcoming test-coverage ticket wanting to inject
 * fakes for `SchedulerService`/Prisma. `SchedulerService` itself takes no
 * constructor params (see `packages/scheduler`), so a test can construct its
 * own instance and pass it straight to the services that need it instead of
 * going through this factory at all.
 */
export function createContainer(options: ContainerOptions = {}) {
    const prisma = options.prisma ?? defaultPrisma;

    const memberService = new MemberService(prisma);
    const textService = new TextService(options.text);
    const gameRepository = new MusicGameRepository(prisma);
    const actionCodec = new ActionCodec();
    const schedulerService = new SchedulerService();

    const guessService = new GuessService(gameRepository);
    const lifecycleService = new GameLifecycleService(gameRepository);
    const roundOrchestrator = new RoundOrchestratorService(
        gameRepository,
        schedulerService,
        textService,
        actionCodec,
    );
    const musicGameService = new MusicGameService(
        gameRepository,
        textService,
        memberService,
        guessService,
        roundOrchestrator,
        lifecycleService,
    );

    return {
        prisma,
        memberService,
        textService,
        gameRepository,
        actionCodec,
        schedulerService,
        guessService,
        lifecycleService,
        roundOrchestrator,
        musicGameService,
    };
}

export type Container = ReturnType<typeof createContainer>;
