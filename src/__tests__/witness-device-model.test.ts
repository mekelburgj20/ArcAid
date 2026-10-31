import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessService, parseDeviceModel } from '../services/WitnessService.js';
import { WitnessAdminViewService } from '../services/WitnessAdminViewService.js';

/**
 * W73 - which AtGames cabinet model a paired device is. The cabinet appends
 * `model=` (ATGAMES_DEVICE_TYPE_ID) and `model_name=` (ATGAMES_DEVICE_TYPE_NAME)
 * to pair / check-in / heartbeat. A bad value is ignored, never a 400.
 */
const USER = '123456789012345678';
const DEVICE = 'fp-device-uuid-w73';
const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function pairDevice(app: express.Express, extra: Record<string, string> = {}) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: DEVICE, username: 'PlayerOne', ...extra });
    return { token: pairRes.body.token as string, status: pairRes.status };
}

async function stored() {
    const db = await getDatabase();
    return (await db.get<{ device_model: string | null; device_model_name: string | null }>(
        'SELECT device_model, device_model_name FROM witness_devices WHERE atgames_unique_id = ?', DEVICE,
    ))!;
}

describe('parseDeviceModel', () => {
    it('accepts and trims allowed characters', () => {
        expect(parseDeviceModel('HA9920', 32)).toBe('HA9920');
        expect(parseDeviceModel('  Legends Ultimate ', 64)).toBe('Legends Ultimate');
        expect(parseDeviceModel('Pinball-2_x.1', 64)).toBe('Pinball-2_x.1');
    });
    it('ignores oversize, junk, missing and non-string values', () => {
        expect(parseDeviceModel('A'.repeat(33), 32)).toBeNull();
        expect(parseDeviceModel('A'.repeat(32), 32)).toBe('A'.repeat(32));
        expect(parseDeviceModel('A'.repeat(65), 64)).toBeNull();
        for (const bad of [undefined, null, '', '   ', 'HA<b>', 'x;DROP', 'café', ['HA9920'], { a: 1 }, 9920]) {
            expect(parseDeviceModel(bad, 64)).toBeNull();
        }
    });
});

describe('W73 migration 203', () => {
    it('adds both columns, NULL by default', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const cols = (await db.all(`PRAGMA table_info(witness_devices)`)) as Array<{ name: string }>;
        expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['device_model', 'device_model_name']));
        const applied = await db.get('SELECT id FROM schema_migrations WHERE name = ?', '203_witness_device_model');
        expect(applied).toBeTruthy();
    });
});

describe('W73 pair stores the model', () => {
    it('stores model and model_name given at pairing', async () => {
        const app = await createTestApp();
        const { status } = await pairDevice(app, { model: 'HA9920', model_name: 'Legends Ultimate' });
        expect(status).toBe(200);
        expect(await stored()).toEqual({ device_model: 'HA9920', device_model_name: 'Legends Ultimate' });
    });

    it('a junk model never refuses the pairing', async () => {
        const app = await createTestApp();
        const { status } = await pairDevice(app, { model: '<script>', model_name: 'x'.repeat(100) });
        expect(status).toBe(200);
        expect(await stored()).toEqual({ device_model: null, device_model_name: null });
    });
});

describe.each(['checkin', 'heartbeat'] as const)('W73 model on /witness/%s', (route) => {
    let app: express.Express;
    let token: string;
    beforeEach(async () => {
        app = await createTestApp();
        token = (await pairDevice(app)).token;
    });
    const hit = (q: Record<string, string> = {}) =>
        request(app).get(`/api/witness/${route}`).query({ device: DEVICE, token, ...q });

    it('stores valid values', async () => {
        const res = await hit({ model: 'HA9920', model_name: 'Legends Ultimate' });
        expect(res.status).toBe(200);
        expect(await stored()).toEqual({ device_model: 'HA9920', device_model_name: 'Legends Ultimate' });
    });

    it('answers 200 and stores nothing for junk or oversize values', async () => {
        const res = await hit({ model: 'HA;9920', model_name: 'n'.repeat(65) });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(await stored()).toEqual({ device_model: null, device_model_name: null });
    });

    it('a call with no model keeps what is stored', async () => {
        await hit({ model: 'HA9920', model_name: 'Legends Ultimate' });
        await hit();
        expect(await stored()).toEqual({ device_model: 'HA9920', device_model_name: 'Legends Ultimate' });
    });

    it('a changed value is written', async () => {
        await hit({ model: 'HA9920' });
        await hit({ model: 'HA9921' });
        expect((await stored()).device_model).toBe('HA9921');
    });

    it('a wrong token is a bare 401 and stores nothing', async () => {
        const res = await request(app).get(`/api/witness/${route}`).query({ device: DEVICE, token: 'nope', model: 'HA9920' });
        expect(res.status).toBe(401);
        expect(await stored()).toEqual({ device_model: null, device_model_name: null });
    });
});

describe('W73 repeated reports do not churn the row', () => {
    it('stampDeviceModel writes only when a value differs', async () => {
        const app = await createTestApp();
        await pairDevice(app);
        const db = await getDatabase();
        const changes = async () => (await db.get<{ n: number }>('SELECT total_changes() AS n'))!.n;

        await WitnessService.stampDeviceModel(DEVICE, { model: 'HA9920', modelName: 'Legends Ultimate' });
        const afterFirst = await changes();
        for (let i = 0; i < 5; i++) {
            await WitnessService.stampDeviceModel(DEVICE, { model: 'HA9920', modelName: 'Legends Ultimate' });
            await WitnessService.stampDeviceModel(DEVICE, {});
        }
        expect(await changes()).toBe(afterFirst);

        await WitnessService.stampDeviceModel(DEVICE, { model: 'HA9921' });
        expect(await changes()).toBe(afterFirst + 1);
        expect(await stored()).toEqual({ device_model: 'HA9921', device_model_name: 'Legends Ultimate' });
    });
});

describe('W73 device reads carry the model', () => {
    it('Account Settings list and the runner page', async () => {
        const app = await createTestApp();
        const { token } = await pairDevice(app);
        const auth = { Authorization: `Bearer ${playerToken(USER)}` };

        let res = await request(app).get('/api/me/witness/devices').set(auth);
        expect(res.body[0]).toMatchObject({ deviceModel: null, deviceModelName: null });

        const roomId = await createTestRoom('w73', 'W73 Room');
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, USER, roomId);
        await request(app).get('/api/witness/heartbeat').query({ device: DEVICE, token, model: 'HA9920', model_name: 'Legends Ultimate' });

        res = await request(app).get('/api/me/witness/devices').set(auth);
        expect(res.body[0]).toMatchObject({ deviceModel: 'HA9920', deviceModelName: 'Legends Ultimate' });
        const view = await WitnessAdminViewService.roomDevices(roomId);
        expect(view.devices[0]).toMatchObject({ deviceModel: 'HA9920', deviceModelName: 'Legends Ultimate' });
    });
});
