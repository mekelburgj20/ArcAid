import { getDatabase } from '../database/database.js';
import { NotificationService } from './NotificationService.js';

/**
 * Per-room "don't remind me again" for the Discord link banner (2026-08-17).
 *
 * The banner's dismiss button is a 30-day snooze — the owner wants linking
 * encouraged, not silenced by one stray click. This is the OTHER control: an
 * explicit, permanent opt-out the player has to tick on purpose. Two different
 * intentions ("not now" vs "never"), so two different mechanisms.
 *
 * STORAGE: the `_discordLinkOptOut` key inside `user_preferences.
 * notification_prefs`, following the same convention as `_dmNudge` and
 * `_hvFooterShown` — an underscore-prefixed internal marker in a blob the
 * settings page already loads. NO MIGRATION REQUIRED. `mergePrefs` is the
 * single writer, and the settings PUT's typed-key allowlist means a
 * user-crafted body cannot forge or clear it.
 *
 * Scoped per room because the banner names a room: opting out of one room's
 * reminders must not silence a different room the player does care about.
 * Stored server-side (not localStorage) so the choice follows them across
 * devices — a player who says "never" should not be asked again on their phone.
 */

const OPT_OUT_KEY = '_discordLinkOptOut';

type OptOutMap = Record<string, string>;

function parseMap(value: unknown): OptOutMap {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: OptOutMap = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
    }
    return out;
}

export class DiscordLinkNudgeService {
    /** Whether this player has permanently opted out for this room. Never throws. */
    static async hasOptedOut(userId: string, roomId: string): Promise<boolean> {
        try {
            if (!userId || !roomId) return false;
            const db = await getDatabase();
            const row = await db.get(
                'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
                userId,
            );
            if (!row?.notification_prefs) return false;
            return !!parseMap(JSON.parse(row.notification_prefs)?.[OPT_OUT_KEY])[roomId];
        } catch {
            // A read failure must never turn into "show the banner forever".
            return false;
        }
    }

    /** Record the permanent opt-out for this room. Best-effort, never throws. */
    static async optOut(userId: string, roomId: string): Promise<void> {
        try {
            if (!userId || !roomId) return;
            const db = await getDatabase();
            const row = await db.get(
                'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
                userId,
            );
            const existing = row?.notification_prefs
                ? parseMap(JSON.parse(row.notification_prefs)?.[OPT_OUT_KEY])
                : {};
            if (existing[roomId]) return;   // already opted out; don't churn the row
            await NotificationService.mergePrefs(userId, {
                [OPT_OUT_KEY]: { ...existing, [roomId]: new Date().toISOString() },
            });
        } catch {
            // swallow — see class doc
        }
    }

    /** Undo the opt-out (there is no UI for this yet; kept so the state is reversible). */
    static async clear(userId: string, roomId: string): Promise<void> {
        try {
            if (!userId || !roomId) return;
            const db = await getDatabase();
            const row = await db.get(
                'SELECT notification_prefs FROM user_preferences WHERE discord_user_id = ?',
                userId,
            );
            if (!row?.notification_prefs) return;
            const existing = parseMap(JSON.parse(row.notification_prefs)?.[OPT_OUT_KEY]);
            if (!existing[roomId]) return;
            delete existing[roomId];
            await NotificationService.mergePrefs(userId, { [OPT_OUT_KEY]: existing });
        } catch {
            // swallow
        }
    }
}
