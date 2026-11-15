import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase, _resetForTesting } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessLogService } from '../services/WitnessLogService.js';
import { WitnessService } from '../services/WitnessService.js';
import { OpsAlertService } from '../services/OpsAlertService.js';

/**
 * W105 (v2.249.0, ADR 0040 addendum) - `GET /api/witness/logs/request`, the
 * cabinet tile's SEND LOGS TO ARCAID SUPPORT.
 *
 * Pinned, worst-bug-first:
 *   1. It is the player's own Get logs request (same service, rules, expiry
 *      and audit row), made for the device's paired player; bare 401 like
 *      every device route, a service refusal keeps its code (400).
 *   2. `requested` for a new request, `pending` (same id, now marked) when one
 *      is already waiting; the heartbeat still carries `logs` unchanged.
 *   3. SHARE ON RECEIPT: when the bundle arrives it is sent to Arcaid support
 *      through the player's own path (share + audit + operator alert), ONCE;
 *      a request the player started from Account Settings is not.
 *   4. Migration 216 is idempotent.
 */

const USER = '123456789012345678';

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const auth = (user = USER) => ({ Authorization: `Bearer ${playerToken(user)}` });
const superAuth = () => ({
    Authorization: `Bearer ${signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' })}`,
});

/** A minimal POSIX ustar archive, the way the cabinet writes one. */
function ustar(entries: Array<{ name: string; data: Buffer }>): Buffer {
    const blocks: Buffer[] = [];
    for (const e of entries) {
        const h = Buffer.alloc(512, 0);
        h.write(e.name, 0, 100, 'latin1');
        h.write('0000644\0', 100, 'latin1');
        h.write('0000000\0', 108, 'latin1');
        h.write('0000000\0', 116, 'latin1');
        h.write(`${e.data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
        h.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
        h.write('        ', 148, 'latin1');
        h.write('0', 156, 'latin1');
        h.write('ustar\0', 257, 'latin1');
        h.write('00', 263, 'latin1');
        let sum = 0;
        for (const b of h) sum += b;
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
        blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

const TAR = ustar([
    { name: 'manifest.txt', data: Buffer.from('build 1.1.1\nwitness.log 42\n') },
    { name: 'witness.log', data: Buffer.from('x'.repeat(2000)) },
]);

let tmpRoot: string;
let app: express.Express;
let token: string;
// One device id per test: the device limiter (120/min per id) is a module-level counter for the whole file.
let deviceSeq = 0;
let CABINET: string;

async function pair(user: string, deviceId: string): Promise<string> {
    const { code } = await WitnessService.createPairingCode(user);
    return (await WitnessService.redeemPairingCode(code, deviceId, null, 'atgames')).token;
}

const press = (device = CABINET, tok: string | null = token) =>
    request(app).get('/api/witness/logs/request').query({ device, ...(tok !== null ? { token: tok } : {}) });
const beat = (v = '1.1.1') =>
    request(app).get('/api/witness/heartbeat').query({ device: CABINET, token, v });
const sendTar = (requestId: string) =>
    request(app).post('/api/witness/logs')
        .query({ device: CABINET, token, request: requestId, v: '1.1.1' })
        .set('Content-Type', 'application/x-tar')
        .send(TAR);
const playerList = async () =>
    (await request(app).get('/api/me/witness/log-requests').set(auth())).body.requests as Array<Record<string, unknown>>;
const rowOf = async (id: string) => (await getDatabase()).get<{ status: string; share_on_receipt: number; shared_at: string | null; canonical_user_id: string }>(
    `SELECT status, share_on_receipt, shared_at, canonical_user_id FROM witness_log_requests WHERE id = ?`, id,
);
const auditCount = async (action: string) => (await (await getDatabase()).get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM audit_log WHERE action = ? AND target_id = ?`, action, CABINET,
))!.n;

beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-devlogs-'));
    WitnessLogService.setRootForTests(tmpRoot);
    await setupTestDb();
    app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    app.use('/api', globalRouter);
    deviceSeq += 1;
    CABINET = `CAB000000000${String(deviceSeq).padStart(4, '0')}`;
    token = await pair(USER, CABINET);
    expect((await beat()).status).toBe(200); // the cabinet reports 1.1.1
});
afterEach(() => {
    vi.restoreAllMocks();
    WitnessLogService.setRootForTests(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('auth and refusals', () => {
    it('a bare 401 for no token, a wrong token and an unknown device; nothing is created', async () => {
        for (const res of [await press(CABINET, null), await press(CABINET, 'wrong'), await press('NOT-A-DEVICE')]) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ ok: false });
        }
        const db = await getDatabase();
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM witness_log_requests`))!.n).toBe(0);
    });

    it('a refusal of the request service is a 400 with its own code (a cabinet below 1.1.0)', async () => {
        expect((await beat('1.0.9')).status).toBe(200);
        const res = await press();
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, code: 'LOGS_UNSUPPORTED' });
    });
});

describe('requested / pending', () => {
    it('requested: a new request for the paired player, marked share on receipt, audited, in the player list', async () => {
        const res = await press();
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, status: 'requested', id: res.body.id });
        expect(res.body.id).toMatch(/^[0-9a-f]{32}$/);
        expect(res.headers['cache-control']).toBe('no-store');

        const row = (await rowOf(res.body.id))!;
        expect(row).toMatchObject({ status: 'pending', share_on_receipt: 1, shared_at: null, canonical_user_id: USER });
        expect(await auditCount('witness_log_request')).toBe(1);
        const audit = await (await getDatabase()).get<{ actor: string; details: string }>(
            `SELECT actor, details FROM audit_log WHERE action = 'witness_log_request' AND target_id = ?`, CABINET,
        );
        expect(audit!.actor).toBe(USER);
        expect(JSON.parse(audit!.details)).toEqual({ requestId: res.body.id, shareOnReceipt: true });

        // The player's Account Settings list shows it like any other request.
        const list = await playerList();
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: res.body.id, deviceId: CABINET, status: 'pending', sharedAt: null });

        // The beacon's heartbeat carries it exactly as for a player's request.
        const hb = await beat();
        expect(hb.body.logs).toBe(res.body.id);
    });

    it('pending: a second press answers the same id and creates nothing', async () => {
        const first = await press();
        const second = await press();
        expect(second.status).toBe(200);
        expect(second.body).toEqual({ ok: true, status: 'pending', id: first.body.id });
        const db = await getDatabase();
        expect((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM witness_log_requests`))!.n).toBe(1);
        expect(await auditCount('witness_log_request')).toBe(1);
    });

    it('pending: a request the player started is answered and now also marked share on receipt', async () => {
        const ask = await request(app).post(`/api/me/witness/devices/${CABINET}/log-requests`).set(auth()).send({});
        expect(ask.status).toBe(201);
        expect((await rowOf(ask.body.request.id))!.share_on_receipt).toBe(0);
        const res = await press();
        expect(res.body).toEqual({ ok: true, status: 'pending', id: ask.body.request.id });
        expect((await rowOf(ask.body.request.id))!.share_on_receipt).toBe(1);
    });

    it('same expiry: a pending request past 15 minutes expires and the next press is a new one', async () => {
        const first = await press();
        const db = await getDatabase();
        await db.run(`UPDATE witness_log_requests SET requested_at = datetime('now', '-16 minutes') WHERE id = ?`, first.body.id);
        const next = await press();
        expect(next.body.status).toBe('requested');
        expect(next.body.id).not.toBe(first.body.id);
        expect((await rowOf(first.body.id))!.status).toBe('expired');
    });
});

