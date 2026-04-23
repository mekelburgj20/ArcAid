import { REST, Routes, EmbedBuilder } from 'discord.js';
import { logError } from './logger.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

/** Embed accent colors keyed by tournament tag or type. */
const TAG_COLORS: Record<string, number> = {
    // By tag
    'DG':      0xFFD700,  // gold
    'WG-VPXS': 0x00BFFF,  // sky blue
    'WG-VR':   0xAA00FF,  // purple
    'MG':      0x00FF88,  // green
    // By generic type (fallback)
    'daily':   0xFFD700,
    'weekly':  0x00BFFF,
    'monthly': 0xAA00FF,
    'custom':  0x00FF88,
};

/** Returns the embed color for a tournament type/tag string. */
export function getTournamentColor(type?: string | null): number {
    if (!type) return 0x888888;
    const upper = type.toUpperCase();
    return TAG_COLORS[upper] ?? TAG_COLORS[type] ?? 0x888888;
}

/**
 * Sends a plain-text message to a Discord channel via the REST API.
 * Safe to call from engine classes that don't have access to the Client instance.
 */
export async function sendChannelMessage(channelId: string, content: string): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord message: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), { body: { content } });
    } catch (err) {
        logError(`Failed to send message to channel ${channelId}:`, err);
    }
}

/**
 * Sends a direct message to a Discord user via the REST API.
 * Creates a DM channel first, then sends the message.
 * Returns true if sent, false on failure (silent — does not throw).
 */
export async function sendDirectMessage(userId: string, content: string): Promise<boolean> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord DM: DISCORD_BOT_TOKEN is not set.');
        return false;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const channel = await rest.post(Routes.userChannels(), {
            body: { recipient_id: userId },
        }) as { id: string };
        await rest.post(Routes.channelMessages(channel.id), { body: { content } });
        return true;
    } catch (err) {
        logError(`Failed to send DM to user ${userId}:`, err);
        return false;
    }
}

/**
 * Resolves a Discord username to a user ID by searching guild members.
 * Accepts a numeric ID (returned as-is) or a username/handle (searched in the guild).
 * Returns the numeric user ID or null if not found.
 */
export async function resolveDiscordUserId(input: string, guildId?: string): Promise<string | null> {
    // If it's already a numeric ID, return as-is
    if (/^\d{17,20}$/.test(input)) return input;

    // Strip leading @ if present
    const username = input.replace(/^@/, '');

    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token || !guildId) return null;

    try {
        const rest = new REST({ version: '10' }).setToken(token);
        const results = await rest.get(Routes.guildMembersSearch(guildId), {
            query: new URLSearchParams({ query: username, limit: '5' }),
        }) as Array<{ user: { id: string; username: string; global_name?: string } }>;

        // Exact match on username or global_name (case-insensitive)
        const lower = username.toLowerCase();
        const match = results.find(m =>
            m.user.username.toLowerCase() === lower ||
            (m.user.global_name && m.user.global_name.toLowerCase() === lower)
        );
        return match?.user.id ?? null;
    } catch (err) {
        logError(`Failed to resolve Discord username "${input}" in guild ${guildId}:`, err);
        return null;
    }
}

/**
 * Sends a rich embed to a Discord channel via the REST API.
 */
export async function sendChannelEmbed(channelId: string, embed: EmbedBuilder): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('Cannot send Discord embed: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), {
            body: { embeds: [embed.toJSON()] },
        });
    } catch (err) {
        logError(`Failed to send embed to channel ${channelId}:`, err);
    }
}

/**
 * Returns a Discord mention `<@userId>` if mentions are enabled for the room,
 * otherwise returns the fallback display name (plain text, no ping).
 */
export async function formatUserMention(userId: string, fallbackName: string, gameRoomId?: string | null): Promise<string> {
    if (gameRoomId) {
        const setting = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_MENTIONS_ENABLED');
        if (setting === 'false') {
            return `**${fallbackName}**`;
        }
    }
    return `<@${userId}>`;
}

/**
 * Returns true when Discord announcements + actions should happen for the
 * given room. Controlled by the per-room `DISCORD_ENABLED` toggle (default
 * true). A `null`/`undefined` roomId is treated as enabled — keeps legacy
 * single-room flows working.
 */
export async function isDiscordEnabledForRoom(gameRoomId?: string | null): Promise<boolean> {
    if (!gameRoomId) return true;
    const raw = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ENABLED');
    return raw !== 'false';
}

/**
 * Resolves the Discord channel that announcements for a tournament in this
 * room should target. Precedence: tournament-specific channel → per-room
 * `DISCORD_ANNOUNCEMENT_CHANNEL_ID` → env fallback. Returns `null` when the
 * room has DISCORD_ENABLED=false or no channel can be resolved.
 */
export async function resolveAnnouncementChannelId(
    gameRoomId: string | null | undefined,
    tournamentChannelId: string | null | undefined,
): Promise<string | null> {
    if (!(await isDiscordEnabledForRoom(gameRoomId))) return null;
    if (tournamentChannelId) return tournamentChannelId;
    if (gameRoomId) {
        const perRoom = await GameRoomSettingsService.get(gameRoomId, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID');
        if (perRoom) return perRoom;
    }
    return process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID ?? null;
}
