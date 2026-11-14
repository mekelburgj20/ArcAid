import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessLogService, looksLikeTar } from '../services/WitnessLogService.js';
import { WitnessService } from '../services/WitnessService.js';

/**
 * W99 (v2.245.0, ADR 0040) - a cabinet sends its logs when its player asks.
 *
 * Pinned, worst-bug-first:
 *   1. The bundle is the player's: nobody else can list, download or delete
 *      it, and a request id alone opens nothing.
 *   2. pending -> ready (upload; the download gunzips to the uploaded bytes),
 *      failed (the cabinet said why), expired (15 minutes, decided lazily).
 *   3. The heartbeat carries `logs` only while a request is pending; the
 *      upload's refusals are the contract's (401 / 404 / 413 / 400).
 *   4. Only a cabinet on 1.1.0+ can be asked (409 LOGS_UNSUPPORTED);
 *      unpairing deletes the device's requests and files.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'CAB0000000000001';

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const auth = (user = USER) => ({ Authorization: `Bearer ${playerToken(user)}` });

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

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
    { name: 'manifest.txt', data: Buffer.from('build 1.1.0\nwitness.log 42\n') },
    { name: 'witness.log', data: Buffer.from('x'.repeat(2000)) },
]);

let tmpRoot: string;
let app: express.Express;
let token: string;

async function createApp() {
    await setupTestDb();
    const a = express();
    a.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    a.use('/api', globalRouter);
    return a;
}

async function pair(user: string, deviceId: string, type?: 'desktop'): Promise<string> {
    const codeRes = await request(app).post('/api/me/witness/pairing-code').set(auth(user)).send({});
    const pairRes = await request(app).get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: deviceId, ...(type ? { type } : {}) });
    expect(pairRes.status).toBe(200);
    return pairRes.body.token as string;
}

const beat = (q: Record<string, string> = {}, device = CABINET, tok = token) =>
    request(app).get('/api/witness/heartbeat').query({ device, token: tok, v: '1.1.0', ...q });

const ask = (user = USER, device = CABINET) =>
    request(app).post(`/api/me/witness/devices/${device}/log-requests`).set(auth(user)).send({});

const sendTar = (requestId: string, body: Buffer, q: Record<string, string> = {}) =>
    request(app).post('/api/witness/logs')
        .query({ device: CABINET, token, request: requestId, v: '1.1.0', ...q })
        .set('Content-Type', 'application/x-tar')
        .send(body);

const fileFor = (id: string) => path.join(tmpRoot, `${id}.tar`);

beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-logs-'));
    WitnessLogService.setRootForTests(tmpRoot);
    app = await createApp();
    token = await pair(USER, CABINET);
    await beat(); // the cabinet reports 1.1.0
});
afterEach(() => {
    WitnessLogService.setRootForTests(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('W99 log pull: request -> heartbeat -> upload -> download', () => {
    it('pending -> ready; the download gunzips to the uploaded bytes', async () => {
        let res = await ask();
        expect(res.status).toBe(201);
        const req = res.body.request;
        expect(req).toMatchObject({ deviceId: CABINET, status: 'pending', readyAt: null, sizeBytes: null, failReason: null });
        expect(req.id).toMatch(/^[0-9a-f]{32}$/);
        expect(Date.parse(req.expiresAt) - Date.parse(req.requestedAt)).toBe(15 * 60_000);

        // A second ask while pending is the same request (200).
        res = await ask();
        expect(res.status).toBe(200);
        expect(res.body.request.id).toBe(req.id);
        const db = await getDatabase();
        expect((await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'witness_log_request' AND target_id = ?`, CABINET,
        ))!.n).toBe(1);

        // The heartbeat carries the id.
        res = await beat();
        expect(res.body.logs).toBe(req.id);

        res = await sendTar(req.id, TAR);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(fs.readFileSync(fileFor(req.id)).equals(TAR)).toBe(true);

        // No more `logs` on the heartbeat; a second upload is refused.
        expect('logs' in (await beat()).body).toBe(false);
        res = await sendTar(req.id, TAR);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false, code: 'NO_REQUEST' });

        res = await request(app).get('/api/me/witness/log-requests').set(auth());
        expect(res.status).toBe(200);
        expect(res.body.requests).toHaveLength(1);
        const ready = res.body.requests[0];
        expect(ready).toMatchObject({ id: req.id, status: 'ready', sizeBytes: TAR.length, failReason: null });
        expect(Date.parse(ready.expiresAt) - Date.parse(ready.readyAt)).toBe(7 * 86_400_000);

        res = await request(app).get(`/api/me/witness/log-requests/${req.id}/download`).set(auth())
            .buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/gzip');
        expect(res.headers['content-disposition']).toMatch(/^attachment; filename="arcaid-witness-logs-\d{8}-\d{4}\.tar\.gz"$/);
        expect(zlib.gunzipSync(res.body as Buffer).equals(TAR)).toBe(true);
    });

    it('the bundle is the owner\'s only: list, download and delete by anyone else are 404', async () => {
        const id = (await ask()).body.request.id as string;
        await sendTar(id, TAR);
        await pair(OTHER, 'CAB-OTHER');

        let res = await request(app).get('/api/me/witness/log-requests').set(auth(OTHER));
        expect(res.body.requests).toEqual([]);
        res = await request(app).get(`/api/me/witness/log-requests/${id}/download`).set(auth(OTHER));
        expect(res.status).toBe(404);
        res = await request(app).delete(`/api/me/witness/log-requests/${id}`).set(auth(OTHER));
        expect(res.status).toBe(404);
        expect(fs.existsSync(fileFor(id))).toBe(true);
        // No auth at all.
        expect((await request(app).get(`/api/me/witness/log-requests/${id}/download`)).status).toBe(401);
        // Another user's device cannot be asked.
        expect((await ask(OTHER, CABINET)).status).toBe(404);
        expect((await ask(USER, 'no-such-device')).status).toBe(404);

        // The owner deletes: row and file.
        res = await request(app).delete(`/api/me/witness/log-requests/${id}`).set(auth());
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(fs.existsSync(fileFor(id))).toBe(false);
        expect((await request(app).get('/api/me/witness/log-requests').set(auth())).body.requests).toEqual([]);
    });

    it('a pending request is not downloadable, and a malformed id is a 404', async () => {
        const id = (await ask()).body.request.id as string;
        expect((await request(app).get(`/api/me/witness/log-requests/${id}/download`).set(auth())).status).toBe(404);
        for (const bad of ['..%2F..%2Farcaid.db', id.toUpperCase(), `${id}0`, 'x']) {
            expect((await request(app).get(`/api/me/witness/log-requests/${bad}/download`).set(auth())).status).toBe(404);
            expect((await request(app).delete(`/api/me/witness/log-requests/${bad}`).set(auth())).status).toBe(404);
        }
    });

    it('upload refusals: 401, other device, empty, not a tar, too large', async () => {
        const id = (await ask()).body.request.id as string;

        let res = await sendTar(id, TAR, { token: 'nope' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });

        // Another device of the SAME player cannot answer this device's request.
        const otherToken = await pair(USER, 'CAB-TWO');
        await beat({}, 'CAB-TWO', otherToken);
        res = await request(app).post('/api/witness/logs').query({ device: 'CAB-TWO', token: otherToken, request: id })
            .set('Content-Type', 'application/x-tar').send(TAR);
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NO_REQUEST');

        // Unknown and malformed ids.
        expect((await sendTar('0'.repeat(32), TAR)).status).toBe(404);
        expect((await sendTar('../../etc', TAR)).status).toBe(404);

        res = await sendTar(id, Buffer.alloc(0));
        expect(res.status).toBe(400);
        res = await sendTar(id, Buffer.from('this is plainly not a tar archive'.repeat(40)));
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_A_TAR');
        const corrupt = Buffer.from(TAR);
        corrupt[10] ^= 0xff; // a name byte: the header checksum no longer adds up
        expect((await sendTar(id, corrupt)).status).toBe(400);

        const big = Buffer.alloc(16 * 1024 * 1024 + 1);
        TAR.copy(big);
        res = await sendTar(id, big);
        expect(res.status).toBe(413);

        // None of that touched the request: still pending, nothing on disk, and the real upload works.
        expect(fs.readdirSync(tmpRoot)).toEqual([]);
        expect((await sendTar(id, TAR)).status).toBe(200);
    });

    it('a body sent as application/octet-stream arrives as the same bytes', async () => {
        const id = (await ask()).body.request.id as string;
        const res = await request(app).post('/api/witness/logs')
            .query({ device: CABINET, token, request: id })
            .set('Content-Type', 'application/octet-stream')
            .send(TAR);
        expect(res.status).toBe(200);
        expect(fs.readFileSync(fileFor(id)).equals(TAR)).toBe(true);
    });

    it('pending -> expired after 15 minutes with no answer (lazily, on read)', async () => {
        const id = (await ask()).body.request.id as string;
        const db = await getDatabase();
        await db.run(`UPDATE witness_log_requests SET requested_at = datetime('now', '-16 minutes') WHERE id = ?`, id);

        expect('logs' in (await beat()).body).toBe(false);
        const res = await request(app).get('/api/me/witness/log-requests').set(auth());
        expect(res.body.requests[0]).toMatchObject({ id, status: 'expired', failReason: 'no_answer' });
        expect((await sendTar(id, TAR)).status).toBe(404);

        // A new ask makes a NEW request.
        const again = await ask();
        expect(again.status).toBe(201);
        expect(again.body.request.id).not.toBe(id);
    });

    it('pending -> failed when the cabinet says it cannot build the archive', async () => {
        const id = (await ask()).body.request.id as string;
        const fail = (q: Record<string, string>) => request(app).get('/api/witness/logs/fail')
            .query({ device: CABINET, token, request: id, ...q });

        let res = await fail({ token: 'nope', reason: 'no_space' });
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ ok: false });
        res = await fail({ reason: 'no_space' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
        res = await fail({ reason: 'no_space' });
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NO_REQUEST');

        res = await request(app).get('/api/me/witness/log-requests').set(auth());
        expect(res.body.requests[0]).toMatchObject({ id, status: 'failed', failReason: 'no_space' });
        expect('logs' in (await beat()).body).toBe(false);

        // An odd reason is stored as `unknown`, never echoed.
        const id2 = (await ask()).body.request.id as string;
        await request(app).get('/api/witness/logs/fail').query({ device: CABINET, token, request: id2, reason: 'Bad "Reason"' });
        res = await request(app).get('/api/me/witness/log-requests').set(auth());
        expect(res.body.requests[0]).toMatchObject({ id: id2, status: 'failed', failReason: 'unknown' });
    });

    it('a ready bundle is deleted 7 days after it arrived', async () => {
        const id = (await ask()).body.request.id as string;
        await sendTar(id, TAR);
        const db = await getDatabase();
        await db.run(`UPDATE witness_log_requests SET ready_at = datetime('now', '-8 days') WHERE id = ?`, id);
        expect((await request(app).get('/api/me/witness/log-requests').set(auth())).body.requests).toEqual([]);
        expect(fs.existsSync(fileFor(id))).toBe(false);
    });

    it('unpairing the device deletes its requests and files', async () => {
        const id = (await ask()).body.request.id as string;
        await sendTar(id, TAR);
        const id2 = (await ask()).body.request.id as string;
        expect(fs.existsSync(fileFor(id))).toBe(true);
        expect(await WitnessService.revokeDevice(USER, CABINET)).toBe(true);
        const db = await getDatabase();
        expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_log_requests'))!.n).toBe(0);
        expect(fs.existsSync(fileFor(id))).toBe(false);
        expect(fs.existsSync(fileFor(id2))).toBe(false);
    });

    it('the list is the caller\'s latest 10, newest first', async () => {
        const db = await getDatabase();
        for (let i = 0; i < 12; i++) {
            await db.run(
                `INSERT INTO witness_log_requests (id, atgames_unique_id, canonical_user_id, status, requested_at, fail_reason)
                 VALUES (?, ?, ?, 'failed', datetime('now', ?), 'no_files')`,
                i.toString(16).padStart(32, '0'), CABINET, USER, `-${60 - i} minutes`,
            );
        }
        const res = await request(app).get('/api/me/witness/log-requests').set(auth());
        expect(res.body.requests).toHaveLength(10);
        expect(res.body.requests[0].id).toBe((11).toString(16).padStart(32, '0'));
        expect(res.body.requests[9].id).toBe((2).toString(16).padStart(32, '0'));
    });
});

describe('W99 log pull: which devices can be asked', () => {
    it('a desktop, a pre-1.1.0 cabinet and a cabinet that never reported are 409 LOGS_UNSUPPORTED', async () => {
        await pair(USER, 'DESK-1', 'desktop');
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version = '1.2.0' WHERE atgames_unique_id = 'DESK-1'`);
        let res = await ask(USER, 'DESK-1');
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('LOGS_UNSUPPORTED');

        const oldToken = await pair(USER, 'CAB-OLD');
        await beat({ v: '1.0.9' }, 'CAB-OLD', oldToken);
        expect((await ask(USER, 'CAB-OLD')).body.code).toBe('LOGS_UNSUPPORTED');

        await pair(USER, 'CAB-SILENT');
        expect((await ask(USER, 'CAB-SILENT')).status).toBe(409);

        // 1.0.10 is still below 1.1.0; 1.1.0 is enough.
        await beat({ v: '1.0.10' }, 'CAB-OLD', oldToken);
        expect((await ask(USER, 'CAB-OLD')).status).toBe(409);
        await beat({ v: '1.1.0' }, 'CAB-OLD', oldToken);
        expect((await ask(USER, 'CAB-OLD')).status).toBe(201);

        res = await request(app).get('/api/me/witness/devices').set(auth());
        const byId = Object.fromEntries((res.body as Array<{ atgamesUniqueId: string; logsSupported: boolean }>)
            .map(d => [d.atgamesUniqueId, d.logsSupported]));
        expect(byId).toMatchObject({ 'DESK-1': false, 'CAB-SILENT': false, 'CAB-OLD': true, [CABINET]: true });
    });

    it('an unpaired device cannot be asked', async () => {
        await WitnessService.revokeDevice(USER, CABINET);
        expect((await ask()).status).toBe(404);
    });
});

describe('looksLikeTar', () => {
    it('wants the ustar magic and a valid header checksum', () => {
        expect(looksLikeTar(TAR)).toBe(true);
        expect(looksLikeTar(TAR.subarray(0, 511))).toBe(false);
        const noMagic = Buffer.from(TAR);
        noMagic.write('xxxxx', 257, 'latin1');
        expect(looksLikeTar(noMagic)).toBe(false);
        // GNU tar writes the checksum as 7 digits + NUL; that is fine too.
        const gnu = Buffer.from(TAR);
        const sum = Number.parseInt(gnu.subarray(148, 154).toString('latin1'), 8);
        gnu.write(`${sum.toString(8).padStart(7, '0')}\0`, 148, 'latin1');
        expect(looksLikeTar(gnu)).toBe(true);
    });
});
