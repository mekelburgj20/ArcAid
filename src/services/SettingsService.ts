import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

export class SettingsService {
    /**
     * Returns all settings as a key-value map.
     */
    static async getAll(): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all('SELECT key, value FROM settings');
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    /**
     * Returns a single setting value, or null if not found.
     */
    static async get(key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
        return row?.value ?? null;
    }

    /**
     * Saves multiple settings. Returns true if SETUP_COMPLETE was set to 'true' (triggers restart).
     */
    static async saveMany(settings: Record<string, unknown>): Promise<{ needsRestart: boolean }> {
        const db = await getDatabase();
        let needsRestart = false;

        for (const [key, value] of Object.entries(settings)) {
            const strValue = String(value);
            // Skip empty values — don't overwrite .env defaults with blanks
            if (strValue === '' && key !== 'SETUP_COMPLETE') continue;

            await db.run(
                'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                key, strValue
            );
            if (key === 'SETUP_COMPLETE' && value === 'true') {
                needsRestart = true;
            }
        }

        return { needsRestart };
    }

    /**
     * Checks if setup has been completed.
     */
    static async isSetupComplete(): Promise<boolean> {
        const value = await SettingsService.get('SETUP_COMPLETE');
        return value === 'true';
    }
}
