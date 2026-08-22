import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { signToken } from '../api/auth.js';
import { PreferencesService } from '../services/PreferencesService.js';
import { SetRoomThemeSchema } from '../api/schemas.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.132.0 — "Theme for this room only", made genuinely per-room.
 *
 * Before this release the control lived at `scoreboard_prefs[device].UI_THEME`:
 * one setting labelled "this room" that actually applied to EVERY room, on
 * ONE device. It now lives in `scoreboard_prefs.roomThemes`, a
 * `roomId -> ThemeId` map beside (not inside) the per-device blobs — so it
 * follows the room across devices and does not follow the device across rooms.
 *
 * The three things these tests exist to hold:
 *   1. per-device prefs and room themes cannot clobber each other, in either
 *      direction, including through Reset All (which posts null for every
 *      per-device key);
 *   2. the legacy `UI_THEME` key is lifted onto the room the viewer is in,
 *      exactly once, and swept from BOTH device blobs;
 *   3. room A's override is not room B's.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function rawBlob(discordUserId: string): Promise<Record<string, unknown>> {
    const db = await getDatabase();
    const row = await db.get('SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?', discordUserId);
    return JSON.parse(row?.scoreboard_prefs ?? '{}');
}

describe('SetRoomThemeSchema', () => {
    it('accepts a known theme and an explicit null', () => {
        expect(SetRoomThemeSchema.safeParse({ theme: 'plasma' }).success).toBe(true);
        expect(SetRoomThemeSchema.safeParse({ theme: null }).success).toBe(true);
    });

    it('rejects an unknown theme and a missing field', () => {
        expect(SetRoomThemeSchema.safeParse({ theme: 'neon-banana' }).success).toBe(false);
        expect(SetRoomThemeSchema.safeParse({}).success).toBe(false);
    });
});

describe('PreferencesService room themes', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('returns an empty map for a user who has never set one', async () => {
        expect(await PreferencesService.getRoomThemes('rt-1')).toEqual({});
    });

    it('is per ROOM: room A\'s override is not room B\'s', async () => {
        await PreferencesService.setRoomTheme('rt-2', 'room-a', 'plasma');
        const map = await PreferencesService.getRoomThemes('rt-2');
        expect(map['room-a']).toBe('plasma');
        expect(map['room-b']).toBeUndefined();

        await PreferencesService.setRoomTheme('rt-2', 'room-b', 'ocean');
        const both = await PreferencesService.getRoomThemes('rt-2');
        expect(both).toEqual({ 'room-a': 'plasma', 'room-b': 'ocean' });
    });

    it('is NOT per device: one write, visible whatever device asks', async () => {
        await PreferencesService.setRoomTheme('rt-3', 'room-a', 'coffee');
        // The device blobs are where the pre-v2.132 override lived. Nothing
        // about a room theme may end up in either of them.
        const blob = await rawBlob('rt-3');
        expect(blob.roomThemes).toEqual({ 'room-a': 'coffee' });
        expect(blob.desktop).toEqual({});
        expect(blob.mobile).toEqual({});
    });

    it('clears with null without disturbing the other rooms', async () => {
        await PreferencesService.setRoomTheme('rt-4', 'room-a', 'plasma');
        await PreferencesService.setRoomTheme('rt-4', 'room-b', 'ocean');
        await PreferencesService.setRoomTheme('rt-4', 'room-a', null);
        expect(await PreferencesService.getRoomThemes('rt-4')).toEqual({ 'room-b': 'ocean' });
    });

    it('saving per-device prefs carries the room themes through untouched', async () => {
        await PreferencesService.setRoomTheme('rt-5', 'room-a', 'plasma');
        await PreferencesService.setScoreboardPrefs('rt-5', { SCOREBOARD_LAYOUT: 'grid' }, 'desktop');
        expect(await PreferencesService.getRoomThemes('rt-5')).toEqual({ 'room-a': 'plasma' });

        // Reset All posts null for every per-device key — the harshest write
        // the sheet can make, and still not a room-theme write.
        await PreferencesService.setScoreboardPrefs('rt-5', { SCOREBOARD_LAYOUT: null as unknown as string }, 'desktop');
        expect(await PreferencesService.getRoomThemes('rt-5')).toEqual({ 'room-a': 'plasma' });
    });

    it('saving a room theme carries the per-device prefs through untouched', async () => {
        await PreferencesService.setScoreboardPrefs('rt-6', { SCOREBOARD_LAYOUT: 'grid' }, 'desktop');
        await PreferencesService.setScoreboardPrefs('rt-6', { SCOREBOARD_ZOOM: '80' }, 'mobile');
        await PreferencesService.setRoomTheme('rt-6', 'room-a', 'plasma');

        expect(await PreferencesService.getScoreboardPrefs('rt-6', 'desktop')).toEqual({ SCOREBOARD_LAYOUT: 'grid' });
        expect(await PreferencesService.getScoreboardPrefs('rt-6', 'mobile')).toEqual({ SCOREBOARD_ZOOM: '80' });
    });

    it('drops junk stored directly in the roomThemes map', async () => {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)',
            'rt-7', JSON.stringify({ desktop: {}, mobile: {}, roomThemes: { 'room-a': 'sepia', 'room-b': 'ocean', '': 'plasma' } }),
        );
        expect(await PreferencesService.getRoomThemes('rt-7')).toEqual({ 'room-b': 'ocean' });
    });
});

