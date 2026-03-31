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
            // Keep process.env in sync so changes take effect immediately
            process.env[key] = strValue;
            if (key === 'SETUP_COMPLETE' && value === 'true') {
                needsRestart = true;
            }
        }

        // Hot-reload poller settings when changed
        if ('ISCORED_API_ENABLED' in settings || 'ISCORED_API_POLL_INTERVAL' in settings) {
            try {
                const { ScoreSyncPoller } = await import('../engine/ScoreSyncPoller.js');
                const poller = ScoreSyncPoller.getInstance();
                if (process.env.ISCORED_API_ENABLED === 'false') {
                    poller.stop();
                } else if (process.env.ISCORED_PUBLIC_URL) {
                    const intervalSec = parseInt(process.env.ISCORED_API_POLL_INTERVAL || '30', 10);
                    poller.start(intervalSec * 1000);
                }
            } catch {}
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
