import { sendDirectMessage } from '../utils/discord.js';
import { isDiscordUserId } from '../utils/identityProvider.js';
import { logError, logInfo } from '../utils/logger.js';

/**
 * Ban → Discord DM (ROADMAP "Player Self-Service + Moderation" §C, "Ban →
 * Discord notification"). Best-effort DM to a banned user telling them the
 * scope, reason, and expiry.
 *
 * Deliberately bypasses `NotificationService.notify`'s opt-in/pref gating —
 * a ban notice is a moderation action, not a preference-gated retention
 * event, so it must reach the user even if they've turned every DM type off.
 * Uses the same raw `sendDirectMessage` helper `OpsAlertService` uses for the
 * identical reason (an operator alert also has to bypass per-user prefs).
 *
 * Never throws — a DM failure (closed DMs, no shared guild, bot offline,
 * `DISCORD_BOT_TOKEN` unset) must never fail the ban itself.
 */
export interface BanNotificationParams {
    /** Must be a bare Discord snowflake — callers resolve the identity-link
     *  graph down to a DM-able id (or skip entirely) before calling this. */
    discordUserId: string;
    /** "the \"Room Name\" room" or "all of Arcaid". */
    scopeLabel: string;
    reason?: string | null;
    /** ISO 8601 string, or null/undefined for a permanent ban. */
    expiresAt?: string | null;
}

export class BanNotificationService {
    static async sendBanDM(params: BanNotificationParams): Promise<boolean> {
        try {
            const { discordUserId, scopeLabel, reason, expiresAt } = params;

            // Non-Discord identities (e.g. a `google:*` id with no linked
            // Discord account) have no DM channel — silent skip, no wasted
            // REST call. Callers are expected to have already walked the
            // identity-link graph for a DM-able alias; this is a defensive
            // second check.
            if (!isDiscordUserId(discordUserId)) {
                logInfo(`BanNotificationService: skip DM — ${discordUserId} is not a Discord identity.`);
                return false;
            }

            const expiryLine = expiresAt
                ? `Expires: ${new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`
                : 'Duration: permanent';
            const reasonLine = `Reason: ${reason?.trim() || 'No reason given'}`;
            const message = [
                `\u{1F6AB} **You have been banned from ${scopeLabel}.**`,
                reasonLine,
                expiryLine,
            ].join('\n');

            const sent = await sendDirectMessage(discordUserId, message);
            if (sent) {
                logInfo(`BanNotificationService: sent ban DM to ${discordUserId} (scope: ${scopeLabel}).`);
            } else {
                logInfo(`BanNotificationService: ban DM to ${discordUserId} not delivered (closed DMs, unreachable, or bot unconfigured).`);
            }
            return sent;
        } catch (err) {
            logError('BanNotificationService.sendBanDM failed (non-fatal — ban still applies):', err);
            return false;
        }
    }
}
