import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { WitnessReleaseService } from '../services/WitnessReleaseService.js';
import { WitnessKitService, crc32, KIT_STATIC_FILES } from '../services/WitnessKitService.js';

/**
 * W102 (v2.247.0, ADR 0040 addendum) - the cabinet install kit download.
 *
 * Pinned, worst-bug-first:
 *   1. The kit is ALWAYS the highest stable release: never beta or draft,
 *      numeric compare (1.0.10 > 1.0.9); none -> not available / 404.
 *   2. The zip is a valid archive: four entries under `arcaid-witness/`, CRCs
 *      right, the bytes round-trip through inflate, the ELF marked 0755.
 *   3. A missing static file or a missing / altered ELF gives no kit.
 *
 * The zip is parsed here from its central directory with an independent
 * CRC, so a writer bug cannot hide behind its own reader.
 */

const USER = '123456789012345678';
const REPO_KIT = path.join(process.cwd(), 'witness-kit');

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });
const auth = { Authorization: `Bearer ${playerToken(USER)}` };

const binary = (res: NodeJS.ReadableStream, cb: (err: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
};

/** A compressible fake ELF (so the deflate path is really exercised). */
const fakeElf = (tag: string) => Buffer.concat([
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1, 0]),
    Buffer.from(`arcaid witness ${tag} `.repeat(4000)),
    crypto.randomBytes(512),
]);

/** Bitwise CRC-32, independent of the service's table. */
function refCrc32(buf: Buffer): number {
    let c = ~0;
    for (const b of buf) {
        c ^= b;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
    }
    return ~c >>> 0;
}

interface ParsedEntry { name: string; method: number; crc: number; madeBy: number; mode: number; data: Buffer }

