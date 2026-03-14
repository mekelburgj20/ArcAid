import { getDatabase } from '../database/database.js';

export type ThemeId = 'arcade' | 'dark' | 'light';

export const VALID_THEMES: ThemeId[] = ['arcade', 'dark', 'light'];

export class PreferencesService {
    /**
     * Get a user's UI theme preference.
     * Returns null if no preference set (use global default).
     */
    static async getTheme(discordUserId: string): Promise<ThemeId | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT ui_theme FROM user_preferences WHERE discord_user_id = ?',
            discordUserId
        );
        return (row?.ui_theme as ThemeId) || null;
    }

    /**
     * Set a user's UI theme preference. Pass null to clear (revert to global).
     */
    static async setTheme(discordUserId: string, theme: ThemeId | null): Promise<void> {
        const db = await getDatabase();
        if (!theme) {
            await db.run('DELETE FROM user_preferences WHERE discord_user_id = ?', discordUserId);
        } else {
            await db.run(
                'INSERT OR REPLACE INTO user_preferences (discord_user_id, ui_theme) VALUES (?, ?)',
                discordUserId, theme
            );
        }
    }

    /**
     * Get all preferences for a user.
     */
    static async getAll(discordUserId: string): Promise<{ ui_theme: ThemeId | null }> {
        const theme = await this.getTheme(discordUserId);
        return { ui_theme: theme };
    }
}
