import type { PrismaClient } from "@bisya/db";

/**
 * Reserved bit for "has every permission in this chat". Ported from
 * bschat-bot's `PERMISSIONS.ADMIN` (src/modules/permissions/permission.service.ts),
 * which was always `1 << 0`. Kept as a shared convention so every bot that
 * defines its own permission bitmask (e.g. Music Bot's own
 * `MANAGE_MUSIC_GAME`, `1 << 1`) can rely on bit 0 acting as an admin
 * bypass, the same way bschat-bot's RoleService did.
 */
export const ADMIN_PERMISSION = 1 << 0;

/**
 * Checks whether a user has `permission` in `chatId`, by aggregating (via
 * bitwise OR) the `permissions` bitmask of every `Role` assigned to them in
 * that chat through `UserRole`. A role carrying `ADMIN_PERMISSION` always
 * passes, regardless of the specific `permission` requested.
 *
 * Ported from bschat-bot's `RoleService.hasPermission`
 * (src/modules/permissions/role.service.ts) - same aggregation-with-ADMIN-override
 * logic. Left out is bschat-bot's fixed `PERMISSIONS` registry
 * (ADMIN/MANAGE_MUSIC_GAME/MANAGE_ROLES/MANAGE_CRAFTY/MANAGE_FOOD) - those
 * names were specific to that one bot's feature set, so this package only
 * ports the mechanism and leaves each bot to define its own bit flags.
 */
export async function hasPermission(
    prisma: PrismaClient,
    userId: bigint,
    chatId: bigint,
    permission: number,
): Promise<boolean> {
    const userRoles = await prisma.userRole.findMany({
        where: {
            userId,
            role: {
                chatId,
            },
        },
        include: {
            role: true,
        },
    });

    const combinedPermissions = userRoles.reduce(
        (acc, userRole) => acc | userRole.role.permissions,
        0,
    );

    if (combinedPermissions & ADMIN_PERMISSION) return true;

    return (combinedPermissions & permission) !== 0;
}
