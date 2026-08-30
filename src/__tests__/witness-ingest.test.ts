import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessService } from '../services/WitnessService.js';

/**
 * P8 — Arcaid Witness ingest (device pairing + launch observations).
 *
 * The device reports over synchronous GETs (the AtGames SDK offers no POST),
 * so the whole auth model hangs on a device-scoped token in a query string.
 * What these tests pin, worst-bug-first:
 *
 *   1. A stolen or wrong token writes NOTHING, and the endpoint never reveals
 *      which of device/token was wrong.
 *   2. The device token is never stored in the clear.
 *   3. A pairing code is single-use and short-lived, and a cabinet can't be
 *      hijacked onto a second Arcaid account.
 *   4. A repeated report (the device retries a GET it never saw answered) is a
 *      no-op, not a duplicate.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const USER = '123456789012345678';
const OTHER = '999999999999999999';
const DEVICE = 'fp-device-uuid-0001';
const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

/** Mint a code (as the player would) and redeem it (as the device would). */
async function pairDevice(app: express.Express, user = USER, device = DEVICE) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(user)}`).send({});
    const code = codeRes.body.code as string;
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code, device, username: 'PlayerOne' });
    return { code, token: pairRes.body.token as string, pairRes };
}

describe('Witness ingest', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('pairs a device and issues a token that is never stored in the clear', async () => {
        const { token } = await pairDevice(app);
        expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);

        const db = await getDatabase();
        const row = await db.get<{ token_hash: string; canonical_user_id: string }>(
            'SELECT token_hash, canonical_user_id FROM witness_devices WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(row?.canonical_user_id).toBe(USER);
        // The stored value is a hash, not the token.
        expect(row?.token_hash).not.toBe(token);
        expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('records a report from a paired device with the right token', async () => {
        const { token } = await pairDevice(app);
        const res = await request(app).get('/api/witness/report').query({
            device: DEVICE, token, table: 'aerobatics', launch: 1756200000, exit: 1756200073, dur: 73,
        });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const db = await getDatabase();
        const obs = await db.get<{ table_name: string; launch_ts: number; duration_sec: number; canonical_user_id: string }>(
            'SELECT table_name, launch_ts, duration_sec, canonical_user_id FROM witness_observations WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(obs).toMatchObject({
            table_name: 'aerobatics', launch_ts: 1756200000, duration_sec: 73, canonical_user_id: USER,
        });
    });

    it('rejects a wrong token with a bare 401, writing nothing', async () => {
        await pairDevice(app);
        const res = await request(app).get('/api/witness/report').query({
            device: DEVICE, token: 'not-the-real-token', table: 'aerobatics', launch: 1756200000,
        });
        expect(res.status).toBe(401);
        // No detail — the endpoint never says whether device or token was wrong.
        expect(res.body).toEqual({ ok: false });

        const db = await getDatabase();
        const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_observations');
        expect(count?.n).toBe(0);
    });

    it('rejects a report for an unknown device', async () => {
        const res = await request(app).get('/api/witness/report').query({
            device: 'never-paired', token: 'whatever', table: 'x', launch: 1,
        });
        expect(res.status).toBe(401);
    });

    it('is idempotent — a re-reported (device, table, launch) does not duplicate', async () => {
        const { token } = await pairDevice(app);
        const q = { device: DEVICE, token, table: 'aerobatics', launch: 1756200000, exit: 1756200073, dur: 73 };
        await request(app).get('/api/witness/report').query(q);
        await request(app).get('/api/witness/report').query(q);

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM witness_observations WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(count?.n).toBe(1);
    });

    it('accepts the token via the x-witness-token header too', async () => {
        const { token } = await pairDevice(app);
        const res = await request(app)
            .get('/api/witness/report')
            .set('x-witness-token', token)
            .query({ device: DEVICE, table: 'aerobatics', launch: 1756200001 });
        expect(res.status).toBe(200);
    });

    it('stops accepting reports after the device is unpaired', async () => {
        const { token } = await pairDevice(app);
        const del = await request(app)
            .delete(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(del.status).toBe(200);

        const res = await request(app).get('/api/witness/report').query({
            device: DEVICE, token, table: 'aerobatics', launch: 1756200000,
        });
        expect(res.status).toBe(401);
    });
});

describe('Witness report — the retro tag (v2.148.0, ADR 0021)', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    const viaOf = async (launch: number) => {
        const db = await getDatabase();
        const row = await db.get<{ via: string }>(
            'SELECT via FROM witness_observations WHERE atgames_unique_id = ? AND launch_ts = ?',
            DEVICE, launch,
        );
        return row?.via;
    };

    it('stores via=retro when the device says so', async () => {
        const { token } = await pairDevice(app);
        await request(app).get('/api/witness/report').query({
            device: DEVICE, token, table: 'aerobatics', launch: 1756200000, exit: 1756200073, via: 'retro',
        });
        expect(await viaOf(1756200000)).toBe('retro');
    });

    it('defaults to live when via is absent', async () => {
        const { token } = await pairDevice(app);
        await request(app).get('/api/witness/report').query({
            device: DEVICE, token, table: 'aerobatics', launch: 1756200100, exit: 1756200173,
        });
        expect(await viaOf(1756200100)).toBe('live');
    });

    it('coerces any other value to live — a typo must never mark a live report retro', async () => {
        const { token } = await pairDevice(app);
        await request(app).get('/api/witness/report').query({
            device: DEVICE, token, table: 'aerobatics', launch: 1756200200, exit: 1756200273, via: 'RETRO-ish',
        });
        expect(await viaOf(1756200200)).toBe('live');
    });

    it('does not let a re-report overwrite the via of an existing row (first writer wins)', async () => {
        const { token } = await pairDevice(app);
        const base = { device: DEVICE, token, table: 'aerobatics', launch: 1756200300 };
        await request(app).get('/api/witness/report').query({ ...base, exit: 1756200373, via: 'retro' });
        // A live report of the same session must not overstate what was seen…
        await request(app).get('/api/witness/report').query({ ...base, exit: 1756200373 });
        expect(await viaOf(1756200300)).toBe('retro');
    });
});

describe('Witness check-in (tier 2, ADR 0021)', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('records a server-stamped check-in and touches last_seen_at', async () => {
        const { token } = await pairDevice(app);
        const res = await request(app).get('/api/witness/checkin').query({ device: DEVICE, token });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        // The returned ts IS the stored one — the cabinet has nothing else to go on.
        expect(res.body.ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

        const db = await getDatabase();
        const row = await db.get<{ canonical_user_id: string; server_ts: string }>(
            'SELECT canonical_user_id, server_ts FROM witness_checkins WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(row?.canonical_user_id).toBe(USER);
        expect(row?.server_ts).toBe(res.body.ts);

        const device = await db.get<{ last_seen_at: string | null }>(
            'SELECT last_seen_at FROM witness_devices WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(device?.last_seen_at).toBeTruthy();
    });

    it('never accepts a client-supplied timestamp — the whole point of tier 2', async () => {
        const { token } = await pairDevice(app);
        // Anything the device sends about the time is ignored: a check-in whose
        // time the device chooses is a self-report worth nothing.
        const res = await request(app).get('/api/witness/checkin')
            .query({ device: DEVICE, token, ts: 1, server_ts: '1999-01-01 00:00:00' });
        expect(res.status).toBe(200);
        expect(res.body.ts.startsWith('1999')).toBe(false);
    });

    it('rejects an unknown device with a bare 401, writing nothing', async () => {
        const res = await request(app).get('/api/witness/checkin').query({ device: 'never-paired', token: 'x' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });

        const db = await getDatabase();
        const count = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_checkins');
        expect(count?.n).toBe(0);
    });

    it('rejects a wrong token with the same undifferentiated 401', async () => {
        await pairDevice(app);
        const res = await request(app).get('/api/witness/checkin').query({ device: DEVICE, token: 'nope' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });
    });

    it('stops accepting check-ins after the device is unpaired', async () => {
        const { token } = await pairDevice(app);
        await request(app)
            .delete(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`);

        const res = await request(app).get('/api/witness/checkin').query({ device: DEVICE, token });
        expect(res.status).toBe(401);
    });

    it('accepts the token via the x-witness-token header too', async () => {
        const { token } = await pairDevice(app);
        const res = await request(app)
            .get('/api/witness/checkin').set('x-witness-token', token).query({ device: DEVICE });
        expect(res.status).toBe(200);
    });

    it('keeps EVERY check-in — each one is another attestation point', async () => {
        const { token } = await pairDevice(app);
        await request(app).get('/api/witness/checkin').query({ device: DEVICE, token });
        await request(app).get('/api/witness/checkin').query({ device: DEVICE, token });

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM witness_checkins WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(count?.n).toBe(2);
    });
});

