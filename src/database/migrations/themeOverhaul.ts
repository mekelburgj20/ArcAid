import { logInfo } from '../../utils/logger.js';
import { LEGACY_THEME_MAP, isThemeId } from '../../utils/themeIds.js';

/**
 * Migration 162 — v2.133.0 theme overhaul.
 *
 * Eleven themes were removed (`coffee`, `crt-green`, `marquee`, `cabinet`,
 * `ocean`, `invaders`, `playfield`, `wizard`, `cyberpunk`, `sunset`,
 * `minimal`) and their `.theme-*` blocks deleted from index.css. A stored id
 * naming one of them is now a class no stylesheet defines: the page silently
 * paints the default dark and the owner's choice is gone, with no error
 * anywhere. This rewrites every stored id through `LEGACY_THEME_MAP` — the
 * SAME map the runtime shim uses, imported rather than copied.
 *
 * Three storage sites, all of them:
 *   1. `game_room_settings` key `UI_THEME`  — the room's default theme
 *   2. `user_preferences.ui_theme`          — the viewer's personal theme
 *   3. `user_preferences.scoreboard_prefs`  — the `roomThemes` map (v2.132.0)
 *      plus any pre-v2.132 `desktop.UI_THEME` / `mobile.UI_THEME` residue,
 *      which `PreferencesService.getRoomThemes` still lifts onto a room.
 *
 * Idempotent: a second run finds no retired ids and writes nothing.
 * localStorage mirrors are NOT migratable, which is the other half of why the
 * runtime `normalizeThemeId` shim exists.
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
    all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
};

interface PrefsRow {
    discord_user_id: string;
    scoreboard_prefs: string | null;
}

export async function themeOverhaul(db: Db): Promise<void> {
    const counts = { roomDefaults: 0, personal: 0, roomOverrides: 0, devicePrefs: 0 };

    for (const [legacy, replacement] of Object.entries(LEGACY_THEME_MAP)) {
        // 1. Room default themes.
        const rooms = await db.run(
            `UPDATE game_room_settings SET value = ? WHERE key = 'UI_THEME' AND value = ?`,
            replacement, legacy,
        );
        counts.roomDefaults += rooms.changes ?? 0;

        // 2. Personal themes.
        const personal = await db.run(
            'UPDATE user_preferences SET ui_theme = ? WHERE ui_theme = ?',
            replacement, legacy,
        );
        counts.personal += personal.changes ?? 0;
    }

    // 3. The JSON blob. Read-modify-write per row, because SQLite's JSON
    //    functions cannot rewrite an arbitrary set of object VALUES in place.
    const rows = await db.all<PrefsRow>(
        `SELECT discord_user_id, scoreboard_prefs FROM user_preferences
          WHERE scoreboard_prefs IS NOT NULL AND scoreboard_prefs != ''`,
    );
    for (const row of rows) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.scoreboard_prefs!);
        } catch {
            continue; // unparseable blobs are already inert to every reader
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const blob = parsed as Record<string, unknown>;
        let touched = false;

        const roomThemes = blob.roomThemes;
        if (roomThemes && typeof roomThemes === 'object' && !Array.isArray(roomThemes)) {
            const map = roomThemes as Record<string, unknown>;
            for (const [roomId, value] of Object.entries(map)) {
                if (typeof value !== 'string' || isThemeId(value)) continue;
                const mapped = LEGACY_THEME_MAP[value];
                if (!mapped) continue;
                map[roomId] = mapped;
                counts.roomOverrides++;
                touched = true;
            }
        }

        for (const device of ['desktop', 'mobile'] as const) {
            const prefs = blob[device];
            if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) continue;
            const devicePrefs = prefs as Record<string, unknown>;
            const value = devicePrefs.UI_THEME;
            if (typeof value !== 'string' || isThemeId(value)) continue;
            const mapped = LEGACY_THEME_MAP[value];
            if (!mapped) continue;
            devicePrefs.UI_THEME = mapped;
            counts.devicePrefs++;
            touched = true;
        }

        if (touched) {
            await db.run(
                'UPDATE user_preferences SET scoreboard_prefs = ? WHERE discord_user_id = ?',
                JSON.stringify(blob), row.discord_user_id,
            );
        }
    }

    logInfo(
        `[migration 162] theme overhaul: ${counts.roomDefaults} room default(s), ` +
        `${counts.personal} personal theme(s), ${counts.roomOverrides} per-room override(s), ` +
        `${counts.devicePrefs} legacy device pref(s) remapped`,
    );
}
