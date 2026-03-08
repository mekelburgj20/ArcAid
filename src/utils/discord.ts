import { REST, Routes } from 'discord.js';
import { logError } from './logger.js';

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
