import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessService, parseAppVersion } from '../services/WitnessService.js';
import { WitnessAdminViewService } from '../services/WitnessAdminViewService.js';

/**
 * W60 - which Witness build is each paired device running. The cabinet (1.0.8+)
 * appends `v=<version>` to /witness/checkin and /witness/heartbeat.
 *
 * Pinned, worst-bug-first:
 *   1. A bad or odd `v` NEVER refuses the call (the cabinet never retries a 200).
 *   2. A device that sends no `v` keeps whatever is stored.
 *   3. The row is rewritten only when the value changes or the stamp is stale.
 *   4. Both routes share the rule, and both device reads carry the fields.
 */

const USER = '123456789012345678';
const DEVICE = 'fp-device-uuid-w60';
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

async function pairDevice(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: DEVICE, username: 'PlayerOne' });
    return pairRes.body.token as string;
}

async function stored() {
    const db = await getDatabase();
    return (await db.get<{ app_version: string | null; app_version_at: string | null }>(
        'SELECT app_version, app_version_at FROM witness_devices WHERE atgames_unique_id = ?', DEVICE,
    ))!;
}

describe('parseAppVersion', () => {
    it('accepts plain dotted versions with an optional suffix', () => {
        expect(parseAppVersion('1.0.8')).toBe('1.0.8');
        expect(parseAppVersion(' 1.0.8 ')).toBe('1.0.8');
        expect(parseAppVersion('1.0')).toBe('1.0');
        expect(parseAppVersion('1.0.8.2')).toBe('1.0.8.2');
        expect(parseAppVersion('1.0.8-rc2')).toBe('1.0.8-rc2');
    });

    it('ignores anything else', () => {
        for (const bad of [undefined, null, '', '   ', '1', 'v1.0.8', '1.0.8; DROP TABLE', '<b>1.0.8</b>',
            '1.0.8.2.3', '1.0.x', '1.0.8-', ['1.0.8'], { a: 1 }, 108, '1.0.8-' + 'a'.repeat(40)]) {
            expect(parseAppVersion(bad)).toBeNull();
        }
    });
});

describe.each(['checkin', 'heartbeat'] as const)('W60 app version on /witness/%s', (route) => {
    let app: express.Express;
    let token: string;
    beforeEach(async () => {
        app = await createTestApp();
        token = await pairDevice(app);
    });

    const hit = (v?: unknown) => request(app).get(`/api/witness/${route}`)
        .query(v === undefined ? { device: DEVICE, token } : { device: DEVICE, token, v: v as string });

    it('stores a valid version with a stamp', async () => {
        expect(await stored()).toEqual({ app_version: null, app_version_at: null });
        const res = await hit('1.0.8');
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        const row = await stored();
        expect(row.app_version).toBe('1.0.8');
        expect(row.app_version_at).toBeTruthy();
    });

    it('answers 200 and stores nothing for an unusable version', async () => {
        for (const bad of ['garbage!', 'v1.0.8', '9'.repeat(50), '1.0.8; --']) {
            const res = await hit(bad);
            expect(res.status).toBe(200);
            expect(res.body.ok).toBe(true);
        }
        expect(await stored()).toEqual({ app_version: null, app_version_at: null });
    });

    it('a call with no v keeps what is stored', async () => {
        await hit('1.0.8');
        const before = await stored();
        const res = await hit();
        expect(res.status).toBe(200);
        expect(await stored()).toEqual(before);
    });

    it('does not rewrite an unchanged, fresh value', async () => {
        await hit('1.0.8');
        const db = await getDatabase();
        // Park the stamp at a recognisable recent moment; a rewrite would move it to now.
        await db.run(`UPDATE witness_devices SET app_version_at = datetime('now', '-10 minutes') WHERE atgames_unique_id = ?`, DEVICE);
        const parked = await stored();
        await hit('1.0.8');
        expect(await stored()).toEqual(parked);
    });

    it('rewrites when the value changes', async () => {
        await hit('1.0.7');
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version_at = datetime('now', '-10 minutes') WHERE atgames_unique_id = ?`, DEVICE);
        const parked = await stored();
        await hit('1.0.8');
        const row = await stored();
        expect(row.app_version).toBe('1.0.8');
        expect(row.app_version_at).not.toBe(parked.app_version_at);
    });

    it('re-stamps an unchanged value once the stamp is over an hour old', async () => {
        await hit('1.0.8');
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version_at = datetime('now', '-2 hours') WHERE atgames_unique_id = ?`, DEVICE);
        const parked = await stored();
        await hit('1.0.8');
        const row = await stored();
        expect(row.app_version).toBe('1.0.8');
        expect(row.app_version_at).not.toBe(parked.app_version_at);
    });

    it('a wrong token is still a bare 401 and stores nothing', async () => {
        const res = await request(app).get(`/api/witness/${route}`).query({ device: DEVICE, token: 'nope', v: '1.0.8' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });
        expect(await stored()).toEqual({ app_version: null, app_version_at: null });
    });
});

describe('W60 device reads carry appVersion / appVersionAt', () => {
    let app: express.Express;
    beforeEach(async () => {
        app = await createTestApp();
    });

    it('GET /api/me/witness/devices: null before a report, the build after', async () => {
        const token = await pairDevice(app);
        const auth = { Authorization: `Bearer ${playerToken(USER)}` };

        let res = await request(app).get('/api/me/witness/devices').set(auth);
        expect(res.status).toBe(200);
        expect(res.body[0]).toMatchObject({ atgamesUniqueId: DEVICE, appVersion: null, appVersionAt: null });

        await request(app).get('/api/witness/heartbeat').query({ device: DEVICE, token, v: '1.0.8' });
        res = await request(app).get('/api/me/witness/devices').set(auth);
        expect(res.body[0].appVersion).toBe('1.0.8');
        expect(res.body[0].appVersionAt).toBeTruthy();
        expect((await WitnessService.listDevices(USER))[0].appVersion).toBe('1.0.8');
    });

    it('WitnessAdminViewService.roomDevices (the runner page): same fields', async () => {
        const token = await pairDevice(app);
        const roomId = await createTestRoom('w60', 'W60 Room');
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'claim')`, USER, roomId);

        let view = await WitnessAdminViewService.roomDevices(roomId);
        expect(view.devices).toEqual([expect.objectContaining({ deviceId: DEVICE, appVersion: null, appVersionAt: null })]);

        await request(app).get('/api/witness/checkin').query({ device: DEVICE, token, v: '1.0.8' });
        view = await WitnessAdminViewService.roomDevices(roomId);
        expect(view.devices[0].appVersion).toBe('1.0.8');
        expect(view.devices[0].appVersionAt).toBeTruthy();
    });
});
