import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import {
    StyleProfileService,
    StyleProfileNameConflictError,
    PORTABLE_STYLE_KEYS,
    NEVER_PORTABLE_KEYS,
} from '../services/StyleProfileService.js';

/**
 * Style-system revamp P2 — Style Profiles.
 *
 * The two properties that matter most, and are the easiest to break later:
 *   1. A profile carries APPEARANCE only. Room identity (title text, logo,
 *      background image, name, slug) must never ride along, or applying a
 *      profile renames a room or hangs another room's logo on it.
 *   2. Applying a profile writes ONLY the keys it carries. Everything else in
 *      the target room — including settings the profile has no opinion about —
 *      is left alone.
 */
const OWNER = 'discord:111';
const OTHER_OWNER = 'discord:222';

describe('StyleProfileService', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    describe('the portable key set', () => {
        it('excludes every room-identity key', () => {
            for (const key of NEVER_PORTABLE_KEYS) {
                expect(PORTABLE_STYLE_KEYS).not.toContain(key);
            }
        });

        it('carries no credential, policy or integration keys', () => {
            for (const key of [
                'ISCORED_USERNAME', 'ISCORED_PASSWORD', 'DISCORD_GUILD_ID',
                'DISCORD_ADMIN_ROLE_ID', 'JOIN_POLICY', 'ROOM_LISTED',
                'REQUIRE_SCORE_PHOTO', 'PLATFORMS',
            ]) {
                expect(PORTABLE_STYLE_KEYS).not.toContain(key);
            }
        });

        it('includes the kiosk keys (owner decision, 2026-08-13)', () => {
            expect(PORTABLE_STYLE_KEYS).toContain('KIOSK_ZOOM');
            expect(PORTABLE_STYLE_KEYS).toContain('KIOSK_REFRESH_SECONDS');
            expect(PORTABLE_STYLE_KEYS).toContain('KIOSK_ENABLED');
            expect(PORTABLE_STYLE_KEYS).toContain('KIOSK_AUTO_SCROLL');
        });
    });

    describe('snapshotRoom', () => {
        it('captures portable keys and drops identity ones', async () => {
            const room = await createTestRoom('snap', 'Snap');
            await GameRoomSettingsService.saveMany(room, {
                SCOREBOARD_STYLE: 'arcade',
                SCOREBOARD_MAX_SCORES: '10',
                KIOSK_ZOOM: '140',
                // Identity — must not be captured.
                SCOREBOARD_TITLE: 'Snap Room Scores',
                LOGO_URL: '/api/room-assets/snap/logo.png',
                SCOREBOARD_BG_URL: '/api/room-assets/snap/bg.png',
                // Credentials — must not be captured.
                ISCORED_USERNAME: 'secret-account',
            });

            const snapshot = await StyleProfileService.snapshotRoom(room);

            expect(snapshot).toEqual({
                SCOREBOARD_STYLE: 'arcade',
                SCOREBOARD_MAX_SCORES: '10',
                KIOSK_ZOOM: '140',
            });
        });

        it('omits unset keys rather than capturing their defaults', async () => {
            const room = await createTestRoom('sparse', 'Sparse');
            await GameRoomSettingsService.set(room, 'SCOREBOARD_STYLE', 'minimal');

            const snapshot = await StyleProfileService.snapshotRoom(room);

            // A profile records the choices someone MADE. Baking in today's
            // defaults would pin every room it touches to this moment.
            expect(Object.keys(snapshot)).toEqual(['SCOREBOARD_STYLE']);
        });
    });

    describe('create / list / delete', () => {
        it('round-trips a profile for its owner', async () => {
            const created = await StyleProfileService.create(OWNER, 'Neon Night', { SCOREBOARD_STYLE: 'arcade' });

            expect(created.name).toBe('Neon Night');
            expect(created.settings).toEqual({ SCOREBOARD_STYLE: 'arcade' });
            expect(created.isDefault).toBe(false);

            const list = await StyleProfileService.listForOwner(OWNER);
            expect(list.map(p => p.id)).toEqual([created.id]);
        });

        it('keeps owners apart', async () => {
            await StyleProfileService.create(OWNER, 'Mine', { SCOREBOARD_STYLE: 'arcade' });

            expect(await StyleProfileService.listForOwner(OTHER_OWNER)).toEqual([]);
        });

        it('will not create two profiles with the same name, ignoring case', async () => {
            await StyleProfileService.create(OWNER, 'Neon', {});
            await expect(StyleProfileService.create(OWNER, 'neon', {})).rejects.toThrow(StyleProfileNameConflictError);
            // ...but a DIFFERENT owner may use the same name.
            await expect(StyleProfileService.create(OTHER_OWNER, 'Neon', {})).resolves.toBeTruthy();
        });

        it('strips non-portable keys handed in directly', async () => {
            const created = await StyleProfileService.create(OWNER, 'Sneaky', {
                SCOREBOARD_STYLE: 'banner',
                LOGO_URL: '/should/not/persist.png',
                ISCORED_PASSWORD: 'nope',
            });

            expect(created.settings).toEqual({ SCOREBOARD_STYLE: 'banner' });
        });

        it('deletes only the owner\'s own profile', async () => {
            const mine = await StyleProfileService.create(OWNER, 'Mine', {});

            expect(await StyleProfileService.delete(OTHER_OWNER, mine.id)).toBe(false);
            expect(await StyleProfileService.delete(OWNER, mine.id)).toBe(true);
            expect(await StyleProfileService.listForOwner(OWNER)).toEqual([]);
        });
    });

    describe('setDefault', () => {
        it('allows only one default per owner', async () => {
            const a = await StyleProfileService.create(OWNER, 'A', {});
            const b = await StyleProfileService.create(OWNER, 'B', {});

            await StyleProfileService.setDefault(OWNER, a.id);
            expect((await StyleProfileService.getDefaultForOwner(OWNER))?.id).toBe(a.id);

            await StyleProfileService.setDefault(OWNER, b.id);
            const list = await StyleProfileService.listForOwner(OWNER);
            expect(list.filter(p => p.isDefault).map(p => p.id)).toEqual([b.id]);
        });

        it('can be cleared', async () => {
            const a = await StyleProfileService.create(OWNER, 'A', {});
            await StyleProfileService.setDefault(OWNER, a.id);

            await StyleProfileService.setDefault(OWNER, null);

            expect(await StyleProfileService.getDefaultForOwner(OWNER)).toBeNull();
        });

        it('does not disturb another owner\'s default', async () => {
            const mine = await StyleProfileService.create(OWNER, 'Mine', {});
            const theirs = await StyleProfileService.create(OTHER_OWNER, 'Theirs', {});
            await StyleProfileService.setDefault(OTHER_OWNER, theirs.id);

            await StyleProfileService.setDefault(OWNER, mine.id);

            expect((await StyleProfileService.getDefaultForOwner(OTHER_OWNER))?.id).toBe(theirs.id);
        });
    });

    describe('applyToRoom', () => {
        it('writes the profile keys onto the room', async () => {
            const room = await createTestRoom('target', 'Target');
            const profile = await StyleProfileService.create(OWNER, 'Neon', {
                SCOREBOARD_STYLE: 'showcase',
                SCOREBOARD_MAX_SCORES: '10',
            });

            const applied = await StyleProfileService.applyToRoom(room, profile);

            expect(applied.sort()).toEqual(['SCOREBOARD_MAX_SCORES', 'SCOREBOARD_STYLE']);
            const after = await GameRoomSettingsService.getAll(room);
            expect(after.SCOREBOARD_STYLE).toBe('showcase');
            expect(after.SCOREBOARD_MAX_SCORES).toBe('10');
        });

        it('leaves settings the profile has no opinion about untouched', async () => {
            const room = await createTestRoom('keeper', 'Keeper');
            await GameRoomSettingsService.saveMany(room, {
                SCOREBOARD_STYLE: 'banner',
                SCOREBOARD_TITLE: 'Keeper Room',
                LOGO_URL: '/api/room-assets/keeper/logo.png',
                ISCORED_USERNAME: 'keeper-account',
                SCOREBOARD_QR_MODE: 'all',
            });
            const profile = await StyleProfileService.create(OWNER, 'Just Style', { SCOREBOARD_STYLE: 'minimal' });

            await StyleProfileService.applyToRoom(room, profile);

            const after = await GameRoomSettingsService.getAll(room);
            expect(after.SCOREBOARD_STYLE).toBe('minimal');
            // Identity and credentials survive untouched — this is the whole
            // safety property of applying a profile.
            expect(after.SCOREBOARD_TITLE).toBe('Keeper Room');
            expect(after.LOGO_URL).toBe('/api/room-assets/keeper/logo.png');
            expect(after.ISCORED_USERNAME).toBe('keeper-account');
            // ...as does an appearance key the profile simply did not carry.
            expect(after.SCOREBOARD_QR_MODE).toBe('all');
        });

        it('is a no-op for an empty profile', async () => {
            const room = await createTestRoom('empty', 'Empty');
            await GameRoomSettingsService.set(room, 'SCOREBOARD_STYLE', 'arcade');
            const profile = await StyleProfileService.create(OWNER, 'Nothing', {});

            expect(await StyleProfileService.applyToRoom(room, profile)).toEqual([]);
            expect((await GameRoomSettingsService.getAll(room)).SCOREBOARD_STYLE).toBe('arcade');
        });

        it('round-trips: snapshot one room, apply to another', async () => {
            const source = await createTestRoom('source', 'Source');
            const dest = await createTestRoom('dest', 'Dest');
            await GameRoomSettingsService.saveMany(source, {
                SCOREBOARD_STYLE: 'showcase',
                SCOREBOARD_THEME: 'neon-circuit',
                SCOREBOARD_CARD_SPACING: '16',
                SCOREBOARD_TITLE: 'Source Room',
            });
            await GameRoomSettingsService.set(dest, 'SCOREBOARD_TITLE', 'Dest Room');

            const profile = await StyleProfileService.create(
                OWNER, 'Copied', await StyleProfileService.snapshotRoom(source),
            );
            await StyleProfileService.applyToRoom(dest, profile);

            const after = await GameRoomSettingsService.getAll(dest);
            expect(after.SCOREBOARD_STYLE).toBe('showcase');
            expect(after.SCOREBOARD_THEME).toBe('neon-circuit');
            expect(after.SCOREBOARD_CARD_SPACING).toBe('16');
            // The destination keeps its OWN name.
            expect(after.SCOREBOARD_TITLE).toBe('Dest Room');
        });
    });

    describe('update', () => {
        it('renames and re-captures', async () => {
            const profile = await StyleProfileService.create(OWNER, 'Old', { SCOREBOARD_STYLE: 'banner' });

            const updated = await StyleProfileService.update(OWNER, profile.id, {
                name: 'New',
                settings: { SCOREBOARD_STYLE: 'arcade' },
            });

            expect(updated?.name).toBe('New');
            expect(updated?.settings).toEqual({ SCOREBOARD_STYLE: 'arcade' });
        });

        it('rejects a rename onto another profile of the same owner', async () => {
            await StyleProfileService.create(OWNER, 'Taken', {});
            const other = await StyleProfileService.create(OWNER, 'Free', {});

            await expect(StyleProfileService.update(OWNER, other.id, { name: 'taken' }))
                .rejects.toThrow(StyleProfileNameConflictError);
        });

        it('returns null for a profile the caller does not own', async () => {
            const mine = await StyleProfileService.create(OWNER, 'Mine', {});

            expect(await StyleProfileService.update(OTHER_OWNER, mine.id, { name: 'Hijacked' })).toBeNull();
        });
    });
});
