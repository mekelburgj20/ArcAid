import 'dotenv/config';
import { logInfo, logError } from './utils/logger.js';
import { initDatabase } from './database/database.js';
import { DiscordClient } from './discord/DiscordClient.js';
import { startApiServer } from './api/server.js';

async function bootstrap() {
    logInfo('🚀 Starting ArcAid...');

    try {
        // 1. Initialize Database
        await initDatabase();
        logInfo('✅ Database initialized.');

        // 2. Start API Server for Admin UI
        startApiServer(3001);

        // 3. Initialize Discord Client
        const discord = new DiscordClient();
        
        // 4. Deploy Commands (Guild-specific for beta testing)
        const guildId = process.env.DISCORD_GUILD_ID;
        if (guildId) {
            await discord.deployCommands(guildId);
        } else {
            logError('⚠️ DISCORD_GUILD_ID not found in .env. Skipping guild-specific command deployment.');
        }

        // 5. Connect to Discord
        await discord.connect();

    } catch (error) {
        logError('❌ Critical failure during bootstrap:', error);
        process.exit(1);
    }
}

bootstrap();
