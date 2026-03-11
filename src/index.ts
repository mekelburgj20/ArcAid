import 'dotenv/config';
import { logInfo, logError } from './utils/logger.js';
import { initDatabase, getDatabase } from './database/database.js';
import { DiscordClient } from './discord/DiscordClient.js';
import { startApiServer } from './api/server.js';
import { serverEvents } from './api/server.js';
import { validateEnvironment } from './utils/startup.js';
import { Scheduler } from './engine/Scheduler.js';

async function bootstrap() {
    logInfo('Starting ArcAid...');

    try {
        // 1. Initialize Database
        await initDatabase();
        logInfo('Database initialized.');

        // 1.5 Load settings from DB into environment
        const db = await getDatabase();
        const settings = await db.all('SELECT key, value FROM settings');
        for (const row of settings) {
            process.env[row.key] = row.value;
        }

        // 1.6 Validate environment configuration
        const { canStartBot } = validateEnvironment();

        // 2. Start API Server for Admin UI
        const port = parseInt(process.env.PORT || '3001', 10);
        startApiServer(port);

        // BUG-05: Listen for graceful restart signal from server
        serverEvents.on('restart', async () => {
            logInfo('Graceful restart initiated...');
            await new Promise(r => setTimeout(r, 1000));
            process.exit(0); // Docker/PM2 will restart
        });

        // 3. Initialize Discord Client (if configured)
        if (canStartBot) {
            const discord = new DiscordClient();

            // 4. Deploy Commands (Guild-specific for beta testing)
            const guildId = process.env.DISCORD_GUILD_ID;
            if (guildId) {
                await discord.deployCommands(guildId);
            } else {
                logError('DISCORD_GUILD_ID not found in DB or .env. Skipping guild-specific command deployment.');
            }

            // 5. Connect to Discord
            await discord.connect();

            // 6. Start Scheduler (cron maintenance + timeout checker)
            await Scheduler.getInstance().start();
        }

    } catch (error) {
        logError('Critical failure during bootstrap:', error);
        process.exit(1);
    }
}

bootstrap();
