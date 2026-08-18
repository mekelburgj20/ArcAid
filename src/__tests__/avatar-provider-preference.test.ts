import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { UserProfileService, resolveEffectiveAvatarProvider, effectiveAvatarUrlFor } from '../services/UserProfileService.js';

/**
 * Avatar provider preference — owner call 2026-08-17.
 *
 * `PlayerAvatar` resolves `avatarUrl ?? avatarHash`, so a user linked to BOTH
 * providers always got their Google picture and their Discord avatar became
 * unreachable (player report: "my Google picture shows but my CL logo doesn't").
 *
 * The choice is applied by rewriting the EFFECTIVE `avatar_url` column, so the
 * ~25 existing read sites need no changes — and these tests assert on that
 * column, because that is what every reader actually sees.
 */

const DISCORD_HASH = 'e7e8cab452c64eba5cb59918754ab41d';
const GOOGLE_URL = 'https://lh3.googleusercontent.com/a/ACg8ocI5KxG=s96-c';

async function seedProfile(id: string, opts: { hash?: string | null; google?: string | null } = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_url_google, avatar_url)
         VALUES (?, ?, ?, ?)`,
        id, opts.hash ?? null, opts.google ?? null, opts.google ?? null,
    );
}

async function effectiveUrl(id: string): Promise<string | null> {
    const db = await getDatabase();
    const row = await db.get('SELECT avatar_url FROM user_profiles WHERE discord_user_id = ?', id);
    return row?.avatar_url ?? null;
}

describe('resolveEffectiveAvatarProvider', () => {
    it('defaults to Google when both exist and no preference is set (pre-2026-08-17 behavior)', () => {
        expect(resolveEffectiveAvatarProvider(null, DISCORD_HASH, GOOGLE_URL)).toBe('google');
    });

    it('honours an explicit Discord preference', () => {
        expect(resolveEffectiveAvatarProvider('discord', DISCORD_HASH, GOOGLE_URL)).toBe('discord');
    });

    it('degrades rather than rendering nothing when the preferred provider has no avatar', () => {
        expect(resolveEffectiveAvatarProvider('discord', null, GOOGLE_URL)).toBe('google');
        expect(resolveEffectiveAvatarProvider('google', DISCORD_HASH, null)).toBe('discord');
    });

    it('returns null when the user has no avatar at all', () => {
        expect(resolveEffectiveAvatarProvider('discord', null, null)).toBeNull();
    });
});

describe('avatar preference — the effective column every reader sees', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('choosing Discord clears avatar_url so readers fall through to the hash', async () => {
        await seedProfile('U1', { hash: DISCORD_HASH, google: GOOGLE_URL });
        expect(await effectiveUrl('U1')).toBe(GOOGLE_URL);

        await UserProfileService.setAvatarPreference('U1', 'discord');

        expect(await effectiveUrl('U1')).toBeNull();
        const opts = await UserProfileService.getAvatarOptions('U1');
        expect(opts).toMatchObject({ preference: 'discord', effective: 'discord' });
        // The Google picture is retained, not destroyed — switching back works.
        expect(opts.googleAvatarUrl).toBe(GOOGLE_URL);
    });

    it('switching back to Google restores the stored picture', async () => {
        await seedProfile('U2', { hash: DISCORD_HASH, google: GOOGLE_URL });
        await UserProfileService.setAvatarPreference('U2', 'discord');
        await UserProfileService.setAvatarPreference('U2', 'google');

        expect(await effectiveUrl('U2')).toBe(GOOGLE_URL);
    });

    it('null restores automatic behavior', async () => {
        await seedProfile('U3', { hash: DISCORD_HASH, google: GOOGLE_URL });
        await UserProfileService.setAvatarPreference('U3', 'discord');
        await UserProfileService.setAvatarPreference('U3', null);

        expect(await effectiveUrl('U3')).toBe(GOOGLE_URL);
    });

    it('rejects a provider the user has no avatar for, leaving them unchanged', async () => {
        await seedProfile('U4', { hash: null, google: GOOGLE_URL });

        await expect(UserProfileService.setAvatarPreference('U4', 'discord'))
            .rejects.toMatchObject({ code: 'AVATAR_UNAVAILABLE' });
        expect(await effectiveUrl('U4')).toBe(GOOGLE_URL);
    });

    it('a later Google login does NOT override a Discord preference', async () => {
        const db = await getDatabase();
        await seedProfile('U5', { hash: DISCORD_HASH, google: GOOGLE_URL });
        await UserProfileService.setAvatarPreference('U5', 'discord');

        // Simulate the google/callback write: it updates the PROVIDER store,
        // then re-derives. Pre-fix it wrote avatar_url directly, which is how
        // the Discord avatar got buried on every sign-in.
        await db.run(
            `UPDATE user_profiles SET avatar_url_google = ? WHERE discord_user_id = ?`,
            'https://lh3.googleusercontent.com/a/NEWPIC=s96-c', 'U5',
        );
        await UserProfileService.applyAvatarPreference('U5');

        expect(await effectiveUrl('U5')).toBeNull();
        expect((await UserProfileService.getAvatarOptions('U5')).effective).toBe('discord');
    });

    it('a user who only has Google is unaffected and gets no choice to make', async () => {
        await seedProfile('U6', { hash: null, google: GOOGLE_URL });
        await UserProfileService.applyAvatarPreference('U6');

        expect(await effectiveUrl('U6')).toBe(GOOGLE_URL);
        const opts = await UserProfileService.getAvatarOptions('U6');
        expect(opts.discordAvatarHash).toBeNull();
        expect(opts.effective).toBe('google');
    });
});

describe('effectiveAvatarUrlFor — what a freshly-minted token carries', () => {
    beforeEach(async () => { await setupTestDb(); });

    /**
     * REGRESSION (owner field report, 2026-08-18): "I can choose my Discord
     * avatar but there is no save option. When I exit Account Settings, my
     * profile pic is still my google one."
     *
     * The save WAS working — prod showed avatar_preference='discord' stored
     * correctly. The nav renders the JWT's `avatar` claim, cached at login,
     * and the LOGIN paths stamped the raw provider picture into it while only
     * the refresh path resolved through user_profiles. So the choice was
     * invisible everywhere outside Account Settings until the token refreshed.
     */
    it('returns the Discord CDN url once Discord is the chosen provider', async () => {
        await seedProfile('T1', { hash: DISCORD_HASH, google: GOOGLE_URL });
        expect(await effectiveAvatarUrlFor('T1')).toBe(GOOGLE_URL);

        await UserProfileService.setAvatarPreference('T1', 'discord');

        expect(await effectiveAvatarUrlFor('T1')).toBe(
            `https://cdn.discordapp.com/avatars/T1/${DISCORD_HASH}.png`,
        );
    });

    it('follows a switch back to Google', async () => {
        await seedProfile('T2', { hash: DISCORD_HASH, google: GOOGLE_URL });
        await UserProfileService.setAvatarPreference('T2', 'discord');
        await UserProfileService.setAvatarPreference('T2', 'google');
        expect(await effectiveAvatarUrlFor('T2')).toBe(GOOGLE_URL);
    });

    it('is undefined for a user with no avatar at all', async () => {
        await seedProfile('T3', { hash: null, google: null });
        expect(await effectiveAvatarUrlFor('T3')).toBeUndefined();
    });

    it('matches what the refresh path already derived, so login and refresh agree', async () => {
        await seedProfile('T4', { hash: DISCORD_HASH, google: GOOGLE_URL });
        await UserProfileService.setAvatarPreference('T4', 'discord');

        const db = await getDatabase();
        const row = await db.get('SELECT avatar_hash, avatar_url FROM user_profiles WHERE discord_user_id = ?', 'T4');
        // This is the expression api/auth.ts's refresh path uses verbatim.
        const refreshValue = row.avatar_url
            ? row.avatar_url
            : row.avatar_hash
                ? `https://cdn.discordapp.com/avatars/T4/${row.avatar_hash}.png`
                : undefined;

        expect(await effectiveAvatarUrlFor('T4')).toBe(refreshValue);
    });
});
