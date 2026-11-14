import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../utils/logger.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/logger.js')>();
    return {
        ...actual,
        logInfo: (...args: unknown[]) => { log.info(...args); },
        logWarn: (...args: unknown[]) => { log.warn(...args); },
        logError: (...args: unknown[]) => { log.error(...args); },
    };
});

import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';
import { WitnessService, cabinetAccountLabel } from '../services/WitnessService.js';

/**
 * W102 (v2.247.0, ADR 0040 addendum) - pair by phone (the device flow).
 *
 * Pinned, worst-bug-first:
 *   1. The token is minted at the cabinet's poll AFTER a player approved, and
 *      only once: a second poll is 410, and the secret / code / token never
 *      reach a log line.
 *   2. One 410 for unknown / expired / used / wrong device / wrong secret.
 *   3. The pairing rules are the typed flow's own (DEVICE_CONFLICT /
 *      DEVICE_LIMIT, same messages) at approve AND again at the poll.
 *   4. `account` is reduced to the cabinet's safe characters, or omitted;
 *      never a raw id.
 *   5. The typed-code flow is unchanged.
 *
 * The two player routes sit behind `writeLimiter` (30/min, a module counter
 * for this whole file), so most cases drive the service directly.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'CAB00000000ABCD';
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const auth = (user = USER) => ({ Authorization: `Bearer ${playerToken(user)}` });

let app: express.Express;

async function createApp() {
    await setupTestDb();
    const a = express();
    a.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    a.use('/api', globalRouter);
    return a;
}

const start = (q: Record<string, string> = {}) =>
    request(app).get('/api/witness/pair/start').query({ device: CABINET, ...q });
const poll = (secret: string, device = CABINET) =>
    request(app).get('/api/witness/pair/poll').query({ device, poll: secret });

async function startOk(q: Record<string, string> = {}): Promise<{ code: string; poll: string }> {
    const res = await start(q);
    expect(res.status).toBe(200);
    return { code: res.body.code, poll: res.body.poll };
}

async function typedPair(user: string, deviceId: string, type: 'atgames' | 'desktop' = 'atgames'): Promise<string> {
    const { code } = await WitnessService.createPairingCode(user);
    return (await WitnessService.redeemPairingCode(code, deviceId, null, type)).token;
}

async function profile(user: string, displayName: string | null) {
    const db = await getDatabase();
    await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`, user, displayName);
}

async function seedDevices(user: string, n: number) {
    const db = await getDatabase();
    for (let i = 0; i < n; i++) {
        await db.run(
            `INSERT INTO witness_devices (atgames_unique_id, canonical_user_id, token_hash, paired_at, device_type)
             VALUES (?, ?, 'x', datetime('now', '-30 days'), 'atgames')`,
            `seed-${user}-${i}`, user,
        );
    }
}

/** Every argument ever passed to the logger, as text. */
function loggedText(): string {
    return [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]
        .flat().map(a => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a))).join('\n');
}

beforeEach(async () => {
    app = await createApp();
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
});