/** Read a zip through its end record and central directory, inflating each entry from its local header. */
function parseZip(zip: Buffer): ParsedEntry[] {
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    const count = zip.readUInt16LE(eocd + 10);
    const cdSize = zip.readUInt32LE(eocd + 12);
    let p = zip.readUInt32LE(eocd + 16);
    expect(p + cdSize).toBe(eocd);
    const out: ParsedEntry[] = [];
    for (let i = 0; i < count; i++) {
        expect(zip.readUInt32LE(p)).toBe(0x02014b50);
        const madeBy = zip.readUInt16LE(p + 4);
        const method = zip.readUInt16LE(p + 10);
        const crc = zip.readUInt32LE(p + 16);
        const compSize = zip.readUInt32LE(p + 20);
        const size = zip.readUInt32LE(p + 24);
        const nameLen = zip.readUInt16LE(p + 28);
        const extraLen = zip.readUInt16LE(p + 30);
        const commentLen = zip.readUInt16LE(p + 32);
        const external = zip.readUInt32LE(p + 38);
        const localAt = zip.readUInt32LE(p + 42);
        const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8');

        expect(zip.readUInt32LE(localAt)).toBe(0x04034b50);
        expect(zip.readUInt32LE(localAt + 14)).toBe(crc);
        expect(zip.readUInt32LE(localAt + 18)).toBe(compSize);
        expect(zip.readUInt32LE(localAt + 22)).toBe(size);
        const localName = zip.readUInt16LE(localAt + 26);
        const localExtra = zip.readUInt16LE(localAt + 28);
        expect(zip.subarray(localAt + 30, localAt + 30 + localName).toString('utf8')).toBe(name);
        const start = localAt + 30 + localName + localExtra;
        const raw = zip.subarray(start, start + compSize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
        expect(data.length).toBe(size);
        out.push({ name, method, crc, madeBy, mode: external >>> 16, data });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

let releaseRoot: string;
let app: express.Express;

async function createApp() {
    await setupTestDb();
    const a = express();
    a.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    a.use('/api', globalRouter);
    return a;
}

/** A release row with its ELF on disk, as `WitnessReleaseService.store` leaves it. */
async function seedRelease(version: string, channel: 'draft' | 'beta' | 'stable', elf: Buffer = fakeElf(version)) {
    const dir = path.join(releaseRoot, version);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'arcaid-witness.elf'), elf);
    const db = await getDatabase();
    await db.run(
        `INSERT INTO witness_app_releases (version, channel, size, sha256, sig) VALUES (?, ?, ?, ?, 'x')`,
        version, channel, elf.length, crypto.createHash('sha256').update(elf).digest('hex'),
    );
    return elf;
}

const kitInfo = () => request(app).get('/api/me/witness/kit').set(auth);
const kitDownload = () => request(app).get('/api/me/witness/kit/download').set(auth).buffer(true).parse(binary);

beforeEach(async () => {
    releaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-kit-releases-'));
    WitnessReleaseService.setRootForTests(releaseRoot);
    WitnessKitService.setRootForTests(null);
    app = await createApp();
});
afterEach(() => {
    WitnessReleaseService.setRootForTests(null);
    WitnessKitService.setRootForTests(null);
    fs.rmSync(releaseRoot, { recursive: true, force: true });
});

describe('the kit zip (W102)', () => {
    it('crc32 is the standard CRC-32', () => {
        expect(crc32(Buffer.from('123456789'))).toBe(0xCBF43926);
        expect(crc32(Buffer.alloc(0))).toBe(0);
    });

    it('four entries under arcaid-witness/, CRCs right, bytes round-trip, the ELF 0755', async () => {
        const elf = await seedRelease('1.1.1', 'stable');
        const res = await kitDownload();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('application/zip');
        expect(res.headers['content-disposition']).toBe('attachment; filename="arcaid-witness-kit-v1.1.1.zip"');
        const zip = res.body as Buffer;
        expect(res.headers['content-length']).toBe(String(zip.length));

        const entries = parseZip(zip);
        expect(entries.map(e => e.name)).toEqual([
            'arcaid-witness/arcaid-witness.elf',
            'arcaid-witness/arcaid-witness.png',
            'arcaid-witness/arcaid-witness.xml',
            'arcaid-witness/external_controller_db.txt',
        ]);
        for (const e of entries) {
            expect(e.method).toBe(8);
            expect(e.crc).toBe(refCrc32(e.data));
            expect(e.madeBy >> 8).toBe(3); // Unix, so the mode is honoured
        }
        expect(entries[0]!.data.equals(elf)).toBe(true);
        expect(entries[0]!.mode).toBe(0o100755);
        for (const [i, file] of KIT_STATIC_FILES.entries()) {
            expect(entries[i + 1]!.data.equals(fs.readFileSync(path.join(REPO_KIT, file)))).toBe(true);
            expect(entries[i + 1]!.mode).toBe(0o100644);
        }

        // The info route describes the same zip.
        const info = await kitInfo();
        expect(info.status).toBe(200);
        expect(info.body).toEqual({
            available: true,
            version: '1.1.1',
            sizeBytes: zip.length,
            elfSha256: crypto.createHash('sha256').update(elf).digest('hex'),
            publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/),
        });
    });

    it('is the highest STABLE release: never beta or draft, numeric compare', async () => {
        await seedRelease('1.0.9', 'stable');
        await seedRelease('1.0.10', 'stable');
        await seedRelease('1.2.0', 'beta');
        await seedRelease('9.9.9', 'draft');
        expect((await kitInfo()).body.version).toBe('1.0.10');
        expect((await kitDownload()).headers['content-disposition']).toContain('arcaid-witness-kit-v1.0.10.zip');
        expect(await WitnessKitService.buildKit('1.2.0')).toBeNull();
        expect(await WitnessKitService.buildKit('9.9.9')).toBeNull();
        expect(await WitnessKitService.buildKit('../1.0.10')).toBeNull();
    });

    it('no stable release: not available, and the download is 404', async () => {
        expect((await kitInfo()).body).toEqual({ available: false });
        await seedRelease('1.2.0', 'beta');
        await seedRelease('1.3.0', 'draft');
        expect((await kitInfo()).body).toEqual({ available: false });
        const res = await request(app).get('/api/me/witness/kit/download').set(auth);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: 'KIT_NOT_AVAILABLE' });
    });

    it('a missing static file gives no kit', async () => {
        const partial = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-kit-static-'));
        try {
            for (const file of KIT_STATIC_FILES.slice(0, 2)) fs.copyFileSync(path.join(REPO_KIT, file), path.join(partial, file));
            WitnessKitService.setRootForTests(partial);
            await seedRelease('1.1.1', 'stable');
            expect((await kitInfo()).body).toEqual({ available: false });
            expect((await request(app).get('/api/me/witness/kit/download').set(auth)).status).toBe(404);
            // The third file arrives: the kit is back.
            fs.copyFileSync(path.join(REPO_KIT, KIT_STATIC_FILES[2]), path.join(partial, KIT_STATIC_FILES[2]));
            expect((await kitInfo()).body.available).toBe(true);
        } finally {
            fs.rmSync(partial, { recursive: true, force: true });
        }
    });

    it('a missing or altered ELF gives no kit', async () => {
        const elf = await seedRelease('1.1.1', 'stable');
        const file = path.join(releaseRoot, '1.1.1', 'arcaid-witness.elf');
        // Same size, different bytes: refused on the SHA-256.
        const altered = Buffer.from(elf);
        altered[altered.length - 1] = altered[altered.length - 1]! ^ 0xff;
        fs.writeFileSync(file, altered);
        expect((await kitInfo()).body).toEqual({ available: false });
        fs.rmSync(file);
        expect((await kitInfo()).body).toEqual({ available: false });
    });

    it('caches the built zip per version, and a new stable release replaces it', async () => {
        await seedRelease('1.1.1', 'stable');
        const first = await WitnessKitService.buildKit('1.1.1');
        expect(first).not.toBeNull();
        expect(await WitnessKitService.buildKit('1.1.1')).toBe(first);
        await seedRelease('1.1.2', 'stable');
        const kit = await WitnessKitService.current();
        expect(kit!.release.version).toBe('1.1.2');
        expect(kit!.zip).not.toBe(first);
    });

    it('both routes need a signed-in player', async () => {
        await seedRelease('1.1.1', 'stable');
        expect((await request(app).get('/api/me/witness/kit')).status).toBe(401);
        expect((await request(app).get('/api/me/witness/kit/download')).status).toBe(401);
    });
});
