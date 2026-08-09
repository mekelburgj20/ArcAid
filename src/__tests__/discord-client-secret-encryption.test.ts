import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { runSecretsMigration } from '../utils/secretsMigration.js';
import { SettingsService } from '../services/SettingsService.js';
import { encryptSecret, isEncrypted, isEncryptedKey, maskEncryptedValues, maskFor } from '../utils/secrets.js';

/**
 * DISCORD_CLIENT_SECRET at-rest encryption (ROADMAP item, path (b)).
 *
 * Unlike every other key in `ENCRYPTED_SETTING_KEYS`, prod already has a
 * PLAINTEXT `DISCORD_CLIENT_SECRET` row — adding the key to the allowlist
 * alone would make the next read throw once code assumed `enc:v1:`
 * ciphertext. `runSecretsMigration()` (called at boot in `index.ts`, right
 * after `initDatabase()` and before `loadSettingsToEnv()`) is the generic
 * startup housekeeping step that already re-encrypts any legacy plaintext
 * row for every allowlisted key — the same mechanism GOOGLE_CLIENT_SECRET,
 * ISCORED_PASSWORD, etc. already rely on. This suite proves it does the
 * right thing for DISCORD_CLIENT_SECRET specifically: plaintext -> encrypted
 * and still readable, already-encrypted rows untouched, an absent row is a
 * no-op, and a missing SECRETS_KEY fails fast (not a silent brick) exactly
 * like it already does for the other keys — adding this key to the probe
 * set doesn't change that behavior for a keyless dev install with no secret
 * rows at all.
 */
describe('DISCORD_CLIENT_SECRET at-rest encryption', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('is registered in the encrypted-key allowlist', () => {
        expect(isEncryptedKey('DISCORD_CLIENT_SECRET')).toBe(true);
    });

    it('encrypts a legacy plaintext row in place and leaves it readable', async () => {
        const db = await getDatabase();
        await db.run(
            "INSERT INTO settings (key, value) VALUES ('DISCORD_CLIENT_SECRET', 'plaintext-secret-value')",
        );

        await runSecretsMigration(db);

        const row = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_CLIENT_SECRET'");
        expect(isEncrypted(row.value)).toBe(true);
        expect(row.value).not.toBe('plaintext-secret-value');

        // Readable back through the normal decrypt-on-read path.
        const decoded = await SettingsService.get('DISCORD_CLIENT_SECRET');
        expect(decoded).toBe('plaintext-secret-value');
    });

    it('leaves an already-encrypted row byte-identical (idempotent)', async () => {
        const db = await getDatabase();
        const ciphertext = encryptSecret('already-encrypted-value');
        await db.run(
            'INSERT INTO settings (key, value) VALUES (?, ?)',
            'DISCORD_CLIENT_SECRET', ciphertext,
        );

        await runSecretsMigration(db);

        const row = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_CLIENT_SECRET'");
        expect(row.value).toBe(ciphertext);
        expect(await SettingsService.get('DISCORD_CLIENT_SECRET')).toBe('already-encrypted-value');
    });

    it('no-ops when the row is absent', async () => {
        const db = await getDatabase();
        await expect(runSecretsMigration(db)).resolves.not.toThrow();
        const row = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_CLIENT_SECRET'");
        expect(row).toBeUndefined();
        expect(await SettingsService.get('DISCORD_CLIENT_SECRET')).toBeNull();
    });

    it('re-running the migration a second time is a no-op (idempotent across restarts)', async () => {
        const db = await getDatabase();
        await db.run(
            "INSERT INTO settings (key, value) VALUES ('DISCORD_CLIENT_SECRET', 'plaintext-secret-value')",
        );
        await runSecretsMigration(db);
        const afterFirst = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_CLIENT_SECRET'");

        await runSecretsMigration(db);
        const afterSecond = await db.get("SELECT value FROM settings WHERE key = 'DISCORD_CLIENT_SECRET'");

        expect(afterSecond.value).toBe(afterFirst.value);
    });

    it('fails fast (does not silently leak plaintext) when SECRETS_KEY is missing and a secret row exists', async () => {
        const db = await getDatabase();
        await db.run(
            "INSERT INTO settings (key, value) VALUES ('DISCORD_CLIENT_SECRET', 'plaintext-secret-value')",
        );
        const saved = process.env.SECRETS_KEY;
        delete process.env.SECRETS_KEY;
        try {
            await expect(runSecretsMigration(db)).rejects.toThrow(/SECRETS_KEY/);
        } finally {
            process.env.SECRETS_KEY = saved;
        }
    });

    it('does not brick a keyless dev install with no secret rows at all', async () => {
        const db = await getDatabase();
        const saved = process.env.SECRETS_KEY;
        delete process.env.SECRETS_KEY;
        try {
            // No DISCORD_CLIENT_SECRET (or any other allowlisted key) row exists —
            // hasAnySecretRow is false, so the missing-key guard never fires.
            await expect(runSecretsMigration(db)).resolves.not.toThrow();
        } finally {
            process.env.SECRETS_KEY = saved;
        }
    });

    it('maskEncryptedValues masks DISCORD_CLIENT_SECRET automatically once allowlisted', () => {
        const masked = maskEncryptedValues({
            DISCORD_CLIENT_SECRET: 'secret',
            DISCORD_CLIENT_ID: 'not-a-secret',
        });
        expect(masked.DISCORD_CLIENT_SECRET).toBe(maskFor('DISCORD_CLIENT_SECRET'));
        expect(masked.DISCORD_CLIENT_ID).toBe('not-a-secret');
    });
});
