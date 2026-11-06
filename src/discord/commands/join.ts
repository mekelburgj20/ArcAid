import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from './index.js';
import { getDatabase } from '../../database/database.js';
import { logError } from '../../utils/logger.js';
import { roomUrl } from '../../utils/publicLinks.js';
import { BanService } from '../../services/BanService.js';
import { RoomAccessService, formatRoleList } from '../../services/RoomAccessService.js';
import { RoomMembershipService } from '../../services/RoomMembershipService.js';
import { JoinRequestService } from '../../services/JoinRequestService.js';

/**
 * `/join` — join the Arcaid room(s) linked to the invoking Discord server
 * (v2.222.0, E12). Mirrors the web self-join route (`POST /api/me/rooms/:roomId`
 * in `global.ts`) branch for branch: suspended → refused, banned → refused,
 * `open` → member, `discord_role` → `JoinRequestService.joinByDiscordRole`,
 * `approval` → `JoinRequestService.request` (which auto-approves on its own).
 *
 * Room resolution deliberately does NOT use `resolveGuildReadScope`: that scope
 * hides approval rooms the user is not a member of, which is exactly the case
 * this command serves. Rooms come from `DISCORD_GUILD_ID` (plus the legacy env
 * fallback, same precedence as `discordWriteTarget.ts`), minus Discord-off
 * rooms. Suspended rooms are kept so the player is told why they can't join.
 */

const PENDING = (name: string) =>
    `Request sent to **${name}**'s admins — you'll be able to play once it's approved.`;

interface LinkedRoom {
    id: string;
    name: string;
    slug: string;
}

/** Rooms linked to `guildId`, minus rooms with Discord switched off. */
export async function roomsLinkedToGuild(guildId: string): Promise<LinkedRoom[]> {
    const db = await getDatabase();
    const configuredRows = await db.all(
        `SELECT game_room_id, value AS guild_id FROM game_room_settings WHERE key = 'DISCORD_GUILD_ID'`,
    ) as Array<{ game_room_id: string; guild_id: string }>;
    const configuredRoomIds = new Set(configuredRows.map(r => r.game_room_id));
    let roomIds = configuredRows.filter(r => r.guild_id === guildId).map(r => r.game_room_id);

    if (guildId === process.env.DISCORD_GUILD_ID) {
        const allRoomRows = await db.all(`SELECT id FROM game_rooms`) as Array<{ id: string }>;
        const envFallback = allRoomRows.map(r => r.id).filter(id => !configuredRoomIds.has(id));
        roomIds = Array.from(new Set([...roomIds, ...envFallback]));
    }
    if (roomIds.length === 0) return [];

    const discordOff = new Set((await db.all(
        `SELECT game_room_id FROM game_room_settings WHERE key = 'DISCORD_ENABLED' AND value = 'false'`,
    ) as Array<{ game_room_id: string }>).map(r => r.game_room_id));
    roomIds = roomIds.filter(id => !discordOff.has(id));
    if (roomIds.length === 0) return [];

    const placeholders = roomIds.map(() => '?').join(', ');
    return db.all<LinkedRoom[]>(
        `SELECT id, name, slug FROM game_rooms WHERE id IN (${placeholders}) ORDER BY name COLLATE NOCASE`,
        ...roomIds,
    );
}

/** One line of the reply for one room. */
async function joinOne(userId: string, room: LinkedRoom): Promise<string> {
    const joined = `Joined **${room.name}** — ${roomUrl(room.slug)}/`;

    if (await RoomAccessService.isSuspended(room.id)) {
        return `**${room.name}**: This room has been suspended pending review.`;
    }
    try {
        const ban = await BanService.isIdentityBanned(userId, room.id);
        if (ban.banned) return `You can't join **${room.name}**.`;
    } catch (err) {
        // Same fail-open as `requireNotBanned`, never silent.
        logError('/join: ban check failed open', err);
    }
    if (await RoomMembershipService.isMember(userId, room.id)) {
        return `You're already a member of **${room.name}** — ${roomUrl(room.slug)}/`;
    }

    const policy = await RoomAccessService.getJoinPolicy(room.id);

    if (policy === 'discord_role') {
        const outcome = await JoinRequestService.joinByDiscordRole(room.id, userId);
        if (outcome.status === 'member') return joined;
        if (outcome.status === 'role_required') {
            const roleText = outcome.roleNames.length > 0
                ? `the Discord role ${formatRoleList(outcome.roleNames)}`
                : 'a Discord role this room requires';
            return `Only members with ${roleText} in this server can join **${room.name}**.`;
        }
        // 'pending', and 'link_required' (cannot happen for a Discord user).
        return PENDING(room.name);
    }

    if (policy === 'approval') {
        const outcome = await JoinRequestService.request(room.id, userId);
        if (outcome === 'member') {
            return `Joined **${room.name}** — you were auto-approved. ${roomUrl(room.slug)}/`;
        }
        return PENDING(room.name);
    }

    // 'open'. addMember swallows its own DB errors, so confirm the row landed
    // before reporting success (same persisted-check as the web route).
    await RoomMembershipService.addMember(userId, room.id, 'self_join');
    if (!(await RoomMembershipService.isMember(userId, room.id))) {
        logError('/join: addMember did not persist', new Error(`join failed for room=${room.id}`));
        return `Couldn't join **${room.name}** right now — try again, or join on the web: ${roomUrl(room.slug)}/`;
    }
    return joined;
}

export const join: Command = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Join the Arcaid room linked to this server.'),

    async execute(interaction: ChatInputCommandInteraction) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({ content: 'This command only works inside a server.', ephemeral: true });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            const rooms = await roomsLinkedToGuild(guildId);
            if (rooms.length === 0) {
                await interaction.editReply('No Arcaid room is linked to this Discord server.');
                return;
            }
            const lines: string[] = [];
            for (const room of rooms) {
                lines.push(await joinOne(interaction.user.id, room));
            }
            await interaction.editReply(lines.join('\n'));
        } catch (error) {
            logError('Error in /join command:', error);
            await interaction.editReply('Something went wrong joining the room. Try the room page on the web.');
        }
    },
};