describe('share on receipt', () => {
    it('the bundle goes to Arcaid support when it arrives: shared, audited, the operator alerted, once', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Krobs')`, USER);
        await db.run(`UPDATE witness_devices SET device_model_name = 'Legends Ultimate' WHERE atgames_unique_id = ?`, CABINET);
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();

        const { body } = await press();
        expect(alert).not.toHaveBeenCalled();
        expect((await sendTar(body.id)).status).toBe(200);

        expect(alert).toHaveBeenCalledTimes(1);
        const text = alert.mock.calls[0]![0];
        expect(text).toContain('Witness logs sent to Arcaid support by Krobs.');
        expect(text).toContain('Cabinet: Legends Ultimate');
        expect(text).not.toContain('Note:');
        expect(text).not.toContain(USER);

        const row = (await rowOf(body.id))!;
        expect(row.status).toBe('ready');
        expect(row.shared_at).toBeTruthy();
        expect(await auditCount('witness_log_share')).toBe(1);
        const audit = await db.get<{ actor: string; details: string }>(
            `SELECT actor, details FROM audit_log WHERE action = 'witness_log_share' AND target_id = ?`, CABINET,
        );
        expect(audit!.actor).toBe(USER);
        expect(JSON.parse(audit!.details)).toEqual({ requestId: body.id, onReceipt: true });

        // Account Settings shows it as sent; the super-admin can read it.
        const list = await playerList();
        expect(list[0]).toMatchObject({ id: body.id, status: 'ready' });
        expect(typeof list[0]!.sharedAt).toBe('string');
        expect(Date.parse(list[0]!.expiresAt as string) - Date.parse(list[0]!.sharedAt as string)).toBe(30 * 86_400_000);
        const shared = await request(app).get('/api/admin/witness/shared-logs').set(superAuth());
        expect(shared.body.logs.map((l: { id: string }) => l.id)).toEqual([body.id]);

        // A second upload of the same id is refused and alerts nobody again.
        const again = await sendTar(body.id);
        expect(again.status).toBe(404);
        expect(alert).toHaveBeenCalledTimes(1);
        expect(await auditCount('witness_log_share')).toBe(1);
    });

    it('a request the player started in Account Settings is NOT shared on receipt', async () => {
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const ask = await request(app).post(`/api/me/witness/devices/${CABINET}/log-requests`).set(auth()).send({});
        expect((await sendTar(ask.body.request.id)).status).toBe(200);
        expect(alert).not.toHaveBeenCalled();
        expect((await rowOf(ask.body.request.id))!.shared_at).toBeNull();
        expect(await auditCount('witness_log_share')).toBe(0);
        // The player's request is still audited as before (the audit moved into the service).
        expect(await auditCount('witness_log_request')).toBe(1);
        const audit = await (await getDatabase()).get<{ details: string }>(
            `SELECT details FROM audit_log WHERE action = 'witness_log_request' AND target_id = ?`, CABINET,
        );
        expect(JSON.parse(audit!.details)).toEqual({ requestId: ask.body.request.id });
    });

    it('a player-started request the tile then marked is shared when it arrives', async () => {
        const alert = vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const ask = await request(app).post(`/api/me/witness/devices/${CABINET}/log-requests`).set(auth()).send({});
        await press();
        expect((await sendTar(ask.body.request.id)).status).toBe(200);
        expect(alert).toHaveBeenCalledTimes(1);
        expect((await rowOf(ask.body.request.id))!.shared_at).toBeTruthy();
    });

    it('a failing alert never fails the upload, and the bundle is still marked sent', async () => {
        vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockImplementation(() => { throw new Error('discord down'); });
        const { body } = await press();
        const res = await sendTar(body.id);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect((await rowOf(body.id))!.shared_at).toBeTruthy();
    });
});

