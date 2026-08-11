import type { Context, MiddlewareFn } from "grammy";
import type { PrismaClient } from "@bisya/db";
import { hasPermission } from "../permissions/permission";

export interface RequirePermissionOptions {
    /** Reply sent when the update has no `from`/`chat` (e.g. DM edge cases, channel posts). */
    chatOnlyMessage?: string;
    /** Reply sent when the user lacks the required permission. */
    deniedMessage?: string;
}

/**
 * Middleware factory that blocks the update unless the sender holds
 * `permission` (see `permissions/permission.ts`) in the current chat -
 * otherwise it replies with a denial message and stops the chain.
 *
 * Ported logic (not code shape) from bschat-bot's `RequirePermission`
 * class-method decorator
 * (src/modules/permissions/require-permission.decorator.ts): same
 * missing-from/chat guard, same permission check, same "reply + stop" on
 * failure. grammY doesn't need reflect-metadata-based decorators the way
 * Telegraf/Inversify did, so this is a plain middleware factory instead -
 * use it with `bot.command("foo", requirePermission(prisma, MY_PERMISSION), handler)`.
 *
 * bschat-bot pulled `RoleService`/`TextService` from an Inversify container
 * at call time; here `prisma` is passed in directly (plain DI) and the
 * messages default to plain English strings so this package stays
 * i18n-agnostic. Pass `TextService.get(...)` output via `options` if a bot
 * wants localized messages.
 */
export function requirePermission<C extends Context = Context>(
    prisma: PrismaClient,
    permission: number,
    options: RequirePermissionOptions = {},
): MiddlewareFn<C> {
    const {
        chatOnlyMessage = "This command can only be used in a group chat.",
        deniedMessage = "You do not have permission to use this command.",
    } = options;

    return async (ctx, next) => {
        const userId = ctx.from?.id;
        const chatId = ctx.chat?.id;

        if (!userId || !chatId) {
            await ctx.reply(chatOnlyMessage);
            return;
        }

        const allowed = await hasPermission(
            prisma,
            BigInt(userId),
            BigInt(chatId),
            permission,
        );

        if (!allowed) {
            await ctx.reply(deniedMessage);
            return;
        }

        await next();
    };
}