describe('PreferencesService legacy UI_THEME lift', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seedLegacy(userId: string, blob: Record<string, unknown>) {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)',
            userId, JSON.stringify(blob),
        );
    }

    it('lifts the legacy per-device override onto the room being viewed, once', async () => {
        await seedLegacy('rt-lift-1', { desktop: { UI_THEME: 'plasma', SCOREBOARD_LAYOUT: 'grid' }, mobile: {} });

        const map = await PreferencesService.getRoomThemes('rt-lift-1', 'room-a');
        expect(map).toEqual({ 'room-a': 'plasma' });

        // The device key is gone, the other device prefs are not.
        const blob = await rawBlob('rt-lift-1');
        expect((blob.desktop as Record<string, string>).UI_THEME).toBeUndefined();
        expect((blob.desktop as Record<string, string>).SCOREBOARD_LAYOUT).toBe('grid');

        // Idempotent: visiting a DIFFERENT room afterwards must not lift
        // anything onto it — there is nothing left to lift.
        expect(await PreferencesService.getRoomThemes('rt-lift-1', 'room-b')).toEqual({ 'room-a': 'plasma' });
    });

    it('sweeps the legacy key from BOTH device blobs, so a second device cannot re-lift it', async () => {
        await seedLegacy('rt-lift-2', { desktop: { UI_THEME: 'plasma' }, mobile: { UI_THEME: 'plasma' } });

        await PreferencesService.getRoomThemes('rt-lift-2', 'room-a');

        const blob = await rawBlob('rt-lift-2');
        expect((blob.desktop as Record<string, string>).UI_THEME).toBeUndefined();
        expect((blob.mobile as Record<string, string>).UI_THEME).toBeUndefined();
    });

    it('lifts a mobile-only legacy override too', async () => {
        await seedLegacy('rt-lift-3', { desktop: {}, mobile: { UI_THEME: 'coffee' } });
        expect(await PreferencesService.getRoomThemes('rt-lift-3', 'room-a')).toEqual({ 'room-a': 'coffee' });
    });

    it('never overwrites an override the room already has', async () => {
        await seedLegacy('rt-lift-4', { desktop: { UI_THEME: 'plasma' }, mobile: {}, roomThemes: { 'room-a': 'ocean' } });
        expect(await PreferencesService.getRoomThemes('rt-lift-4', 'room-a')).toEqual({ 'room-a': 'ocean' });
    });

    it('does nothing at all without a roomId — there is no room to lift onto', async () => {
        await seedLegacy('rt-lift-5', { desktop: { UI_THEME: 'plasma' }, mobile: {} });
        expect(await PreferencesService.getRoomThemes('rt-lift-5')).toEqual({});
        expect((await rawBlob('rt-lift-5')).desktop).toEqual({ UI_THEME: 'plasma' });
    });
});

describe('GET/PUT /api/me/room-themes', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('requires auth', async () => {
        const app = await createApp();
        expect((await request(app).get('/api/me/room-themes')).status).toBe(401);
        expect((await request(app).put('/api/me/room-themes/room-a').send({ theme: 'plasma' })).status).toBe(401);
    }, 30000);

    it('round-trips one room and leaves another alone', async () => {
        const app = await createApp();
        const token = playerToken('rt-api-1');

        expect((await request(app).get('/api/me/room-themes').set('Authorization', `Bearer ${token}`)).body)
            .toEqual({ roomThemes: {} });

        const put = await request(app)
            .put('/api/me/room-themes/room-a')
            .set('Authorization', `Bearer ${token}`)
            .send({ theme: 'plasma' });
        expect(put.status).toBe(200);
        expect(put.body).toEqual({ roomThemes: { 'room-a': 'plasma' } });

        const get = await request(app).get('/api/me/room-themes').set('Authorization', `Bearer ${token}`);
        expect(get.body.roomThemes['room-a']).toBe('plasma');
        expect(get.body.roomThemes['room-b']).toBeUndefined();
    });

    it('PUT { theme: null } clears it', async () => {
        const app = await createApp();
        const token = playerToken('rt-api-2');
        await request(app).put('/api/me/room-themes/room-a').set('Authorization', `Bearer ${token}`).send({ theme: 'plasma' });
        const cleared = await request(app).put('/api/me/room-themes/room-a').set('Authorization', `Bearer ${token}`).send({ theme: null });
        expect(cleared.body).toEqual({ roomThemes: {} });
    });

    it('rejects a bad theme with 400', async () => {
        const app = await createApp();
        const token = playerToken('rt-api-3');
        const res = await request(app)
            .put('/api/me/room-themes/room-a')
            .set('Authorization', `Bearer ${token}`)
            .send({ theme: 'neon-banana' });
        expect(res.status).toBe(400);
    });

    it('?roomId= performs the legacy lift and the scoreboard-prefs endpoint stops reporting it', async () => {
        const app = await createApp();
        const token = playerToken('rt-api-4');

        await request(app)
            .post('/api/me/scoreboard-preferences?device=desktop')
            .set('Authorization', `Bearer ${token}`)
            .send({ UI_THEME: 'plasma', SCOREBOARD_LAYOUT: 'grid' });

        const lifted = await request(app)
            .get('/api/me/room-themes?roomId=room-a')
            .set('Authorization', `Bearer ${token}`);
        expect(lifted.body).toEqual({ roomThemes: { 'room-a': 'plasma' } });

        const prefs = await request(app)
            .get('/api/me/scoreboard-preferences?device=desktop')
            .set('Authorization', `Bearer ${token}`);
        expect(prefs.body.UI_THEME).toBeUndefined();
        expect(prefs.body.SCOREBOARD_LAYOUT).toBe('grid');
    });
});