describe('fresh logs while an older bundle is there (owner, 2026-11-15)', () => {
    const ask = () => request(app).post(`/api/me/witness/devices/${CABINET}/log-requests`).set(auth()).send({});
    const download = (id: string) => request(app).get(`/api/me/witness/log-requests/${id}/download`).set(auth());
    const fileFor = (id: string) => path.join(tmpRoot, `${id}.tar`);
    const readyBundle = async () => {
        const res = await ask();
        expect(res.status).toBe(201);
        expect((await sendTar(res.body.request.id)).status).toBe(200);
        return res.body.request.id as string;
    };

    it('the player asks again with a bundle there; the old one stays downloadable until the new one replaces it', async () => {
        const old = await readyBundle();
        const fresh = await ask();
        expect(fresh.status).toBe(201);
        expect(fresh.body.request.status).toBe('pending');
        expect(fresh.body.request.id).not.toBe(old);

        // While the fresh request waits: both listed, the old bundle still downloads.
        let list = await playerList();
        expect(list.map(r => [r.id, r.status])).toEqual([[fresh.body.request.id, 'pending'], [old, 'ready']]);
        expect((await download(old)).status).toBe(200);

        // The fresh bundle lands and replaces the old one, row and file.
        expect((await sendTar(fresh.body.request.id)).status).toBe(200);
        list = await playerList();
        expect(list.map(r => [r.id, r.status])).toEqual([[fresh.body.request.id, 'ready']]);
        expect(await rowOf(old)).toBeUndefined();
        expect(fs.existsSync(fileFor(old))).toBe(false);
        expect(fs.existsSync(fileFor(fresh.body.request.id))).toBe(true);
        expect((await download(old)).status).toBe(404);
        expect((await download(fresh.body.request.id)).status).toBe(200);
    });

    it('a cabinet press is never refused because an older bundle is there, and its bundle replaces it too', async () => {
        vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const old = await readyBundle();
        const res = await press();
        expect(res.body).toMatchObject({ ok: true, status: 'requested' });
        expect((await sendTar(res.body.id)).status).toBe(200);
        expect(await rowOf(old)).toBeUndefined();
        expect((await rowOf(res.body.id))!.shared_at).toBeTruthy();
    });

    it('an older bundle already sent to Arcaid support is kept; only unsent ones are replaced', async () => {
        vi.spyOn(OpsAlertService, 'sendOperatorAlert').mockResolvedValue();
        const sent = await readyBundle();
        expect((await request(app).post(`/api/me/witness/log-requests/${sent}/share`).set(auth()).send({})).status).toBe(200);
        const fresh = await readyBundle();
        expect((await rowOf(sent))!.shared_at).toBeTruthy();
        expect(fs.existsSync(fileFor(sent))).toBe(true);
        expect((await rowOf(fresh))!.status).toBe('ready');
    });

    it('another device\'s bundle is not replaced', async () => {
        const otherDevice = `${CABINET}-B`;
        const otherToken = await pair(USER, otherDevice);
        expect((await request(app).get('/api/witness/heartbeat').query({ device: otherDevice, token: otherToken, v: '1.1.1' })).status).toBe(200);
        const theirs = await request(app).post(`/api/me/witness/devices/${otherDevice}/log-requests`).set(auth()).send({});
        expect((await request(app).post('/api/witness/logs')
            .query({ device: otherDevice, token: otherToken, request: theirs.body.request.id, v: '1.1.1' })
            .set('Content-Type', 'application/x-tar').send(TAR)).status).toBe(200);
        await readyBundle();
        expect((await rowOf(theirs.body.request.id))!.status).toBe('ready');
    });

    it('a received bundle stays in the list behind more than ten newer requests', async () => {
        const old = await readyBundle();
        const db = await getDatabase();
        for (let i = 0; i < 12; i++) {
            await db.run(
                `INSERT INTO witness_log_requests (id, atgames_unique_id, canonical_user_id, status, fail_reason, requested_at)
                 VALUES (?, ?, ?, 'expired', 'no_answer', datetime('now', ?))`,
                randomBytes(16).toString('hex'), CABINET, USER, `+${i + 1} seconds`,
            );
        }
        const list = await playerList();
        expect(list).toHaveLength(11);
        expect(list[list.length - 1]).toMatchObject({ id: old, status: 'ready' });
        expect(list.slice(0, 10).every(r => r.status === 'expired')).toBe(true);
    });
});

