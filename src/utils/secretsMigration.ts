import type { Database } from 'sqlite';
import { logInfo, logError } from './logger.js';
import {
    ENCRYPTED_SETTING_KEYS,
    ENC_PREFIX,
    encryptSecret,
    isEncrypted,
    isKeyConfigured,
} from './secrets.js';

/**
 * Startup encryption housekeeping:
 *
 * 1. Migrate any legacy plaintext rows for registered secret keys to
 *    `enc:v1:` ciphertext. Idempotent — rows already prefixed are skipped.
 * 2. Fail fast if encrypted rows exist but `SECRETS_KEY` is missing, so we
 *    never fall back to leaking plaintext or crashing on first read.
 *
 * Covers both `settings` (global) and `game_room_settings` (per-room).
 */
export async function runSecretsMigration(db: Database): Promise<void> {
    if (ENCRYPTED_SETTING_KEYS.size === 0) return;

    const keys = Array.from(ENCRYPTED_SETTING_KEYS);
    const placeholders = keys.map(() => '?').join(', ');

    // 1) Probe for any rows that reference a registered secret key. If there
    //    are none, this boot doesn't need SECRETS_KEY at all (users calling
    //    encryptSecret directly still fail fast on their own).
    const globalRows = (await db.all(
        `SELECT key, value FROM settings WHERE key IN (${placeholders})`,
        ...keys,
    )) as Array<{ key: string; value: string | null }>;
    const perRoomRows = (await db.all(
        `SELECT game_room_id, key, value FROM game_room_settings WHERE key IN (${placeholders})`,
        ...keys,
    )) as Array<{ game_room_id: string; key: string; value: string | null }>;

    const hasAnySecretRow =
        globalRows.some(r => r.value && r.value !== '') ||
        perRoomRows.some(r => r.value && r.value !== '');
    if (!hasAnySecretRow) return;

    if (!isKeyConfigured()) {
        throw new Error(
            `SECRETS_KEY is not set (or invalid), but the database contains secret row(s) ` +
            `for keys [${keys.join(', ')}]. Generate a key with ` +
            `\`npm run generate-secrets-key\` and add it to .env before starting.`,
        );
    }

    // 2) Encrypt any plaintext rows in place.
    let migrated = 0;
    for (const row of globalRows) {
        if (!row.value || isEncrypted(row.value)) continue;
        const ciphertext = encryptSecret(row.value);
        await db.run('UPDATE settings SET value = ? WHERE key = ?', ciphertext, row.key);
        migrated++;
    }
    for (const row of perRoomRows) {
        if (!row.value || isEncrypted(row.value)) continue;
        const ciphertext = encryptSecret(row.value);
        await db.run(
            'UPDATE game_room_settings SET value = ? WHERE game_room_id = ? AND key = ?',
            ciphertext, row.game_room_id, row.key,
        );
        migrated++;
    }

    if (migrated > 0) {
        logInfo(`Encrypted ${migrated} legacy plaintext secret row(s) on startup.`);
    }
}

/**
 * Reads all rows from `settings` and copies them into `process.env`,
 * decrypting registered secret keys first so downstream consumers reading
 * `process.env.ISCORED_PASSWORD` etc. see plaintext, never ciphertext.
 */
export async function loadSettingsToEnv(db: Database): Promise<void> {
    const rows = (await db.all('SELECT key, value FROM settings')) as Array<{ key: string; value: string }>;
    const { decryptSecret } = await import('./secrets.js');
    for (const row of rows) {
        if (ENCRYPTED_SETTING_KEYS.has(row.key) && row.value && isEncrypted(row.value)) {
            try {
                process.env[row.key] = decryptSecret(row.value);
            } catch (err) {
                logError(`Failed to decrypt settings.${row.key} at startup — env var not set.`, err);
            }
        } else {
            process.env[row.key] = row.value;
        }
    }
}

// Keep the ENC_PREFIX export reachable from callers that only import this file.
export { ENC_PREFIX };

/**
 * Sessions used to store the Discord OAuth refresh token in plaintext. We
 * now store sha256(token) so a DB leak can't be replayed to issue fresh JWTs.
 * Existing rows are migrated in place — the client still holds the original
 * plaintext, so the next refresh lookup (`hash(client_token)` vs stored hash)
 * still matches.
 *
 * Detection: sha256 hex digests are 64 chars of [0-9a-f] only; UUIDs contain
 * hyphens. Any refresh_token with a hyphen is plaintext.
 */
export async function migrateRefreshTokensToHashed(db: import('sqlite').Database): Promise<void> {
    const { createHash } = await import('crypto');
    const rows = (await db.all('SELECT id, refresh_token FROM sessions')) as Array<{
        id: string;
        refresh_token: string | null;
    }>;
    let migrated = 0;
    for (const row of rows) {
        if (!row.refresh_token) continue;
        // Already a sha256 hash — skip.
        if (/^[0-9a-f]{64}$/.test(row.refresh_token)) continue;
        const hash = createHash('sha256').update(row.refresh_token).digest('hex');
        await db.run('UPDATE sessions SET refresh_token = ? WHERE id = ?', hash, row.id);
        migrated++;
    }
    if (migrated > 0) {
        const { logInfo } = await import('./logger.js');
        logInfo(`Hashed ${migrated} plaintext refresh token(s) in sessions table.`);
    }
}
