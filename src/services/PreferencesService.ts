import { getDatabase } from '../database/database.js';

export type ThemeId = 'dark' | 'light' | 'retro' | 'cyberpunk' | 'ocean' | 'sunset' | 'minimal' | 'invaders' | 'coffee' | 'backglass' | 'crt-green' | 'plasma' | 'cabinet' | 'silverball' | 'wizard' | 'playfield' | 'marquee';

/**
 * Scoreboard display preferences that users can override. Keys match room
 * setting names (e.g. SCOREBOARD_STYLE, SCOREBOARD_THEME). When a user has a
 * preference set, it takes precedence over the room admin default for that
 * user's view only.
 */
export type ScoreboardPrefs = Record<string, string>;

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
            await db.run('DELETE FROM user_preferences WHERE discord_user_id = ?', discordUserId);
        } else {
            await db.run(
                `INSERT INTO user_preferences (discord_user_id, ui_theme) VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET ui_theme = excluded.ui_theme`,
                discordUserId, theme
            );
        }
    }

    static async getAll(discordUserId: string): Promise<{ ui_theme: ThemeId | null }> {
        const theme = await this.getTheme(discordUserId);
        return { ui_theme: theme };
    }

    /**
     * Get the user's scoreboard display preferences. Returns an empty object
     * if nothing is saved — the frontend merges these on top of room defaults.
     */
    static async getScoreboardPrefs(discordUserId: string): Promise<ScoreboardPrefs> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        if (!row?.scoreboard_prefs) return {};
        try {
            return JSON.parse(row.scoreboard_prefs);
        } catch {
            return {};
        }
    }

    /**
     * Save scoreboard display preferences. Merges with existing — pass only
     * the keys you want to change. Pass `null` for a key to delete it (revert
     * to room default for that setting).
     */
    static async setScoreboardPrefs(discordUserId: string, prefs: ScoreboardPrefs): Promise<ScoreboardPrefs> {
        const existing = await this.getScoreboardPrefs(discordUserId);
        const merged = { ...existing };
        for (const [k, v] of Object.entries(prefs)) {
            if (v === null || v === undefined || v === '') {
                delete merged[k];
            } else {
                merged[k] = v;
            }
        }
        const json = JSON.stringify(merged);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)
             ON CONFLICT(discord_user_id) DO UPDATE SET scoreboard_prefs = excluded.scoreboard_prefs`,
            discordUserId, json
        );
        return merged;
    }
}
