import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { PreferencesService } from '../services/PreferencesService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { UpdatePreferencesSchema } from '../api/schemas.js';
import { getDatabase } from '../database/database.js';
import { addUserFloorPreference } from '../database/migrations/userFloorPreference.js';
import { roomFloorSetting, viewerFloorChoice, isFloorChoice } from '../utils/floorSetting.js';

/**
 * G29 (v2.264.0): the carpet floor switch. The room's choice is the
 * `UI_FLOOR` room setting (absent = on), shipped to public pages as the
 * portal's `ui_floor`; the viewer's choice is `user_preferences.ui_floor`
 * (migration 221; NULL = follow the room), read and written through
 * `/api/me/preferences` like the theme and appearance.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'ra', discordId: '111' } as never);

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
    return app;
}

describe('floorSetting readers', () => {
    it('reads a room setting as on unless it is exactly off', () => {
        expect(roomFloorSetting(undefined)).toBe('on');
        expect(roomFloorSetting(null)).toBe('on');
        expect(roomFloorSetting('on')).toBe('on');
        expect(roomFloorSetting('banana')).toBe('on');
        expect(roomFloorSetting('off')).toBe('off');
    });

    it('reads a viewer value as a choice only when it is on or off', () => {
        expect(viewerFloorChoice('on')).toBe('on');
        expect(viewerFloorChoice('off')).toBe('off');
        expect(viewerFloorChoice(null)).toBeNull();
        expect(viewerFloorChoice('OFF')).toBeNull();
        expect(isFloorChoice('off')).toBe(true);
        expect(isFloorChoice(true)).toBe(false);
    });
});

describe('migration 221_user_floor_preference', () => {
    it('adds a nullable ui_floor column and records itself', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const columns = await db.all<{ name: string; notnull: number }[]>('PRAGMA table_info(user_preferences)');
        const col = columns.find(c => c.name === 'ui_floor');
        expect(col).toBeTruthy();
        expect(col!.notnull).toBe(0);
        const applied = await db.get(`SELECT name FROM schema_migrations WHERE name = '221_user_floor_preference'`);
        expect(applied).toBeTruthy();
    });

    it('is idempotent: a second run changes nothing and does not throw', async () => {
        await setupTestDb();
        const db = await getDatabase();
        await addUserFloorPreference(db);
        await addUserFloorPreference(db);
        const columns = await db.all<{ name: string }[]>('PRAGMA table_info(user_preferences)');
        expect(columns.filter(c => c.name === 'ui_floor')).toHaveLength(1);
    });
});

describe('PreferencesService floor', () => {
    it('reads null for a viewer who has never chosen, in getFloor and getAll', async () => {
        await setupTestDb();
        expect(await PreferencesService.getFloor('discord-floor-1')).toBeNull();
        expect(await PreferencesService.getAll('discord-floor-1')).toMatchObject({ ui_floor: null });
    });

    it('round-trips off and on, and null clears the choice', async () => {
        await setupTestDb();
        await PreferencesService.setFloor('discord-floor-2', 'off');
        expect((await PreferencesService.getAll('discord-floor-2')).ui_floor).toBe('off');
        await PreferencesService.setFloor('discord-floor-2', 'on');
        expect(await PreferencesService.getFloor('discord-floor-2')).toBe('on');
        await PreferencesService.setFloor('discord-floor-2', null);
        expect(await PreferencesService.getFloor('discord-floor-2')).toBeNull();
        const db = await getDatabase();
        const row = await db.get('SELECT ui_floor FROM user_preferences WHERE discord_user_id = ?', 'discord-floor-2');
        expect(row.ui_floor).toBeNull();
    });

    it('is independent of the theme and appearance on the same row', async () => {
        await setupTestDb();
        await PreferencesService.setTheme('discord-floor-3', 'forest');
        await PreferencesService.setAppearance('discord-floor-3', 'dark');
        await PreferencesService.setFloor('discord-floor-3', 'off');
        expect(await PreferencesService.getAll('discord-floor-3')).toMatchObject({ ui_theme: 'forest', appearance: 'dark', ui_floor: 'off' });
        await PreferencesService.setTheme('discord-floor-3', null);
        expect((await PreferencesService.getAll('discord-floor-3')).ui_floor).toBe('off');
    });

    it('reads a junk value stored in the column as no choice', async () => {
        await setupTestDb();
        const db = await getDatabase();
        await db.run('INSERT INTO user_preferences (discord_user_id, ui_floor) VALUES (?, ?)', 'discord-floor-4', 'sometimes');
        expect(await PreferencesService.getFloor('discord-floor-4')).toBeNull();
    });
});

describe('UpdatePreferencesSchema ui_floor', () => {
    it('accepts on, off and null on their own', () => {
        expect(UpdatePreferencesSchema.safeParse({ ui_floor: 'on' }).success).toBe(true);
        expect(UpdatePreferencesSchema.safeParse({ ui_floor: 'off' }).success).toBe(true);
        expect(UpdatePreferencesSchema.safeParse({ ui_floor: null }).success).toBe(true);
    });

    it('rejects any other value, and still rejects an empty body', () => {
        expect(UpdatePreferencesSchema.safeParse({ ui_floor: 'maybe' }).success).toBe(false);
        expect(UpdatePreferencesSchema.safeParse({ ui_floor: true }).success).toBe(false);
        expect(UpdatePreferencesSchema.safeParse({}).success).toBe(false);
    });
});

describe('GET/POST /api/me/preferences ui_floor', () => {
    it('round-trips the floor and writes it only when it is sent', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-floor-1');
        const auth = { Authorization: `Bearer ${token}` };

        const before = await request(app).get('/api/me/preferences').set(auth);
        expect(before.status).toBe(200);
        expect(before.body).toMatchObject({ ui_floor: null });

        expect((await request(app).post('/api/me/preferences').set(auth).send({ ui_floor: 'off' })).status).toBe(200);
        expect((await request(app).get('/api/me/preferences').set(auth)).body).toMatchObject({ ui_floor: 'off' });

        // A write that does not name the floor leaves it alone.
        await request(app).post('/api/me/preferences').set(auth).send({ appearance: 'light' });
        expect((await request(app).get('/api/me/preferences').set(auth)).body).toMatchObject({ ui_floor: 'off', appearance: 'light' });

        // And a floor write leaves the others alone.
        await request(app).post('/api/me/preferences').set(auth).send({ ui_floor: 'on' });
        expect((await request(app).get('/api/me/preferences').set(auth)).body).toMatchObject({ ui_floor: 'on', appearance: 'light' });
    });

    it('rejects a bad floor value with 400', async () => {
        const app = await createApp();
        const res = await request(app)
            .post('/api/me/preferences')
            .set('Authorization', `Bearer ${playerToken('discord-ep-floor-2')}`)
            .send({ ui_floor: 'dim' });
        expect(res.status).toBe(400);
    });
});

describe('the room UI_FLOOR setting and the portal', () => {
    it('ships ui_floor "on" for a room that never set it, on both portals', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('floor-default', 'Floor Default');
        const bySlug = await request(app).get('/api/portal').query({ slug: 'floor-default' });
        expect(bySlug.status).toBe(200);
        expect(bySlug.body.ui_floor).toBe('on');
        const byId = await request(app).get(`/api/rooms/${roomId}/portal`);
        expect(byId.body.ui_floor).toBe('on');
    });

    it('saves off through the room settings route and ships it', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('floor-off', 'Floor Off');
        const res = await request(app).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ UI_FLOOR: 'off' });
        expect(res.status).toBe(200);
        expect(await GameRoomSettingsService.get(roomId, 'UI_FLOOR')).toBe('off');
        expect((await request(app).get('/api/portal').query({ slug: 'floor-off' })).body.ui_floor).toBe('off');
        expect((await request(app).get(`/api/rooms/${roomId}/portal`)).body.ui_floor).toBe('off');

        // An empty value clears the setting, which reads as on again.
        await request(app).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ UI_FLOOR: '' });
        expect((await request(app).get('/api/portal').query({ slug: 'floor-off' })).body.ui_floor).toBe('on');
    });

    it('refuses a value other than on or off, and stores nothing', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('floor-bad', 'Floor Bad');
        const res = await request(app).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ UI_FLOOR: 'dim' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('UI_FLOOR_INVALID');
        expect(await GameRoomSettingsService.get(roomId, 'UI_FLOOR')).toBeNull();
    });
});