describe('pair by phone (W102)', () => {
    it('start -> pending -> approve -> approved: the poll pairs the cabinet once, with the typed flow\'s log line and activity row', async () => {
        await profile(USER, 'Krobs');
        const res = await start({ username: 'krobs_ag', model: 'HA9920', model_name: 'Legends Ultimate' });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['code', 'ok', 'poll']);
        expect(res.body.ok).toBe(true);
        expect(res.body.code).toMatch(CODE_RE);
        expect(res.body.poll).toMatch(/^[0-9a-f]{32}$/);
        expect(res.headers['cache-control']).toBe('no-store');
        const { code, poll: secret } = res.body as { code: string; poll: string };

        // Only the secret's SHA-256 is stored.
        const db = await getDatabase();
        const row = await db.get<Record<string, unknown>>(`SELECT * FROM witness_pair_requests WHERE user_code = ?`, code);
        expect(row!.poll_hash).toBe(createHash('sha256').update(secret).digest('hex'));
        expect(JSON.stringify(row)).not.toContain(secret);

        expect((await poll(secret)).body).toEqual({ ok: true, status: 'pending' });

        // The confirm page: lower case is fine (upper-cased, trimmed).
        let view = await request(app).get(`/api/me/witness/pair-requests/${code.toLowerCase()}`).set(auth());
        expect(view.status).toBe(200);
        expect(view.body).toMatchObject({
            code, deviceType: 'atgames', deviceModel: 'HA9920', deviceModelName: 'Legends Ultimate',
            deviceTail: 'ABCD', atgamesUsername: 'krobs_ag', status: 'pending', alreadyYours: false,
        });
        const left = Date.parse(view.body.expiresAt) - Date.now();
        expect(view.body.expiresAt).toMatch(/Z$/);
        expect(left).toBeGreaterThan(590_000);
        expect(left).toBeLessThanOrEqual(600_000);

        expect((await request(app).post(`/api/me/witness/pair-requests/${code}/approve`).set(auth())).body).toEqual({ ok: true });
        // Idempotent for the same caller.
        const again = await request(app).post(`/api/me/witness/pair-requests/${code}/approve`).set(auth());
        expect(again.status).toBe(200);
        view = await request(app).get(`/api/me/witness/pair-requests/${code}`).set(auth());
        expect(view.body.status).toBe('approved');
        // Approval alone pairs nothing.
        expect(await db.get('SELECT 1 FROM witness_devices WHERE atgames_unique_id = ?', CABINET)).toBeUndefined();

        const approved = await poll(secret);
        expect(approved.status).toBe(200);
        expect(Object.keys(approved.body).sort()).toEqual(['account', 'ok', 'status', 'token']);
        expect(approved.body).toMatchObject({ ok: true, status: 'approved', account: 'Krobs' });
        const token = approved.body.token as string;
        expect(typeof token).toBe('string');

        // The token authenticates the device, as the typed flow's does.
        expect(await WitnessService.verifyDevice(CABINET, token)).toEqual({
            deviceId: CABINET, canonicalUserId: USER, deviceType: 'atgames',
        });
        const beat = await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token, v: '1.1.1' });
        expect(beat.status).toBe(200);
        const device = await db.get<Record<string, unknown>>(`SELECT * FROM witness_devices WHERE atgames_unique_id = ?`, CABINET);
        expect(device).toMatchObject({
            canonical_user_id: USER, atgames_username: 'krobs_ag', device_type: 'atgames',
            device_model: 'HA9920', device_model_name: 'Legends Ultimate',
        });
        expect(device!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));

        // Returned once.
        expect((await poll(secret)).status).toBe(410);
        expect((await poll(secret)).body).toEqual({ ok: false, status: 'expired' });
        expect((await request(app).get(`/api/me/witness/pair-requests/${code}`).set(auth())).status).toBe(404);

        // The typed flow's log line and activity row.
        await drainBackgroundTasks();
        expect(log.info.mock.calls.map(c => c[0])).toContain(`Witness: atgames device ${CABINET} paired to ${USER}`);
        const activity = await db.all<Array<{ event_type: string; summary: string; canonical_user_id: string }>>(
            `SELECT event_type, summary, canonical_user_id FROM activity_log WHERE device_id = ? AND event_type = 'device_paired'`, CABINET,
        );
        expect(activity).toEqual([{ event_type: 'device_paired', summary: 'Witness cabinet paired', canonical_user_id: USER }]);

        // Never the code, the poll secret or the token in a log line.
        const text = loggedText();
        expect(text).not.toContain(secret);
        expect(text).not.toContain(token);
        expect(text).not.toContain(code);
    });

    it('wrong secret, wrong device, malformed and missing params are all the same 410', async () => {
        const { code, poll: secret } = await startOk();
        expect(await WitnessService.approvePairRequest(USER, code)).toBe(true);
        for (const res of [
            await poll(randomBytes(16).toString('hex')),
            await poll(secret, 'SOME-OTHER-DEVICE'),
            await poll('not-hex'),
            await poll(secret.toUpperCase().slice(0, 31)),
            await request(app).get('/api/witness/pair/poll'),
            await request(app).get('/api/witness/pair/poll').query({ device: CABINET }),
        ]) {
            expect(res.status).toBe(410);
            expect(res.body).toEqual({ ok: false, status: 'expired' });
        }
        // None of those consumed it.
        const ok = await poll(secret);
        expect(ok.body.status).toBe('approved');
    });

    it('expiry: an expired request is 410 to the cabinet and not found for the player', async () => {
        const db = await getDatabase();
        const a = await startOk();
        await db.run(`UPDATE witness_pair_requests SET expires_at = datetime('now', '-1 second') WHERE user_code = ?`, a.code);
        expect((await poll(a.poll)).status).toBe(410);
        expect(await WitnessService.getPairRequest(USER, a.code)).toBeNull();
        expect(await WitnessService.approvePairRequest(USER, a.code)).toBe(false);

        // Approved, then expired before the poll: still 410, nothing paired.
        const b = await startOk({ device: 'CAB-B' });
        expect(await WitnessService.approvePairRequest(USER, b.code)).toBe(true);
        await db.run(`UPDATE witness_pair_requests SET expires_at = datetime('now', '-1 second') WHERE user_code = ?`, b.code);
        expect((await poll(b.poll, 'CAB-B')).status).toBe(410);
        expect(await db.get('SELECT 1 FROM witness_devices WHERE atgames_unique_id = ?', 'CAB-B')).toBeUndefined();
    });

    it('a request approved by one player is not found for another', async () => {
        const { code, poll: secret } = await startOk();
        expect(await WitnessService.approvePairRequest(USER, code)).toBe(true);
        expect(await WitnessService.getPairRequest(OTHER, code)).toBeNull();
        expect((await request(app).get(`/api/me/witness/pair-requests/${code}`).set(auth(OTHER))).body)
            .toEqual({ error: 'PAIR_REQUEST_NOT_FOUND' });
        const res = await request(app).post(`/api/me/witness/pair-requests/${code}/approve`).set(auth(OTHER));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'PAIR_REQUEST_NOT_FOUND' });
        // It still pairs to the first approver.
        const approved = await poll(secret);
        expect((await WitnessService.verifyDevice(CABINET, approved.body.token))!.canonicalUserId).toBe(USER);
    });

    it('approve refuses DEVICE_CONFLICT and DEVICE_LIMIT with the typed flow\'s messages; the request stays pending', async () => {
        await typedPair(OTHER, CABINET);
        const a = await startOk();
        let res = await request(app).post(`/api/me/witness/pair-requests/${a.code}/approve`).set(auth());
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ code: 'DEVICE_CONFLICT', error: 'This device is already linked to a different Arcaid account' });
        expect((await poll(a.poll)).body.status).toBe('pending');

        await seedDevices(USER, 10);
        const b = await startOk({ device: 'NEW-CAB' });
        res = await request(app).post(`/api/me/witness/pair-requests/${b.code}/approve`).set(auth());
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('DEVICE_LIMIT');
        // The exact message the typed flow gives in the same state.
        const { code: typed } = await WitnessService.createPairingCode(USER);
        const typedError = await WitnessService.redeemPairingCode(typed, 'NEW-CAB', null).catch((e: Error) => e);
        expect(typedError).toMatchObject({ code: 'DEVICE_LIMIT', message: res.body.error });
        expect((await poll(b.poll, 'NEW-CAB')).body.status).toBe('pending');
    });

    it('the rules run again at the poll: a refusal answers `refused` and consumes the request', async () => {
        const a = await startOk();
        expect(await WitnessService.approvePairRequest(USER, a.code)).toBe(true);
        await typedPair(OTHER, CABINET); // someone else took the cabinet meanwhile
        let res = await poll(a.poll);
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, status: 'refused', code: 'DEVICE_CONFLICT' });
        expect((await poll(a.poll)).status).toBe(410);
        expect((await WitnessService.verifyDevice(CABINET, 'x'))).toBeNull();

        const b = await startOk({ device: 'NEW-CAB' });
        expect(await WitnessService.approvePairRequest(USER, b.code)).toBe(true);
        await seedDevices(USER, 10);
        res = await poll(b.poll, 'NEW-CAB');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ ok: false, status: 'refused', code: 'DEVICE_LIMIT' });
        expect((await poll(b.poll, 'NEW-CAB')).status).toBe(410);
        const db = await getDatabase();
        expect(await db.get('SELECT 1 FROM witness_devices WHERE atgames_unique_id = ?', 'NEW-CAB')).toBeUndefined();
    });

    it('a new start expires the same device\'s earlier request, and only that device\'s', async () => {
        const other = await startOk({ device: 'CAB-2' });
        const first = await startOk();
        const second = await startOk();
        expect(second.code).not.toBe(first.code);
        expect((await poll(first.poll)).status).toBe(410);
        expect(await WitnessService.getPairRequest(USER, first.code)).toBeNull();
        expect(await WitnessService.approvePairRequest(USER, first.code)).toBe(false);
        expect((await poll(second.poll)).body.status).toBe('pending');
        expect((await poll(other.poll, 'CAB-2')).body.status).toBe('pending');
    });

    it('re-pairing your own cabinet by phone rotates its token (alreadyYours)', async () => {
        const oldToken = await typedPair(USER, CABINET);
        const { code, poll: secret } = await startOk();
        expect((await WitnessService.getPairRequest(USER, code))!.alreadyYours).toBe(true);
        expect((await WitnessService.getPairRequest(OTHER, code))!.alreadyYours).toBe(false);
        expect(await WitnessService.approvePairRequest(USER, code)).toBe(true);
        const res = await poll(secret);
        expect(res.body.status).toBe('approved');
        expect(await WitnessService.verifyDevice(CABINET, oldToken)).toBeNull();
        expect(await WitnessService.verifyDevice(CABINET, res.body.token)).toBeTruthy();
    });

    it('start refuses an empty device and an unknown type; a desktop keeps its type', async () => {
        for (const [q, code] of [
            [{ device: '' }, 'CODE_INVALID'],
            [{ device: '   ' }, 'CODE_INVALID'],
            [{ type: 'phone' }, 'DEVICE_TYPE_INVALID'],
        ] as Array<[Record<string, string>, string]>) {
            const res = await start(q);
            expect(res.status).toBe(400);
            expect(res.body).toEqual({ ok: false, code });
        }
        const db = await getDatabase();
        expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_pair_requests'))!.n).toBe(0);

        const { code, poll: secret } = await startOk({ device: 'desk-uuid-1', type: 'desktop' });
        expect((await WitnessService.getPairRequest(USER, code))!.deviceType).toBe('desktop');
        await WitnessService.approvePairRequest(USER, code);
        const res = await poll(secret, 'desk-uuid-1');
        expect((await WitnessService.verifyDevice('desk-uuid-1', res.body.token))!.deviceType).toBe('desktop');
        await drainBackgroundTasks();
        const activity = await db.get<{ summary: string }>(
            `SELECT summary FROM activity_log WHERE device_id = 'desk-uuid-1' AND event_type = 'device_paired'`,
        );
        expect(activity!.summary).toBe('Castcade PC paired');
    });

    it('`account` is omitted when the label leaves nothing, and is never a raw id', async () => {
        // No profile and no alias: no label at all.
        const a = await startOk();
        await WitnessService.approvePairRequest(USER, a.code);
        let res = await poll(a.poll);
        expect(res.body.status).toBe('approved');
        expect('account' in res.body).toBe(false);
        expect(JSON.stringify(res.body)).not.toContain(USER);

        // A label of emoji only.
        await profile(OTHER, '\u{1F3AE}\u{1F3AE}');
        const b = await startOk({ device: 'CAB-B' });
        await WitnessService.approvePairRequest(OTHER, b.code);
        res = await poll(b.poll, 'CAB-B');
        expect(Object.keys(res.body).sort()).toEqual(['ok', 'status', 'token']);
    });

    it('prunes requests older than a day when a pairing starts', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO witness_pair_requests (user_code, poll_hash, device_id, created_at, expires_at)
             VALUES ('OLD234', 'x', 'CAB-OLD', datetime('now', '-2 days'), datetime('now', '-2 days'))`,
        );
        await startOk();
        expect(await db.get(`SELECT 1 FROM witness_pair_requests WHERE user_code = 'OLD234'`)).toBeUndefined();
        expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_pair_requests'))!.n).toBe(1);
    });
});

describe('cabinetAccountLabel', () => {
    it('keeps [A-Za-z0-9 _.-], collapses spaces, caps at 24, and gives null for nothing', () => {
        expect(cabinetAccountLabel('Krobs')).toBe('Krobs');
        expect(cabinetAccountLabel('Krobs "The Bat" \\ \u{1F3AE}')).toBe('Krobs The Bat');
        expect(cabinetAccountLabel('a\u0000b\nc\td')).toBe('abcd');
        expect(cabinetAccountLabel('pin_wizard-99.v2')).toBe('pin_wizard-99.v2');
        expect(cabinetAccountLabel('An extremely long display name here')).toBe('An extremely long displa');
        expect(cabinetAccountLabel('Twenty three characters x')).toBe('Twenty three characters');
        expect(cabinetAccountLabel('\u{1F3AE}\u{1F3AE}')).toBeNull();
        expect(cabinetAccountLabel('   ')).toBeNull();
        expect(cabinetAccountLabel('')).toBeNull();
        expect(cabinetAccountLabel(null)).toBeNull();
        expect(cabinetAccountLabel(undefined)).toBeNull();
    });
});

describe('typed-code pairing is unchanged', () => {
    it('redeems once, refuses reuse, and writes the same log line and activity row', async () => {
        const codeRes = await request(app).post('/api/me/witness/pairing-code').set(auth()).send({});
        expect(codeRes.status).toBe(200);
        const res = await request(app).get('/api/witness/pair').query({ code: codeRes.body.code, device: CABINET, model: 'HA9920' });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['ok', 'token']);
        expect(await WitnessService.verifyDevice(CABINET, res.body.token)).toBeTruthy();

        const reuse = await request(app).get('/api/witness/pair').query({ code: codeRes.body.code, device: CABINET });
        expect(reuse.status).toBe(400);
        expect(reuse.body).toEqual({ ok: false, error: 'That pairing code has already been used', code: 'CODE_USED' });
        const bad = await request(app).get('/api/witness/pair').query({ code: 'ZZZZZZ', device: CABINET });
        expect(bad.body).toEqual({ ok: false, error: 'That pairing code is not valid', code: 'CODE_INVALID' });

        const db = await getDatabase();
        expect((await db.get<{ consumed_device_id: string }>(
            'SELECT consumed_device_id FROM witness_pairing_codes WHERE code = ?', codeRes.body.code,
        ))!.consumed_device_id).toBe(CABINET);
        expect((await db.get<{ device_model: string }>(
            'SELECT device_model FROM witness_devices WHERE atgames_unique_id = ?', CABINET,
        ))!.device_model).toBe('HA9920');
        await drainBackgroundTasks();
        expect(log.info.mock.calls.map(c => c[0])).toContain(`Witness: atgames device ${CABINET} paired to ${USER}`);
        expect((await db.get<{ summary: string }>(
            `SELECT summary FROM activity_log WHERE device_id = ? AND event_type = 'device_paired'`, CABINET,
        ))!.summary).toBe('Witness cabinet paired');
    });
});
