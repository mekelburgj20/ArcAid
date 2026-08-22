import { getDatabase } from '../database/database.js';

export type ThemeId = 'dark' | 'light' | 'retro' | 'cyberpunk' | 'ocean' | 'sunset' | 'minimal' | 'invaders' | 'coffee' | 'backglass' | 'crt-green' | 'plasma' | 'cabinet' | 'silverball' | 'wizard' | 'playfield' | 'marquee';

/**
 * Scoreboard display preferences that users can override. Keys match room
 * setting names (e.g. SCOREBOARD_STYLE, SCOREBOARD_THEME). When a user has a
 * preference set, it takes precedence over the room admin default for that
 * user's view only.
 */
export type ScoreboardPrefs = Record<string, string>;

/**
 * v2.130.0 — viewer-level light/dark polarity override, orthogonal to
 * `ui_theme`. `'auto'` (stored as NULL) is the historical behaviour: room
 * pages render the room's theme, global pages follow prefers-color-scheme,
 * admin pages the admin's `ui_theme`. `'light'`/`'dark'` force that polarity
 * on EVERY page as the last step of theme resolution (see the frontend's
 * `THEME_POLARITY` in admin-ui/src/components/ThemeProvider.tsx).
 */
export type Appearance = 'dark' | 'light' | 'auto';

const APPEARANCES: readonly string[] = ['dark', 'light', 'auto'];

export type DeviceType = 'desktop' | 'mobile';

/** Stored format: { desktop: {...}, mobile: {...} } */
type DevicePrefs = { desktop: ScoreboardPrefs; mobile: ScoreboardPrefs };

export class PreferencesService {
    static async getTheme(discordUserId: string): Promise<ThemeId | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT ui_theme FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        const theme = row?.ui_theme;
        if (!theme) return null;
        return (theme === 'arcade' ? 'dark' : theme) as ThemeId;
    }

    static async setTheme(discordUserId: string, theme: ThemeId | null): Promise<void> {
        const db = await getDatabase();
        if (!theme) {
            // v2.130.0: clearing the theme NULLs the one column, it no longer
            // DELETEs the row. The row also carries `appearance`,
            // `scoreboard_prefs`, `notification_prefs` and `tutorial_seen_at`
            // — dropping all of those because a user reset their admin theme
            // is collateral damage nobody asked for.
            await db.run(
                'UPDATE user_preferences SET ui_theme = NULL WHERE discord_user_id = ?',
                discordUserId
            );
        } else {
            await db.run(
                `INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET ui_theme = excluded.ui_theme`,
                discordUserId, theme
            );
        }
    }

    /** Stored appearance, or null when the user has never chosen (= 'auto'). */
    static async getAppearance(discordUserId: string): Promise<Appearance | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT appearance FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        const value = row?.appearance;
        if (!value || !APPEARANCES.includes(value)) return null;
        return value as Appearance;
    }

    /**
     * Persists the appearance override. `'auto'` and `null` both store NULL —
     * "follow each surface's own theme" is the absence of an override, so
     * there is no third state to distinguish.
     */
    static async setAppearance(discordUserId: string, appearance: Appearance | null): Promise<void> {
        const db = await getDatabase();
        const stored = !appearance || appearance === 'auto' ? null : appearance;
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, appearance) VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET appearance = excluded.appearance`,
            discordUserId, stored
        );
    }

    static async getAll(discordUserId: string): Promise<{ ui_theme: ThemeId | null; appearance: Appearance | null }> {
        const theme = await this.getTheme(discordUserId);
        const appearance = await this.getAppearance(discordUserId);
        return { ui_theme: theme, appearance };
    }

    /**
     * First-login player tutorial (v2.48.0) — dedicated nullable column, same
     * pattern as ui_theme (NOT the notification_prefs shared-JSON-blob
     * pattern). Nullable ISO timestamp rather than a boolean so a future
     * "reset tutorial" admin action can re-show it by clearing the column.
     */
    static async getTutorialSeenAt(discordUserId: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT tutorial_seen_at FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        return row?.tutorial_seen_at ?? null;
    }

    /** Sets tutorial_seen_at to now. Idempotent — safe to call repeatedly. */
    static async markTutorialSeen(discordUserId: string): Promise<string> {
        const db = await getDatabase();
        const now = new Date().toISOString();
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, tutorial_seen_at) VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET tutorial_seen_at = excluded.tutorial_seen_at`,
            discordUserId, now
        );
        return now;
    }

    /**
     * Parse the stored JSON into device-keyed format.
     * Handles migration from old flat format → nested { desktop, mobile }.
     */
    private static parseDevicePrefs(raw: string | null | undefined): DevicePrefs {
        if (!raw) return { desktop: {}, mobile: {} };
        try {
            const parsed = JSON.parse(raw);
            // New format: { desktop: {...}, mobile: {...} }
            if (parsed && typeof parsed === 'object' && ('desktop' in parsed || 'mobile' in parsed)) {
                return {
                    desktop: parsed.desktop || {},
                    mobile: parsed.mobile || {},
                };
            }
            // Old flat format: treat as desktop prefs, migrate
            if (parsed && typeof parsed === 'object') {
                return { desktop: parsed, mobile: {} };
            }
        } catch { /* fall through */ }
        return { desktop: {}, mobile: {} };
    }

    /**
     * Get the user's scoreboard display preferences for a specific device type.
     * Returns an empty object if nothing is saved — the frontend merges these
     * on top of room defaults.
     */
    static async getScoreboardPrefs(discordUserId: string, device?: DeviceType): Promise<ScoreboardPrefs> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        const devicePrefs = this.parseDevicePrefs(row?.scoreboard_prefs);
        if (!device) {
            // No device specified: return desktop for backward compat
            return devicePrefs.desktop;
        }
        return devicePrefs[device] || {};
    }

    /**
     * Save scoreboard display preferences for a specific device type.
     * Merges with existing — pass only the keys you want to change.
     * Pass `null` for a key to delete it (revert to room default).
     */
    static async setScoreboardPrefs(discordUserId: string, prefs: ScoreboardPrefs, device?: DeviceType): Promise<ScoreboardPrefs> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        const devicePrefs = this.parseDevicePrefs(row?.scoreboard_prefs);
        const target = device || 'desktop';
        const existing = devicePrefs[target] || {};

        const merged = { ...existing };
        for (const [k, v] of Object.entries(prefs)) {
            if (v === null || v === undefined || v === '') {
                delete merged[k];
            } else {
                merged[k] = v;
            }
        }
        devicePrefs[target] = merged;

        const json = JSON.stringify(devicePrefs);
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET scoreboard_prefs = excluded.scoreboard_prefs`,
            discordUserId, json
        );
        return merged;
    }
}
