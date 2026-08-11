import type { Context, MiddlewareFn } from "grammy";
import type { MemberService } from "../member/member.service";

/**
 * Auto-syncs the current user, chat, and their membership on every group
 * message. This is the only way users/chats/memberships get created - there
 * is no manual "join" command.
 *
 * Ported from the inline middleware bschat-bot registered in `src/app.ts`
 * (the `this.bot.use(async (ctx, next) => { ... })` block right after
 * session setup) - same skip-in-private-chats guard, same
 * upsertUser/upsertChat/autoSyncMembership sequence, same
 * catch-and-log-without-blocking-the-update behavior. Takes a `MemberService`
 * instance directly instead of pulling it from an Inversify container.
 *
 * The real `BotContext` for Music Bot doesn't exist yet (a later ticket adds
 * it), so this is generic over any grammY `Context` for now.
 */
export function membershipSyncMiddleware<C extends Context = Context>(
    memberService: MemberService,
): MiddlewareFn<C> {
    return async (ctx, next) => {
        if (ctx.chat?.type !== "private" && ctx.from && ctx.chat) {
            try {
                await memberService.upsertUser({
                    id: ctx.from.id,
                    username: ctx.from.username,
                    firstName: ctx.from.first_name,
                });

                if ("title" in ctx.chat) {
                    await memberService.upsertChat({
                        id: ctx.chat.id,
                        title: ctx.chat.title,
                    });
                }

                await memberService.autoSyncMembership(ctx.from.id, ctx.chat.id);
            } catch (error) {
                console.error("Failed to auto-sync membership:", error);
            }
        }

        return next();
    };
}
