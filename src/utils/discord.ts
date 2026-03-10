import { REST, Routes, EmbedBuilder } from 'discord.js';
import { logError } from './logger.js';

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
        logError('❌ Cannot send Discord message: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), { body: { content } });
    } catch (err) {
        logError(`❌ Failed to send message to channel ${channelId}:`, err);
    }
}

/**
 * Sends a rich embed to a Discord channel via the REST API.
 */
export async function sendChannelEmbed(channelId: string, embed: EmbedBuilder): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
        logError('❌ Cannot send Discord embed: DISCORD_BOT_TOKEN is not set.');
        return;
    }
    try {
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.post(Routes.channelMessages(channelId), {
            body: { embeds: [embed.toJSON()] },
        });
    } catch (err) {
        logError(`❌ Failed to send embed to channel ${channelId}:`, err);
    }
}
