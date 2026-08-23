import { getDatabase } from '../database/database.js';
import { isThemeId, normalizeThemeId, type ThemeId } from '../utils/themeIds.js';

// v2.133.0 — the id list, the legacy fold and the type all live in
// `src/utils/themeIds.ts` (mirrored byte-identically in
// `admin-ui/src/lib/themeIds.ts`, locked by `themeIds-parity.test.ts`). These
// re-exports keep the existing `PreferencesService` import sites compiling.
export { isThemeId, normalizeThemeId };
export type { ThemeId };

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

/**
 * v2.132.0 — the viewer's "theme for this room only" overrides, keyed by
 * `game_rooms.id`.
 *
 * Deliberately NOT per device. This used to live as a `UI_THEME` key inside
 * the per-device scoreboard prefs, which meant the one control labelled
 * "this room" was really "every room, on this device" — set it in room A on
 * your phone and room B inherited it there but not on your laptop. It rides
 * in the same `scoreboard_prefs` JSON column (no migration, no new table) as
 * a THIRD top-level key beside `desktop`/`mobile`, so the per-device prefs
 * are untouched by a room-theme write and vice versa.
 */
export type RoomThemes = Record<string, ThemeId>;

/** Stored format: { desktop: {...}, mobile: {...}, roomThemes: {...} } */
type DevicePrefs = { desktop: ScoreboardPrefs; mobile: ScoreboardPrefs; roomThemes: RoomThemes };

export class PreferencesService {
    static async getTheme(discordUserId: string): Promise<ThemeId | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT ui_theme FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        const theme = row?.ui_theme;
        if (!theme) return null;
        // 'arcade' is a pre-multi-theme value that never had a class; every
        // other retired id folds through LEGACY_THEME_MAP (v2.133.0). An
        // unrecognised value reads as NULL, i.e. "use each room's default",
        // which is the safe reading of a theme that no longer exists.
        if (theme === 'arcade') return 'dark';
        return normalizeThemeId(theme);
    }

    /** Writes are normalized too, so a retired id can never enter the column. */
    static async setTheme(discordUserId: string, themeInput: ThemeId | null): Promise<void> {
        const theme = themeInput === null ? null : normalizeThemeId(themeInput);
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
        if (!raw) return { desktop: {}, mobile: {}, roomThemes: {} };
        try {
            const parsed = JSON.parse(raw);
            // New format: { desktop: {...}, mobile: {...}, roomThemes: {...} }
            if (parsed && typeof parsed === 'object' && ('desktop' in parsed || 'mobile' in parsed)) {
                return {
                    desktop: parsed.desktop || {},
                    mobile: parsed.mobile || {},
                    // v2.132.0. Absent on every blob written before this
                    // release, and `setScoreboardPrefs` round-trips whatever
                    // this returns — so the default MUST be `{}`, never
                    // undefined, or a device-pref save would drop the room
                    // themes on the floor.
                    roomThemes: this.sanitizeRoomThemes(parsed.roomThemes),
                };
            }
            // Old flat format: treat as desktop prefs, migrate
            if (parsed && typeof parsed === 'object') {
                return { desktop: parsed, mobile: {}, roomThemes: {} };
            }
        } catch { /* fall through */ }
        return { desktop: {}, mobile: {}, roomThemes: {} };
    }

    /** Drops anything that isn't a `roomId -> ThemeId` pair. */
    private static sanitizeRoomThemes(raw: unknown): RoomThemes {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out: RoomThemes = {};
        for (const [roomId, theme] of Object.entries(raw as Record<string, unknown>)) {
            const normalized = normalizeThemeId(theme);
            if (roomId && normalized) out[roomId] = normalized;
        }
        return out;
    }

    private static async persistDevicePrefs(discordUserId: string, devicePrefs: DevicePrefs): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET scoreboard_prefs = excluded.scoreboard_prefs`,
            discordUserId, JSON.stringify(devicePrefs),
        );
    }

    /**
     * The user's per-room theme overrides.
     *
     * `migrateRoomId` performs the ONE-SHOT lift of the pre-v2.132 per-device
     * `UI_THEME` override onto the room the viewer is currently looking at:
     * that key was the only "this room" theme that ever existed, the viewer
     * set it while standing in some room, and the room they are in now is the
     * closest honest reading of which. It runs only when the room has no
     * override yet, clears BOTH device copies so a second device can't lift a
     * stale value onto a different room later, and is idempotent — after the
     * first call there is nothing left to migrate.
     */
    static async getRoomThemes(discordUserId: string, migrateRoomId?: string): Promise<RoomThemes> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?',
            discordUserId,
        );
        const devicePrefs = this.parseDevicePrefs(row?.scoreboard_prefs);

        // v2.133.0 — the lifted legacy value goes through the same fold as
        // everything else; a device that stored 'cyberpunk' lifts to Synthwave.
        const legacy = normalizeThemeId(devicePrefs.desktop.UI_THEME ?? devicePrefs.mobile.UI_THEME);
        const needsLift = !!migrateRoomId && !devicePrefs.roomThemes[migrateRoomId] && !!legacy;
        const hasStaleKey = 'UI_THEME' in devicePrefs.desktop || 'UI_THEME' in devicePrefs.mobile;

        if (needsLift || (migrateRoomId && hasStaleKey)) {
            if (needsLift) devicePrefs.roomThemes[migrateRoomId!] = legacy!;
            delete devicePrefs.desktop.UI_THEME;
            delete devicePrefs.mobile.UI_THEME;
            await this.persistDevicePrefs(discordUserId, devicePrefs);
        }

        return devicePrefs.roomThemes;
    }

    /** Set (or, with `null`, clear) one room's theme override. */
    static async setRoomTheme(discordUserId: string, roomId: string, themeInput: ThemeId | null): Promise<RoomThemes> {
        const theme = themeInput === null ? null : normalizeThemeId(themeInput);
        const db = await getDatabase();
        const row = await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?',
            discordUserId,
        );
        const devicePrefs = this.parseDevicePrefs(row?.scoreboard_prefs);
        if (theme) devicePrefs.roomThemes[roomId] = theme;
        else delete devicePrefs.roomThemes[roomId];
        await this.persistDevicePrefs(discordUserId, devicePrefs);
        return devicePrefs.roomThemes;
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

        // v2.132.0: `devicePrefs` carries `roomThemes` through untouched, so a
        // device-pref save (including Reset All, which posts null for every
        // key) can never clear the viewer's per-room themes.
        await this.persistDevicePrefs(discordUserId, devicePrefs);
        return merged;
    }
}
