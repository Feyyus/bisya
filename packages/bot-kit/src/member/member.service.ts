import {
    Chat,
    ChatMembership,
    prisma as defaultPrisma,
    PrismaClient,
    User,
} from "@bisya/db";

/**
 * Manages User, Chat, and ChatMembership records.
 *
 * Ported from bschat-bot's `MemberService` (src/modules/common/member.service.ts),
 * adapted to the new `@bisya/db` Prisma client and stripped of everything that
 * isn't pure membership/user/chat bookkeeping. The old service also had
 * game-round-specific methods (`getSubmissionUsers`, `addMusicHint`,
 * `getSubmission`, `saveSubmission`) that depended on `MusicGameRepository`
 * (an Inversify-injected, music-game-specific dependency) - those belong to
 * Music Bot's own domain, not this shared package, so they were left out here.
 * They should live alongside the ported `MusicGameRepository` in
 * `apps/music-bot` instead.
 */
// Combining diacritical marks block (U+0300-U+036F), built from code points
// rather than a literal escape range to keep this file's encoding unambiguous.
const COMBINING_MARKS = new RegExp(
    "[" + String.fromCharCode(0x0300) + "-" + String.fromCharCode(0x036f) + "]",
    "g",
);

export class MemberService {
    constructor(private readonly db: PrismaClient = defaultPrisma) {}

    async upsertUser(userData: {
        id: number;
        username?: string | null;
        firstName: string;
    }): Promise<User> {
        // Strip combining diacritics (e.g. "é" -> "e") so names normalize
        // consistently regardless of how Telegram sent them.
        const normalizedName = userData.firstName
            .normalize("NFKD")
            .replace(COMBINING_MARKS, "");

        return this.db.user.upsert({
            where: { id: BigInt(userData.id) },
            create: {
                id: BigInt(userData.id),
                tag: userData.username || null,
                name: normalizedName,
            },
            update: {
                tag: userData.username || null,
                name: normalizedName,
            },
        });
    }

    async upsertChat(chatData: { id: number; title: string }): Promise<Chat> {
        return this.db.chat.upsert({
            where: { id: BigInt(chatData.id) },
            create: {
                id: BigInt(chatData.id),
                title: chatData.title,
            },
            update: {
                title: chatData.title,
            },
        });
    }

    /**
     * Auto-syncs membership when a user is active in a group chat. Intended
     * to be called from `membershipSyncMiddleware` on every group message -
     * this is the only way users join chats now, no manual command needed.
     */
    async autoSyncMembership(userId: number, chatId: number): Promise<void> {
        await this.db.chatMembership.upsert({
            where: {
                userId_chatId: {
                    userId: BigInt(userId),
                    chatId: BigInt(chatId),
                },
            },
            create: {
                userId: BigInt(userId),
                chatId: BigInt(chatId),
                lastSeen: new Date(),
                isActive: true,
            },
            update: {
                lastSeen: new Date(),
                isActive: true,
            },
        });
    }

    /**
     * Marks a member inactive (e.g. when they leave the chat). Can be called
     * from bot event handlers such as `left_chat_member`.
     */
    async deactivateMember(userId: number, chatId: number): Promise<void> {
        await this.db.chatMembership.updateMany({
            where: {
                userId: BigInt(userId),
                chatId: BigInt(chatId),
            },
            data: {
                isActive: false,
            },
        });
    }

    async getUsersByChatId(chatId: number): Promise<User[]> {
        return this.db.user.findMany({
            where: {
                memberships: {
                    some: {
                        chatId: BigInt(chatId),
                        isActive: true,
                    },
                },
            },
        });
    }

    async getChatsByUserId(userId: number): Promise<Chat[]> {
        return this.db.chat.findMany({
            where: {
                memberships: {
                    some: {
                        userId: BigInt(userId),
                        isActive: true,
                    },
                },
            },
        });
    }

    async existsMember(userId: number, chatId: number): Promise<boolean> {
        const member = await this.db.chatMembership.findFirst({
            where: {
                userId: BigInt(userId),
                chatId: BigInt(chatId),
                isActive: true,
            },
        });
        return member !== null;
    }

    /**
     * Active memberships for a user, each with its chat, most recently seen first.
     */
    async getActiveMemberships(
        userId: number,
    ): Promise<(ChatMembership & { chat: Chat })[]> {
        return this.db.chatMembership.findMany({
            where: {
                userId: BigInt(userId),
                isActive: true,
            },
            include: {
                chat: true,
            },
            orderBy: {
                lastSeen: "desc",
            },
        });
    }

    // NOTE: https://limits.tginfo.me/en
    // Mentions in a single message are capped at 50, and only the first 5
    // in a list actually trigger a notification - so we batch pings in
    // groups of 5.
    formatPingNames(participants: User[]): string[] {
        const formattedNames: string[] = [];
        const remaining = [...participants];

        while (remaining.length > 0) {
            const batch = remaining.splice(0, 5);
            formattedNames.push(
                batch.map((p) => this.formatParticipantName(p)).join("\n"),
            );
        }

        return formattedNames;
    }

    private formatParticipantName(user: User): string {
        return `[${this.getFormattedUser(user)}](tg://user?id=${Number(user.id)})`;
    }

    private getFormattedUser(user: User): string {
        return `${user.name}${user.tag ? ` (${user.tag})` : ""}`;
    }
}