describe('migration 216', () => {
    it('adds share_on_receipt (default 0) and re-running it changes nothing', async () => {
        const tmpPath = path.join(os.tmpdir(), `arcaid-216-${Date.now()}-${randomBytes(4).toString('hex')}.db`);
        const originalDbPath = process.env.DB_PATH;
        try {
            process.env.DB_PATH = tmpPath;
            await _resetForTesting();
            let db = await getDatabase();
            const colsOf = async () => ((await db.all(`PRAGMA table_info(witness_log_requests)`)) as Array<{ name: string; dflt_value: string | null; notnull: number }>)
                .filter(c => c.name === 'share_on_receipt');
            expect(await colsOf()).toEqual([expect.objectContaining({ name: 'share_on_receipt', dflt_value: '0', notnull: 1 })]);
            expect(await db.get(`SELECT id FROM schema_migrations WHERE name = '216_witness_log_share_on_receipt'`)).toBeTruthy();
            await db.run(
                `INSERT INTO witness_log_requests (id, atgames_unique_id, canonical_user_id, status) VALUES (?, 'CAB', ?, 'pending')`,
                'c'.repeat(32), USER,
            );

            // Forget it ran, reopen: the handler runs again over the existing column.
            await db.run(`DELETE FROM schema_migrations WHERE name = '216_witness_log_share_on_receipt'`);
            await _resetForTesting();
            db = await getDatabase();
            expect(await colsOf()).toHaveLength(1);
            expect(await db.get(`SELECT id FROM schema_migrations WHERE name = '216_witness_log_share_on_receipt'`)).toBeTruthy();
            expect((await db.get<{ share_on_receipt: number }>(
                `SELECT share_on_receipt FROM witness_log_requests WHERE id = ?`, 'c'.repeat(32),
            ))!.share_on_receipt).toBe(0);
        } finally {
            await _resetForTesting();
            process.env.DB_PATH = originalDbPath;
            for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${tmpPath}${suffix}`, { force: true });
        }
    // Two full migration runs against a real file (the in-memory DB cannot be reopened).
    }, 120_000);
});
