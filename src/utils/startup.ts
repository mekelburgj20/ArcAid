import { logInfo, logWarn, logError } from './logger.js';

interface EnvCheck {
    key: string;
    required: boolean;
    description: string;
}

const ENV_CHECKS: EnvCheck[] = [
    { key: 'DISCORD_BOT_TOKEN', required: false, description: 'Discord bot token (set in .env or Admin UI settings)' },
    { key: 'DISCORD_CLIENT_ID', required: false, description: 'Discord application client ID' },
    { key: 'DISCORD_GUILD_ID', required: false, description: 'Discord server (guild) ID for command deployment' },
    { key: 'ISCORED_USERNAME', required: false, description: 'iScored login username' },
    { key: 'ISCORED_PASSWORD', required: false, description: 'iScored login password' },
    { key: 'ISCORED_PUBLIC_URL', required: false, description: 'iScored public leaderboard URL' },
];

/**
 * Validates startup configuration and logs warnings for missing values.
 * Returns true if the minimum required config is present to start the bot.
 * The bot can always start (to serve the Admin UI for initial setup), but
 * this logs clear messages about what's missing.
 */
export function validateEnvironment(): { canStartBot: boolean; canConnectIScored: boolean } {
    const missing: string[] = [];
    const warnings: string[] = [];

    for (const check of ENV_CHECKS) {
        const value = process.env[check.key];
        if (!value || value.trim() === '') {
            if (check.required) {
                missing.push(`  - ${check.key}: ${check.description}`);
            } else {
                warnings.push(`  - ${check.key}: ${check.description}`);
            }
        }
    }

    const canStartBot = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);
    const canConnectIScored = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);

    if (missing.length > 0) {
        logError(`ArcAid cannot start: Missing required configuration:\n${missing.join('\n')}`);
    }

    if (!canStartBot) {
        logWarn('Discord credentials not configured. Bot will not connect. Use the Admin UI to configure them.');
    }

    if (!canConnectIScored) {
        logWarn('iScored credentials not configured. Automated scoring will be disabled.');
    }

    if (warnings.length > 0 && (canStartBot || canConnectIScored)) {
        logInfo(`Optional configuration not set:\n${warnings.join('\n')}`);
    }

    if (canStartBot && canConnectIScored) {
        logInfo('All configuration validated successfully.');
    }

    return { canStartBot, canConnectIScored };
}
