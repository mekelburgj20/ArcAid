import { getDatabase } from '../database/database.js';
import {
    decryptSecret,
    encryptSecret,
    isEncrypted,
    isEncryptedKey,
    isMask,
} from '../utils/secrets.js';

/**
 * Global key/value settings. Transparent encryption for keys listed in
 * `ENCRYPTED_SETTING_KEYS` — callers see and write plaintext; on-disk is
 * ciphertext. Empty-string writes delete the row (so admin UI "clear field"
 * actions persist).
 */
export class SettingsService {
    /**
     * Returns all settings as a key-value map (plaintext for encrypted keys).
     */
    static async getAll(): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all('SELECT key, value FROM settings');
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = SettingsService.decodeValue(row.key, row.value);
            return acc;
        }, {});
    }

    /**
     * Returns a single setting value (plaintext for encrypted keys), or null.
     */
    static async get(key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get('SELECT value FROM settings WHERE key = ?', key);
        if (!row) return null;
        return SettingsService.decodeValue(key, row.value);
    }

    /**
     * Saves multiple settings. Returns true if SETUP_COMPLETE was set to 'true' (triggers restart).
     *
     * Empty-string values delete the row (so the admin can clear a setting via
     * the UI). Mask sentinels (`mask:<KEY>`) are skipped so an unchanged secret
     * field round-trips as a no-op.
     */
    static async saveMany(settings: Record<string, unknown>): Promise<{ needsRestart: boolean }> {
        const db = await getDatabase();
        let needsRestart = false;

        for (const [key, value] of Object.entries(settings)) {
            const strValue = String(value);

            // Skip the mask sentinel — means "user did not change this secret"
            if (isMask(strValue)) continue;

            // Empty value → delete (so clearing a field in the UI persists)
            if (strValue === '' && key !== 'SETUP_COMPLETE') {
                await db.run('DELETE FROM settings WHERE key = ?', key);
                delete process.env[key];
                continue;
            }

            const storedValue = isEncryptedKey(key) ? encryptSecret(strValue) : strValue;
            await db.run(
                'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                key, storedValue
            );
            // Keep process.env in sync with PLAINTEXT so consumers reading env
            // (e.g. IScoredClient login) never see ciphertext.
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

    /**
     * Decode a stored value. Encrypted rows for registered keys are decrypted;
     * legacy plaintext rows (pre-migration) pass through unchanged. Non-secret
     * rows always pass through.
     */
    private static decodeValue(key: string, stored: string): string {
        if (!isEncryptedKey(key)) return stored;
        if (isEncrypted(stored)) return decryptSecret(stored);
        return stored;
    }
}
