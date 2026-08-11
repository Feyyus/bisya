import { Context, SessionFlavor } from "grammy";

/**
 * Per-chat/session state carried on `ctx.session`.
 *
 * `selectedChatId` is the one piece of session state the ported bschat-bot
 * code actually needs: the (not-yet-ported) upload flow lets a user DM the
 * bot a track, then pick which group chat it belongs to - the picked chat id
 * is stashed here between the "pick a chat" step and the "attach the
 * upload" step (see bschat-bot's `music-game-upload.module.ts`,
 * `ctx.session.selectedChatId`).
 *
 * Nothing in the code ported so far uses `ctx.scene` (grammY's scenes
 * plugin) - bschat-bot's `IBotContext` had one for the upload wizard, but
 * that wizard hasn't been ported yet, and none of the services/repository
 * under `apps/music-bot/src` reference it. Left out here rather than added
 * speculatively; add `SceneSessionData` back if/when the upload composer
 * actually needs it.
 */
export interface SessionData {
    selectedChatId?: number;
}

/**
 * The real session-flavored grammY context for Music Bot. Replaces the
 * plain `Context` stand-in that `music-game.service.ts` used as a
 * placeholder before this ticket.
 */
export type BotContext = Context & SessionFlavor<SessionData>;
