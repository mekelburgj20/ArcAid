import 'dotenv/config';
import { logInfo, logError } from './utils/logger.js';
import { initDatabase, getDatabase } from './database/database.js';
import { DiscordClient } from './discord/DiscordClient.js';
import { startApiServer } from './api/server.js';

async function bootstrap() {
    logInfo('🚀 Starting ArcAid...');

    try {
        // 1. Initialize Database
        await initDatabase();
        logInfo('✅ Database initialized.');

        // 1.5 Load settings from DB into environment
        const db = await getDatabase();
        const settings = await db.all('SELECT key, value FROM settings');
        for (const row of settings) {
            // Only set if not already set by .env (or override it, up to you. Overriding is probably better for UI changes)
            process.env[row.key] = row.value;
        }

        // 2. Start API Server for Admin UI
        startApiServer(3001);

        // 3. Initialize Discord Client (Optional if not configured yet)
        if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID) {
            const discord = new DiscordClient();
            
            // 4. Deploy Commands (Guild-specific for beta testing)
            const guildId = process.env.DISCORD_GUILD_ID;
            if (guildId) {
                await discord.deployCommands(guildId);
            } else {
                logError('⚠️ DISCORD_GUILD_ID not found in DB or .env. Skipping guild-specific command deployment.');
            }

            // 5. Connect to Discord
            await discord.connect();
        } else {
            logError('⚠️ Discord credentials missing. Bot will not connect. Please use the Admin UI to configure them.');
        }

    } catch (error) {
        logError('❌ Critical failure during bootstrap:', error);
        process.exit(1);
    }
}

bootstrap();