describe('Witness pairing codes', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('a pairing code is single-use', async () => {
        const { code } = await pairDevice(app);
        // Second redemption of the same code fails.
        const again = await request(app).get('/api/witness/pair').query({ code, device: 'another-device' });
        expect(again.status).toBe(400);
        expect(again.body.code).toBe('CODE_USED');
    });

    it('refuses hijacking a cabinet onto a different account', async () => {
        await pairDevice(app, USER, DEVICE);
        // OTHER mints their own code and tries to claim the SAME device.
        const other = await request(app)
            .post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(OTHER)}`).send({});
        const res = await request(app).get('/api/witness/pair').query({ code: other.body.code, device: DEVICE });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DEVICE_CONFLICT');
    });

    it('lets the SAME owner re-pair (token rotation)', async () => {
        const first = await pairDevice(app, USER, DEVICE);
        const second = await pairDevice(app, USER, DEVICE);
        expect(second.token).not.toBe(first.token);
        // The old token no longer works; the new one does.
        const oldTok = await request(app).get('/api/witness/report').query({
            device: DEVICE, token: first.token, table: 't', launch: 1,
        });
        expect(oldTok.status).toBe(401);
        const newTok = await request(app).get('/api/witness/report').query({
            device: DEVICE, token: second.token, table: 't', launch: 1,
        });
        expect(newTok.status).toBe(200);
    });

    it('rejects an expired code', async () => {
        const res = await request(app)
            .post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        const code = res.body.code as string;
        // Expire it directly.
        const db = await getDatabase();
        await db.run(`UPDATE witness_pairing_codes SET expires_at = datetime('now','-1 minute') WHERE code = ?`, code);
        const pair = await request(app).get('/api/witness/pair').query({ code, device: DEVICE });
        expect(pair.status).toBe(400);
        expect(pair.body.code).toBe('CODE_EXPIRED');
    });

    it('minting a new code invalidates the player\'s previous unconsumed code', async () => {
        const first = await request(app)
            .post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        await request(app)
            .post('/api/me/witness/pairing-code')
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        // The first code is now expired.
        const pair = await request(app).get('/api/witness/pair').query({ code: first.body.code, device: DEVICE });
        expect(pair.status).toBe(400);
        expect(pair.body.code).toBe('CODE_EXPIRED');
    });

    it('lists and unpairs devices for the owner only', async () => {
        await pairDevice(app, USER, DEVICE);
        const mine = await request(app)
            .get('/api/me/witness/devices')
            .set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(mine.body).toHaveLength(1);
        expect(mine.body[0]).toMatchObject({ atgamesUniqueId: DEVICE, atgamesUsername: 'PlayerOne' });

        // OTHER cannot see or unpair it.
        const theirs = await request(app)
            .get('/api/me/witness/devices')
            .set('Authorization', `Bearer ${playerToken(OTHER)}`);
        expect(theirs.body).toHaveLength(0);
        const del = await request(app)
            .delete(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`);
        expect(del.status).toBe(404);
    });
});

describe('WitnessService — direct', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('derives duration from exit when not supplied', async () => {
        await WitnessService.createPairingCode(USER);
        const db = await getDatabase();
        const code = (await db.get<{ code: string }>('SELECT code FROM witness_pairing_codes WHERE canonical_user_id = ?', USER))!.code;
        const { token } = await WitnessService.redeemPairingCode(code, DEVICE, 'P');

        await WitnessService.recordObservation({
            atgamesUniqueId: DEVICE, token, tableName: 'x', launchTs: 1000, exitTs: 1050,
        });
        const obs = await db.get<{ duration_sec: number }>(
            'SELECT duration_sec FROM witness_observations WHERE atgames_unique_id = ?', DEVICE,
        );
        expect(obs?.duration_sec).toBe(50);
    });
});
