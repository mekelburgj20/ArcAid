import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { offeredRelease, WitnessReleaseService } from '../services/WitnessReleaseService.js';
import { releaseSignedMessage } from '../utils/witnessReleaseSignature.js';

/**
 * W100 (v2.245.0, ADR 0040) - signed self-update for Witness cabinets.
 *
 * Pinned, worst-bug-first:
 *   1. THE OFFER RULE: draft is offered to nobody; beta only with test builds;
 *      never a desktop, never with auto-update off, never without a reported
 *      version; numeric compare (1.0.10 > 1.0.9); the highest wins.
 *   2. The heartbeat carries `update` only when a build is offered, and the
 *      two download routes serve exactly the offered build (bare 401 / 404).
 *   3. Upload refuses each bad build with its code, and verifies the signature.
 *
 * The real private key never leaves the owner's PC, so a successful upload is
 * signed with a throwaway key installed through `setPublicKeyForTests`.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'CAB0000000000001';
const DESKTOP = 'desk-uuid-0001';

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const superToken = () =>
    signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

// A throwaway signing key for the tests (never the release key).
const testKey = crypto.generateKeyPairSync('ed25519');
const testPublicHex = Buffer.from(
    (testKey.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url',
).toString('hex');
const sign = (version: string, elf: Buffer) =>
    crypto.sign(null, releaseSignedMessage(version, elf), testKey.privateKey).toString('base64');
const fakeElf = (n = 4096) => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]), crypto.randomBytes(n)]);

let tmpRoot: string;

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    app.use('/api', globalRouter);
    return app;
}

async function pair(app: express.Express, user: string, deviceId: string, type?: 'desktop') {
    const codeRes = await request(app).post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(user)}`).send({});
    const pairRes = await request(app).get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: deviceId, ...(type ? { type } : {}) });
    expect(pairRes.status).toBe(200);
    return pairRes.body.token as string;
}

async function seedRelease(version: string, channel: 'draft' | 'beta' | 'stable') {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_app_releases (version, channel, size, sha256, sig) VALUES (?, ?, 1, 'x', 'x')`,
        version, channel,
    );
}

const upload = (app: express.Express, fields: { version?: string; sig?: string; notes?: string }, file?: Buffer) => {
    let r = request(app).post('/api/admin/witness/releases').set('Authorization', `Bearer ${superToken()}`);
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) r = r.field(k, v);
    if (file) r = r.attach('file', file, 'arcaid-witness.elf');
    return r;
};

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-releases-'));
    WitnessReleaseService.setRootForTests(tmpRoot);
});
afterEach(() => {
    WitnessReleaseService.setRootForTests(null);
    WitnessReleaseService.setPublicKeyForTests(null);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('THE OFFER RULE (pure)', () => {
    const cab = { deviceType: 'atgames', autoUpdate: true, testBuilds: false, reportedVersion: '1.1.0' };
    const rel = (version: string, channel: string) => ({ version, channel });

    it('offers the highest stable release newer than the reported version', () => {
        expect(offeredRelease(cab, [rel('1.1.1', 'stable'), rel('1.1.2', 'stable'), rel('1.0.9', 'stable')])).toBe('1.1.2');
        expect(offeredRelease(cab, [rel('1.1.0', 'stable')])).toBeNull();
        expect(offeredRelease(cab, [rel('1.0.9', 'stable')])).toBeNull();
        expect(offeredRelease(cab, [])).toBeNull();
    });

    it('draft is offered to nobody', () => {
        expect(offeredRelease(cab, [rel('9.0.0', 'draft')])).toBeNull();
        expect(offeredRelease({ ...cab, testBuilds: true }, [rel('9.0.0', 'draft'), rel('1.1.1', 'beta')])).toBe('1.1.1');
    });

    it('beta only with test builds', () => {
        const releases = [rel('1.1.1', 'stable'), rel('1.2.0', 'beta')];
        expect(offeredRelease(cab, releases)).toBe('1.1.1');
        expect(offeredRelease({ ...cab, testBuilds: true }, releases)).toBe('1.2.0');
        expect(offeredRelease({ ...cab, testBuilds: true }, [rel('1.1.1', 'beta'), rel('1.2.0', 'stable')])).toBe('1.2.0');
    });

    it('auto-update off, a desktop, or no reported version is offered nothing', () => {
        const releases = [rel('1.1.1', 'stable')];
        expect(offeredRelease({ ...cab, autoUpdate: false }, releases)).toBeNull();
        expect(offeredRelease({ ...cab, deviceType: 'desktop' }, releases)).toBeNull();
        expect(offeredRelease({ ...cab, deviceType: null }, releases)).toBeNull();
        expect(offeredRelease({ ...cab, reportedVersion: null }, releases)).toBeNull();
        expect(offeredRelease({ ...cab, reportedVersion: '' }, releases)).toBeNull();
    });

    it('compares numerically: 1.0.10 is newer than 1.0.9', () => {
        expect(offeredRelease({ ...cab, reportedVersion: '1.0.9' }, [rel('1.0.10', 'stable')])).toBe('1.0.10');
        expect(offeredRelease({ ...cab, reportedVersion: '1.0.10' }, [rel('1.0.9', 'stable')])).toBeNull();
        expect(offeredRelease({ ...cab, reportedVersion: '1.0.9' }, [rel('1.0.10', 'stable'), rel('1.0.9', 'stable'), rel('1.0.2', 'stable')])).toBe('1.0.10');
        // A suffix on the reported build is ignored: 1.1.0-rc2 runs "1.1.0".
        expect(offeredRelease({ ...cab, reportedVersion: '1.1.0-rc2' }, [rel('1.1.0', 'stable')])).toBeNull();
        expect(offeredRelease({ ...cab, reportedVersion: '1.1.0-rc2' }, [rel('1.1.1', 'stable')])).toBe('1.1.1');
    });

    it('ignores a malformed release version', () => {
        expect(offeredRelease(cab, [rel('../9.9.9', 'stable'), rel('9.9', 'stable')])).toBeNull();
    });
});

describe('heartbeat `update` and `staged` (W100)', () => {
    let app: express.Express;
    let token: string;
    beforeEach(async () => {
        app = await createApp();
        token = await pair(app, USER, CABINET);
    });
    const beat = (q: Record<string, string> = {}) =>
        request(app).get('/api/witness/heartbeat').query({ device: CABINET, token, ...q });

    it('omits `update` (and `logs`) when nothing applies', async () => {
        const res = await beat({ v: '1.1.0' });
        expect(res.status).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['ok', 'sendingTo']);
    });

    it('carries the offered build, only while it is newer than `v`', async () => {
        await seedRelease('1.1.1', 'stable');
        await seedRelease('1.2.0', 'draft');
        expect((await beat({ v: '1.1.0' })).body.update).toBe('1.1.1');
        expect((await beat({ v: '1.0.9' })).body.update).toBe('1.1.1');
        expect('update' in (await beat({ v: '1.1.1' })).body).toBe(false);
        // No `v`, nothing offered (never "anything goes").
        expect('update' in (await beat()).body).toBe(false);
        // A bad token is still the bare 401.
        const bad = await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token: 'nope', v: '1.1.0' });
        expect(bad.status).toBe(401);
        expect(bad.body).toEqual({ ok: false });
    });

    it('auto-update off and test builds follow the player switches', async () => {
        await seedRelease('1.1.1', 'stable');
        await seedRelease('1.2.0', 'beta');
        const auth = { Authorization: `Bearer ${playerToken(USER)}` };
        let res = await request(app).patch(`/api/me/witness/devices/${CABINET}/updates`).set(auth).send({ testBuilds: true });
        expect(res.status).toBe(200);
        expect(res.body.device).toMatchObject({ autoUpdate: true, testBuilds: true });
        expect((await beat({ v: '1.1.0' })).body.update).toBe('1.2.0');

        res = await request(app).patch(`/api/me/witness/devices/${CABINET}/updates`).set(auth).send({ autoUpdate: false });
        expect(res.body.device).toMatchObject({ autoUpdate: false, testBuilds: true, offeredVersion: null });
        expect('update' in (await beat({ v: '1.1.0' })).body).toBe(false);

        // Omitted fields are left as they are; a non-boolean is refused.
        res = await request(app).patch(`/api/me/witness/devices/${CABINET}/updates`).set(auth).send({});
        expect(res.body.device).toMatchObject({ autoUpdate: false, testBuilds: true });
        res = await request(app).patch(`/api/me/witness/devices/${CABINET}/updates`).set(auth).send({ autoUpdate: 'yes' });
        expect(res.status).toBe(400);
        // Not the caller's device.
        res = await request(app).patch(`/api/me/witness/devices/${CABINET}/updates`)
            .set('Authorization', `Bearer ${playerToken(OTHER)}`).send({ autoUpdate: true });
        expect(res.status).toBe(404);
    });

    it('a desktop is never offered a build', async () => {
        await seedRelease('9.0.0', 'stable');
        const deskToken = await pair(app, USER, DESKTOP, 'desktop');
        const res = await request(app).get('/api/witness/heartbeat').query({ device: DESKTOP, token: deskToken, v: '0.2.13' });
        expect(res.status).toBe(200);
        expect('update' in res.body).toBe(false);
    });

    it('stores `staged` while it is newer than `v`, and clears it after', async () => {
        const auth = { Authorization: `Bearer ${playerToken(USER)}` };
        const device = async () => (await request(app).get('/api/me/witness/devices').set(auth)).body
            .find((d: { atgamesUniqueId: string }) => d.atgamesUniqueId === CABINET);

        await beat({ v: '1.1.0', staged: '1.1.1' });
        expect((await device()).stagedVersion).toBe('1.1.1');
        // Garbage and a not-newer value are not stored.
        await beat({ v: '1.1.0', staged: '1.1.1"x' });
        expect((await device()).stagedVersion).toBeNull();
        await beat({ v: '1.1.0', staged: '1.1.1' });
        await beat({ v: '1.1.1', staged: '1.1.1' });
        expect((await device()).stagedVersion).toBeNull();
        // The new build is running and stops sending it.
        await beat({ v: '1.1.0', staged: '1.1.1' });
        await beat({ v: '1.1.1' });
        expect((await device()).stagedVersion).toBeNull();
    });

    it('the devices list carries the new fields', async () => {
        await seedRelease('1.1.1', 'stable');
        await beat({ v: '1.1.0' });
        await pair(app, USER, DESKTOP, 'desktop');
        const res = await request(app).get('/api/me/witness/devices').set('Authorization', `Bearer ${playerToken(USER)}`);
        const cab = res.body.find((d: { atgamesUniqueId: string }) => d.atgamesUniqueId === CABINET);
        const desk = res.body.find((d: { atgamesUniqueId: string }) => d.atgamesUniqueId === DESKTOP);
        expect(cab).toMatchObject({
            deviceType: 'atgames', autoUpdate: true, testBuilds: false, stagedVersion: null,
            offeredVersion: '1.1.1', logsSupported: true, appVersion: '1.1.0',
        });
        expect(desk).toMatchObject({
            deviceType: 'desktop', autoUpdate: true, testBuilds: false, stagedVersion: null,
            offeredVersion: null, logsSupported: false,
        });
    });
});

describe('release upload, channels and device downloads (W100)', () => {
    let app: express.Express;
    beforeEach(async () => {
        app = await createApp();
    });

    it('refuses each bad build with its code', async () => {
        WitnessReleaseService.setPublicKeyForTests(testPublicHex);
        const elf = fakeElf();
        // VERSION_INVALID - including a path-shaped one.
        for (const version of ['1.1', '../1.1.1', '1.1.1-rc1', '01.1.1', '']) {
            const res = await upload(app, { version, sig: sign(version, elf) }, elf);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VERSION_INVALID');
        }
        // NOT_ELF (and a missing file).
        const notElf = Buffer.from('MZ this is not an elf');
        let res = await upload(app, { version: '1.1.1', sig: sign('1.1.1', notElf) }, notElf);
        expect(res.body.code).toBe('NOT_ELF');
        res = await upload(app, { version: '1.1.1', sig: sign('1.1.1', elf) });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_ELF');
        // SIGNATURE_INVALID: signed for another version, garbage, absent.
        for (const sig of [sign('1.1.2', elf), 'garbage', undefined]) {
            res = await upload(app, { version: '1.1.1', sig }, elf);
            expect(res.status).toBe(400);
            expect(res.body.code).toBe('SIGNATURE_INVALID');
        }
        // TOO_LARGE: one byte over 16 MiB.
        const big = Buffer.alloc(16 * 1024 * 1024 + 1);
        big.set([0x7f, 0x45, 0x4c, 0x46]);
        res = await upload(app, { version: '1.1.1', sig: 'x' }, big);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOO_LARGE');
        // Nothing was stored by any refusal.
        const db = await getDatabase();
        expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM witness_app_releases'))!.n).toBe(0);
        expect(fs.readdirSync(tmpRoot)).toEqual([]);

        // A good one is a draft; the same version again is VERSION_EXISTS.
        res = await upload(app, { version: '1.1.1', sig: sign('1.1.1', elf), notes: 'First signed build' }, elf);
        expect(res.status).toBe(201);
        expect(res.body.release).toMatchObject({
            version: '1.1.1', channel: 'draft', size: elf.length, notes: 'First signed build',
            sha256: crypto.createHash('sha256').update(elf).digest('hex'),
        });
        expect(res.body.release.uploadedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
        expect(fs.readFileSync(path.join(tmpRoot, '1.1.1', 'arcaid-witness.elf')).equals(elf)).toBe(true);
        res = await upload(app, { version: '1.1.1', sig: sign('1.1.1', elf) }, elf);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('VERSION_EXISTS');
        expect(fs.readFileSync(path.join(tmpRoot, '1.1.1', 'arcaid-witness.elf')).equals(elf)).toBe(true);
    });

    it('verifies against the BAKED key by default: a build signed by any other key is refused', async () => {
        const elf = fakeElf();
        const res = await upload(app, { version: '1.1.1', sig: sign('1.1.1', elf) }, elf);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SIGNATURE_INVALID');
    });

    it('the release routes are super-admin only', async () => {
        const res = await request(app).get('/api/admin/witness/releases').set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(res.status).toBe(403);
    });

    it('draft -> stable -> offered: release, download, channel audit, delete', async () => {
        WitnessReleaseService.setPublicKeyForTests(testPublicHex);
        const elf = fakeElf(20000);
        const sig = sign('1.1.1', elf);
        expect((await upload(app, { version: '1.1.1', sig }, elf)).status).toBe(201);

        const token = await pair(app, USER, CABINET);
        await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token, v: '1.1.0' });
        const dev = (q: Record<string, string>) => ({ device: CABINET, token, ...q });

        // A draft is offered to nobody.
        let res = await request(app).get('/api/witness/app/release').query(dev({ v: '1.1.1' }));
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ ok: false });
        expect((await request(app).get('/api/witness/app/download').query(dev({ v: '1.1.1' }))).status).toBe(404);

        const admin = { Authorization: `Bearer ${superToken()}` };
        res = await request(app).patch('/api/admin/witness/releases/1.1.1').set(admin).send({ channel: 'nope' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CHANNEL_INVALID');
        res = await request(app).patch('/api/admin/witness/releases/9.9.9').set(admin).send({ channel: 'stable' });
        expect(res.status).toBe(404);
        res = await request(app).patch('/api/admin/witness/releases/1.1.1').set(admin).send({ channel: 'stable' });
        expect(res.status).toBe(200);
        expect(res.body.release.channel).toBe('stable');

        // The heartbeat offers it; the release route answers flat strings.
        expect((await request(app).get('/api/witness/heartbeat').query(dev({ v: '1.1.0' }))).body.update).toBe('1.1.1');
        res = await request(app).get('/api/witness/app/release').query(dev({ v: '1.1.1' }));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, version: '1.1.1', size: String(elf.length), sig });
        // Any other version, or a path-shaped one, is a 404.
        for (const v of ['1.1.0', '1.1.2', '../1.1.1', '']) {
            expect((await request(app).get('/api/witness/app/release').query(dev({ v }))).status).toBe(404);
        }
        // Bad token: the bare 401 on both routes.
        for (const route of ['release', 'download']) {
            res = await request(app).get(`/api/witness/app/${route}`).query({ device: CABINET, token: 'nope', v: '1.1.1' });
            expect(res.status).toBe(401);
            expect(res.body).toEqual({ ok: false });
        }
        // The bytes, with Content-Length.
        res = await request(app).get('/api/witness/app/download').query(dev({ v: '1.1.1' })).buffer(true).parse(binary);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/octet-stream');
        expect(res.headers['content-length']).toBe(String(elf.length));
        expect((res.body as Buffer).equals(elf)).toBe(true);

        // Admin list: releases + devices by version.
        res = await request(app).get('/api/admin/witness/releases').set(admin);
        expect(res.status).toBe(200);
        expect(res.body.releases).toEqual([expect.objectContaining({ version: '1.1.1', channel: 'stable' })]);
        expect(res.body.devicesByVersion).toEqual([{ version: '1.1.0', count: 1 }]);

        // Once the device runs it, nothing is offered.
        await request(app).get('/api/witness/heartbeat').query(dev({ v: '1.1.1' }));
        expect((await request(app).get('/api/witness/app/release').query(dev({ v: '1.1.1' }))).status).toBe(404);

        // Audit rows: upload + channel change.
        const db = await getDatabase();
        const audits = await db.all<Array<{ action: string; target_id: string; details: string }>>(
            `SELECT action, target_id, details FROM audit_log WHERE target_type = 'witness_release' ORDER BY id`,
        );
        expect(audits.map(a => a.action)).toEqual(['witness_release.upload', 'witness_release.channel']);
        expect(JSON.parse(audits[1]!.details)).toEqual({ from: 'draft', to: 'stable' });

        // Delete: row + file + audit.
        res = await request(app).delete('/api/admin/witness/releases/1.1.1').set(admin);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        expect(fs.existsSync(path.join(tmpRoot, '1.1.1'))).toBe(false);
        expect(await db.get('SELECT 1 FROM witness_app_releases WHERE version = ?', '1.1.1')).toBeUndefined();
        expect((await request(app).delete('/api/admin/witness/releases/1.1.1').set(admin)).status).toBe(404);
        expect((await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM audit_log WHERE action = 'witness_release.delete' AND target_id = '1.1.1'`,
        ))!.n).toBe(1);
    });

    it('devicesByVersion: unrevoked cabinets only, never-reported as ""', async () => {
        await pair(app, USER, 'CAB-A');
        const tokenB = await pair(app, USER, 'CAB-B');
        await pair(app, OTHER, 'CAB-C');
        await pair(app, USER, DESKTOP, 'desktop');
        await request(app).get('/api/witness/heartbeat').query({ device: 'CAB-B', token: tokenB, v: '1.0.10' });
        const db = await getDatabase();
        await db.run(`UPDATE witness_devices SET app_version = '1.0.9' WHERE atgames_unique_id = 'CAB-C'`);
        await db.run(`UPDATE witness_devices SET app_version = '1.0.9', revoked_at = datetime('now') WHERE atgames_unique_id = 'CAB-A'`);
        expect(await WitnessReleaseService.devicesByVersion()).toEqual([
            { version: '1.0.10', count: 1 },
            { version: '1.0.9', count: 1 },
        ]);
        await db.run(`UPDATE witness_devices SET revoked_at = NULL, app_version = NULL WHERE atgames_unique_id = 'CAB-A'`);
        expect(await WitnessReleaseService.devicesByVersion()).toEqual([
            { version: '1.0.10', count: 1 },
            { version: '1.0.9', count: 1 },
            { version: '', count: 1 },
        ]);
    });
});
