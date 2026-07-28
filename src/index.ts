import 'dotenv/config';
import { logInfo, logError } from './utils/logger.js';
import { initDatabase, getDatabase } from './database/database.js';
import { DiscordClient } from './discord/DiscordClient.js';
import { startApiServer } from './api/server.js';
import { serverEvents } from './api/server.js';
import { validateEnvironment } from './utils/startup.js';
import { Scheduler } from './engine/Scheduler.js';
import { ScoreSyncPoller } from './engine/ScoreSyncPoller.js';

async function bootstrap() {
    logInfo('Starting Arcaid...');

    try {
        // 1. Initialize Database
        await initDatabase();
        logInfo('Database initialized.');

        // 1.4 Encrypt any legacy plaintext secret rows, fail fast if SECRETS_KEY
        //     is missing while encrypted rows exist. Also hash any plaintext
        //     refresh tokens in sessions (no SECRETS_KEY required — sha256 only).
        const db = await getDatabase();
        const { runSecretsMigration, loadSettingsToEnv, migrateRefreshTokensToHashed } =
            await import('./utils/secretsMigration.js');
        await migrateRefreshTokensToHashed(db);
        await runSecretsMigration(db);

        // 1.5 Load settings from DB into environment (decrypts secret keys
        //     so downstream env reads see plaintext, never ciphertext).
        await loadSettingsToEnv(db);

        // 1.6 Clear stale leaderboard cache
        await db.run('DELETE FROM leaderboard_cache');

        // 1.7 Auto-import style catalogue if table is empty and scraped data exists
        try {
            const styleCount = await db.get('SELECT COUNT(*) as count FROM style_catalogue');
            if (styleCount?.count === 0) {
                const { StyleCatalogueService } = await import('./services/StyleCatalogueService.js');
                const result = await StyleCatalogueService.importFromScraped();
                logInfo(`Auto-imported ${result.imported} styles into catalogue.`);
            }
        } catch (err) {
            // Non-fatal — styles can be imported later via admin UI
            logInfo('Style catalogue auto-import skipped (scraped data not found or already populated).');
        }

        // 1.8 Validate environment configuration
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

        // 3. Initialize Discord Client (if configured) — non-fatal; API stays up on failure
        if (canStartBot) {
            try {
                const discord = new DiscordClient();

                // 4. Deploy slash commands globally so they work in every guild
                //    the bot joins — no per-room redeploys when a room swaps
                //    its Discord server. Global commands take up to 1 hour to
                //    propagate; fine for real-world config changes, which are
                //    rare. Old per-guild registrations remain until Discord
                //    garbage-collects them.
                await discord.deployCommands();

                // 5. Connect to Discord
                await discord.connect();

                // 6. Start Scheduler (cron maintenance + timeout checker)
                await Scheduler.getInstance().start();
            } catch (discordErr) {
                logError('Discord initialization failed — API will run without Discord. Check DISCORD_BOT_TOKEN.', discordErr);
            }
        }

        // 7. Start iScored API score poller. The poller now iterates over every
        //    room's configured iScored account (per-room creds → env fallback),
        //    so it's safe to start even when env-level ISCORED_PUBLIC_URL is
        //    absent — rooms with their own creds still get polled. The poller
        //    itself no-ops when no rooms have iScored enabled.
        //
        //    The 10s tick is the cadence at which we check iScored's static
        //    notification .txt file per account; the costly getAllScores call
        //    only fires when that file has changed (or every backstop window,
        //    default 10 min, controlled by ISCORED_API_POLL_BACKSTOP_MS).
        if (process.env.ISCORED_API_ENABLED !== 'false') {
            const intervalSec = parseInt(process.env.ISCORED_API_POLL_INTERVAL || '10', 10);
            ScoreSyncPoller.getInstance().start(intervalSec * 1000);
        }

    } catch (error) {
        logError('Critical failure during bootstrap:', error);
        process.exit(1);
    }
}

bootstrap();
