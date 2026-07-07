import { SettingsService } from './SettingsService.js';
import { sendDirectMessage } from '../utils/discord.js';
import { logError, logWarn, logInfo } from '../utils/logger.js';

/**
 * Server-level operator alerting for S10. Fires a Discord DM to a configured
 * super-admin when infrastructure degrades (e.g. N consecutive ScoreSyncPoller
 * failures for one iScored account).
 *
 * Ships INERT: does nothing unless `OPS_ALERT_ENABLED=true` AND
 * `OPS_ALERT_DISCORD_USER_ID` is set in global settings (mirrors the S6
 * `NOTIFY_HIGH_VALUE_DEFAULT_ON` flag pattern — no seed row, resolves off).
 * Never throws into the caller — alerting must not break the path that
 * triggered it.
 */
export class OpsAlertService {
    static async sendOperatorAlert(text: string): Promise<void> {
        try {
            const enabled = (await SettingsService.get('OPS_ALERT_ENABLED')) === 'true';
            if (!enabled) return;

            const userId = await SettingsService.get('OPS_ALERT_DISCORD_USER_ID');
            if (!userId) {
                logWarn('OpsAlertService: OPS_ALERT_ENABLED=true but OPS_ALERT_DISCORD_USER_ID is unset — alert dropped.');
                return;
            }

            const ok = await sendDirectMessage(userId, `⚠️ ArcAid ops alert\n\n${text}`);
            if (ok) {
                logInfo('OpsAlertService: operator alert DM sent.');
            } else {
                logWarn('OpsAlertService: sendDirectMessage returned false (alert not delivered).');
            }
        } catch (err) {
            logError('OpsAlertService.sendOperatorAlert failed (non-fatal):', err);
        }
    }
}
