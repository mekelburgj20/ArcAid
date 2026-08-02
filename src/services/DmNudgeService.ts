import { getDatabase } from '../database/database.js';
import { isDiscordUserId } from '../utils/identityProvider.js';
import { NotificationService } from './NotificationService.js';

/**
 * "We couldn't DM you" nudge state (Discord HQ arc, v2.72.0, Section 4).
 *
 * When a Discord DM fails because the user and the bot share no guild — or
 * share one but the user has DMs from server members switched off (error
 * 50007) — nothing surfaces anywhere: `sendDirectMessage` swallows the failure
 * by design so a dead DM can never break a score submission. The player just
 * quietly never hears from Arcaid again. This records that fact so the web app
 * can tell them once, with an honest explanation and two ways out.
 *
 * STORAGE DECISION (the contract left this to the implementer): the flag lives
 * on `user_preferences.notification_prefs` under the `_dmNudge` key, NOT in a
 * new table. Reasons: it is one nullable value per user, always read alongside
 * the notification prefs the settings page already loads, and it follows the
 * existing convention for internal markers in that blob (`_hvFooterShown`).
 * `NotificationService.mergePrefs` is the single writer, and the PUT route's
 * typed-keys allowlist means no user-supplied body can forge or clear it.
 * NO MIGRATION IS REQUIRED — the column already exists and holds free-form JSON.
 */

/** Key inside the notification_prefs JSON blob. Underscore = internal marker. */
const NUDGE_KEY = '_dmNudge';

export interface DmNudge {
    /** ISO timestamp of the failed (or skipped-as-hopeless) delivery. */
    failedAt: string;
    /** Notification type we were trying to deliver, when the caller knew it. */
    type?: string;
    /**
     * How we learned it wouldn't land:
     *   'send_failed' — Discord rejected an actual send attempt.
     *   'unreachable' — we knew before sending that no shared guild exists, so
     *                   no attempt was made (Section 5's pre-failed case).
     */
    reason: 'send_failed' | 'unreachable';
}

function isNudge(value: unknown): value is DmNudge {
    return !!value && typeof value === 'object' && typeof (value as DmNudge).failedAt === 'string';
}

export class DmNudgeService {
    /**
     * Record that a DM could not be delivered. Best-effort and never throws —
     * every caller is on a path whose whole contract is "a failed DM must not
     * break anything".
     */
    static async record(
        userId: string,
        reason: DmNudge['reason'],
        type?: string,
    ): Promise<void> {
        try {
            if (!userId || !isDiscordUserId(userId)) return;
            const existing = await this.get(userId);
            // Keep the FIRST failure's timestamp: the banner is a one-time
            // "something is wrong" signal, not a running failure log, and
            // refreshing the date on every retry would make a long-standing
            // problem look like it just started.
            if (existing) return;
            const nudge: DmNudge = { failedAt: new Date().toISOString(), reason, ...(type ? { type } : {}) };
            await NotificationService.mergePrefs(userId, { [NUDGE_KEY]: nudge });
        } catch {
            // swallow — see class doc
        }
    }

    /** Read the pending nudge for a user, or null. Never throws. */
    static async get(userId: string): Promise<DmNudge | null> {
        try {
            if (!userId) return null;
            const db = await getDatabase();
            const row = await db.get(
                'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
                userId,
            );
            if (!row?.notification_prefs) return null;
            const parsed = JSON.parse(row.notification_prefs);
            const value = parsed?.[NUDGE_KEY];
            return isNudge(value) ? value : null;
        } catch {
            return null;
        }
    }

    /**
     * Clear the flag — on the next successful DM (the problem fixed itself, or
     * the user joined HQ) or when they dismiss the banner. Best-effort.
     *
     * Skips the write when nothing is set, so the success path of every DM does
     * not turn into an unconditional row upsert for users who never failed.
     */
    static async clear(userId: string): Promise<void> {
        try {
            if (!userId) return;
            if (!(await this.get(userId))) return;
            await NotificationService.mergePrefs(userId, { [NUDGE_KEY]: null });
        } catch {
            // swallow — see class doc
        }
    }
}
