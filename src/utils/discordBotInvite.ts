/**
 * The "add the Arcaid bot to your server" link (G6).
 *
 * Setting a room's Guild ID does not put the bot in that server — someone with
 * Manage Server has to authorize it once. This builds the one invite URL every
 * surface shows (room Settings, the onboarding message), so the permission set
 * lives in one place.
 */

/**
 * View Channels (1024) + Send Messages (2048) + Embed Links (16384)
 * + Attach Files (32768) + Read Message History (65536) + Send Polls (1 << 49,
 * season polls). Slash commands come from the `applications.commands` scope.
 */
export const BOT_INVITE_PERMISSIONS = '562949953539072';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * The bot invite URL for the global Discord application, or null when no
 * client id is configured. `guildId`, when it looks like a Discord id,
 * pre-selects that server in Discord's picker (the person can still change it).
 */
export function buildBotInviteUrl(clientId: string | null | undefined, guildId?: string | null): string | null {
    const id = clientId?.trim();
    if (!id) return null;
    const params = new URLSearchParams({
        client_id: id,
        scope: 'bot applications.commands',
        permissions: BOT_INVITE_PERMISSIONS,
    });
    const guild = guildId?.trim();
    if (guild && SNOWFLAKE.test(guild)) params.set('guild_id', guild);
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
