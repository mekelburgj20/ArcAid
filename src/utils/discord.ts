import { REST, Routes, EmbedBuilder } from 'discord.js';
import { logError } from './logger.js';
import { TournamentType } from '../types/index.js';

/** Embed accent colors keyed by tournament type. */
export const TOURNAMENT_COLORS: Record<TournamentType | 'default', number> = {
    daily:   0xFFD700,  // gold
    weekly:  0x00BFFF,  // sky blue
    monthly: 0xAA00FF,  // purple
    custom:  0x00FF88,  // green
    default: 0x888888,  // gray
};

/** Returns the embed color for a tournament type string. */
export function getTournamentColor(type?: string | null): number {
    if (type && type in TOURNAMENT_COLORS) return TOURNAMENT_COLORS[type as TournamentType];
    return TOURNAMENT_COLORS.default;
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
