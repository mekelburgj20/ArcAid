import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { avatarAutoPrefersDiscord } from '../database/migrations/avatarAutoPrefersDiscord.js';

/**
 * Migration 160 (v2.127.1) replayed over prod-shaped rows.
 *
 * The migration runs on a FRESH test database with nothing to do, so — like
 * `migration-159-fold-synthetic-members.test.ts` — this seeds the shapes
 * afterwards and calls the handler directly. All four populations are here:
 * an automatic user with both providers (the one that changes), a user who
 * explicitly chose Google despite having a Discord avatar (must not move), a
 * Google-only user, and a Discord-only user.
 */

const DISCORD_HASH = 'e7e8cab452c64eba5cb59918754ab41d';
const GOOGLE_URL = 'https://lh3.googleusercontent.com/a/ACg8ocI5KxG=s96-c';

type ProfileRow = { discord_user_id: string; avatar_url: string | null; avatar_url_google: string | null };

async function seed(id: string, opts: {
    hash?: string | null;
    google?: string | null;
    effective?: string | null;
    preference?: string | null;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_url_google, avatar_url, avatar_preference)
         VALUES (?, ?, ?, ?, ?)`,
        id, opts.hash ?? null, opts.google ?? null, opts.effective ?? null, opts.preference ?? null,
    );
}

async function profiles(): Promise<ProfileRow[]> {
    const db = await getDatabase();
    return await db.all(
        `SELECT discord_user_id, avatar_url, avatar_url_google FROM user_profiles ORDER BY discord_user_id`);
}

describe('migration 160 — automatic avatars re-derive to Discord-first', () => {
    beforeEach(async () => {
        await setupTestDb();
        // AUTO with both — the letter-tile victim. Effective was the Google URL.
        await seed('auto-both', { hash: DISCORD_HASH, google: GOOGLE_URL, effective: GOOGLE_URL });
        // EXPLICIT google, also has a Discord avatar — their choice, untouched.
        await seed('pref-google', { hash: DISCORD_HASH, google: GOOGLE_URL, effective: GOOGLE_URL, preference: 'google' });
        // AUTO, Google only — nothing better to switch to.
        await seed('google-only', { hash: null, google: GOOGLE_URL, effective: GOOGLE_URL });
        // AUTO, Discord only — already effective-NULL, nothing to do.
        await seed('discord-only', { hash: DISCORD_HASH, google: null, effective: null });
    });

    it('clears the effective url only for automatic users who have a Discord avatar', async () => {
        const db = await getDatabase();
        await avatarAutoPrefersDiscord(db);

        expect(await profiles()).toEqual([
            // Effective cleared → readers fall through to avatar_hash…
            { discord_user_id: 'auto-both', avatar_url: null, avatar_url_google: GOOGLE_URL },
            { discord_user_id: 'discord-only', avatar_url: null, avatar_url_google: null },
            { discord_user_id: 'google-only', avatar_url: GOOGLE_URL, avatar_url_google: GOOGLE_URL },
            { discord_user_id: 'pref-google', avatar_url: GOOGLE_URL, avatar_url_google: GOOGLE_URL },
        ]);
    });

    it('keeps the Google picture in its provider column, so switching back still works', async () => {
        const db = await getDatabase();
        await avatarAutoPrefersDiscord(db);

        const { UserProfileService } = await import('../services/UserProfileService.js');
        await UserProfileService.setAvatarPreference('auto-both', 'google');

        const row = await db.get(
            `SELECT avatar_url FROM user_profiles WHERE discord_user_id = 'auto-both'`);
        expect(row.avatar_url).toBe(GOOGLE_URL);
    });

    it('is idempotent — a second run changes nothing', async () => {
        const db = await getDatabase();
        await avatarAutoPrefersDiscord(db);
        const after = await profiles();
        await avatarAutoPrefersDiscord(db);
        expect(await profiles()).toEqual(after);
    });

    it('is recorded in schema_migrations on a fresh database', async () => {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT name FROM schema_migrations WHERE name = '160_avatar_auto_prefers_discord'`);
        expect(row).toBeTruthy();
    });
});
