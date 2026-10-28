import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * v2.193.0 (W12, castcade B8/F8) - the ROM -> VPS game map.
 *
 * What these pin, worst-bug-first:
 *
 *   1. **A ROM resolves a play the names cannot.** A cabinet record whose
 *      display name is nothing like the room's ("MM 1.09c (WPC)") still lands
 *      on the room's ACTIVE "Medieval Madness" because its `rom` maps to that
 *      ONE catalogue game - and the Global fall-through finds it too.
 *   2. **An ambiguous ROM is never a guess** - in the ingest or on the wire.
 *   3. **An unknown ROM changes nothing.**
 *   4. The VPS import fills the map from `romFiles[].version` (the companion's
 *      own field), idempotently, and drops ROMs VPS no longer lists.
 *   5. The public map honours approved + VPS-identified only and carries a
 *      stable version that is also its ETag.
 */

const USER = '123456789012345678';
const DEVICE = 'fp-device-uuid-roms';
const MINUTE = 60_000;

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
        .query({ code: codeRes.body.code, device: DEVICE, username: 'CabinetOwner' });
    return pairRes.body.token as string;
}

async function addMember(roomId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
}

async function createRotationGame(roomId: string, name: string) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Weekly VPXS', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

async function seedCatalogue(name: string, opts: { vpsId?: string | null; status?: string; manufacturer?: string; year?: number } = {}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status, vps_id)
         VALUES (?, ?, 'pinball', ?, ?, ?, ?)`,
        id, name, opts.manufacturer ?? 'Williams', opts.year ?? 1997, opts.status ?? 'approved',
        opts.vpsId === undefined ? `vps-${id.slice(0, 8)}` : opts.vpsId,
    );
    return id;
}

async function mapRoms(globalGameId: string, vpsId: string, roms: string[]) {
    const { VpsImportService } = await import('../services/VpsImportService.js');
    await VpsImportService.syncRomFiles(globalGameId, {
        id: vpsId, name: 'x', romFiles: roms.map(version => ({ id: `file-${version}`, version })),
    } as any);
}

/** A cabinet record whose names do NOT meet "Medieval Madness"; only the rom does. */
function scoreQuery(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'MM 1.09c (WPC)', rom: 'mm_109c', slug: 'vpx-mm109c',
        score: 41234560, started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

describe('ROM map - storage and the VPS import', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('migration 197 creates global_game_roms with its rom index', async () => {
        const db = await getDatabase();
        const cols = (await db.all(`PRAGMA table_info(global_game_roms)`)) as Array<{ name: string; pk: number }>;
        expect(cols.map(c => c.name)).toEqual(['global_game_id', 'rom', 'source', 'created_at']);
        expect(cols.filter(c => c.pk > 0).map(c => c.name)).toEqual(['global_game_id', 'rom']);
        const idx = (await db.all(`PRAGMA index_list(global_game_roms)`)) as Array<{ name: string }>;
        expect(idx.map(i => i.name)).toContain('idx_global_game_roms_rom');
    });

    it('syncRomFiles stores romFiles[].version lowercased, ignores the file id, and drops what VPS stops listing', async () => {
        const { VpsImportService } = await import('../services/VpsImportService.js');
        const db = await getDatabase();
        const gameId = await seedCatalogue('Medieval Madness', { vpsId: '-5yMpqSy' });
        const vps = {
            id: '-5yMpqSy', name: 'Medieval Madness',
            romFiles: [
                { id: 'aB3xFileId', version: ' MM_109C ' },
                { id: 'cD4yFileId', version: 'mm_109b' },
                { id: 'dupeFileId', version: 'mm_109c' },
                { id: 'noVersion' },
            ],
        };
        await VpsImportService.syncRomFiles(gameId, vps as any);
        await VpsImportService.syncRomFiles(gameId, vps as any);
        const roms = async () => (await db.all<Array<{ rom: string; source: string }>>(
            `SELECT rom, source FROM global_game_roms WHERE global_game_id = ? ORDER BY rom`, gameId,
        ));
        expect(await roms()).toEqual([{ rom: 'mm_109b', source: 'vps' }, { rom: 'mm_109c', source: 'vps' }]);

        // A ROM from another source survives the VPS re-sync; a dropped VPS ROM does not.
        await db.run(`INSERT INTO global_game_roms (global_game_id, rom, source) VALUES (?, 'mm_10', 'consensus')`, gameId);
        await VpsImportService.syncRomFiles(gameId, { ...vps, romFiles: [{ id: 'x', version: 'mm_109c' }] } as any);
        expect(await roms()).toEqual([{ rom: 'mm_10', source: 'consensus' }, { rom: 'mm_109c', source: 'vps' }]);

        await VpsImportService.syncRomFiles(gameId, { ...vps, romFiles: undefined } as any);
        expect(await roms()).toEqual([{ rom: 'mm_10', source: 'consensus' }]);
    });

    it('deleting or merging a catalogue game carries its ROMs with it', async () => {
        const { GlobalGameService } = await import('../services/GlobalGameService.js');
        const db = await getDatabase();
        const a = await seedCatalogue('Medieval Madness', { vpsId: 'A' });
        const b = await seedCatalogue('Medieval Madness (Williams 1997)', { vpsId: 'B' });
        await mapRoms(a, 'A', ['mm_109c']);
        await mapRoms(b, 'B', ['mm_109c', 'mm_109b']);
        await GlobalGameService.merge(a, b); // (target, source)
        expect(await db.all(`SELECT global_game_id, rom FROM global_game_roms ORDER BY rom`)).toEqual([
            { global_game_id: a, rom: 'mm_109b' }, { global_game_id: a, rom: 'mm_109c' },
        ]);
        await GlobalGameService.delete(a);
        expect(await db.all(`SELECT rom FROM global_game_roms`)).toEqual([]);
    });
});

describe('GET /api/witness/roms', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('lists a ROM, an ambiguous ROM as ambiguous, honours approved + vps_id, and versions stably', async () => {
        const mm = await seedCatalogue('Medieval Madness', { vpsId: '-5yMpqSy' });
        const afm = await seedCatalogue('Attack from Mars', { vpsId: 'afmVps', manufacturer: 'Bally', year: 1995 });
        const mars = await seedCatalogue('Mars Attacks! Pinball', { vpsId: 'marsVps', manufacturer: 'Original', year: 2022 });
        const pending = await seedCatalogue('Pending Table', { vpsId: 'pendVps', status: 'pending' });
        const noVps = await seedCatalogue('Hand Entered', { vpsId: null });
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        await mapRoms(afm, 'afmVps', ['afm_113b']);
        await mapRoms(mars, 'marsVps', ['afm_113b']);
        await mapRoms(pending, 'pendVps', ['pend_10']);
        await mapRoms(noVps, '', ['hand_10']);

        const res = await request(app).get('/api/witness/roms');
        expect(res.status).toBe(200);
        expect(res.headers['cache-control']).toBe('public, max-age=3600');
        expect(res.body.count).toBe(2);
        expect(res.body.roms.mm_109c).toEqual({
            vpsGameId: '-5yMpqSy', globalGameId: mm, name: 'Medieval Madness', manufacturer: 'Williams', year: 1997,
        });
        expect(res.body.roms.afm_113b).toEqual({
            ambiguous: true,
            candidates: [
                { vpsGameId: 'afmVps', globalGameId: afm, name: 'Attack from Mars', manufacturer: 'Bally', year: 1995 },
                { vpsGameId: 'marsVps', globalGameId: mars, name: 'Mars Attacks! Pinball', manufacturer: 'Original', year: 2022 },
            ],
        });
        expect(res.body.roms.pend_10).toBeUndefined();
        expect(res.body.roms.hand_10).toBeUndefined();
        expect(res.body.version).toMatch(/^[0-9a-f]{16}$/);
        expect(res.headers.etag).toBe(`"${res.body.version}"`);

        // Same map, same version; a revalidation is a 304.
        const again = await request(app).get('/api/witness/roms');
        expect(again.body.version).toBe(res.body.version);
        const cached = await request(app).get('/api/witness/roms').set('If-None-Match', `"${res.body.version}"`);
        expect(cached.status).toBe(304);

        // The map changes, the version changes.
        await mapRoms(mm, '-5yMpqSy', ['mm_109c', 'mm_109b']);
        const changed = await request(app).get('/api/witness/roms');
        expect(changed.body.version).not.toBe(res.body.version);
        expect(changed.body.count).toBe(3);
    });
});

describe('ROM map - the ingest tier', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;
    let mm: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDevice(app);
        await addMember(roomId);
        mm = await seedCatalogue('Medieval Madness', { vpsId: '-5yMpqSy' });
    });

    it('baseline: without the map, the names alone do not find Medieval Madness', async () => {
        const { gameId } = await createRotationGame(roomId, 'Medieval Madness');
        const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(res.body.status).not.toBe('ingested');
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
    });

    it('a rom the map gives to ONE game lands the play on the room\'s ACTIVE game of that name', async () => {
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        const { gameId } = await createRotationGame(roomId, 'Medieval Madness');
        const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery({ rom: 'MM_109C' }) });
        expect(res.body).toMatchObject({ status: 'ingested', game: 'Medieval Madness' });
        const db = await getDatabase();
        expect(await db.get(`SELECT score FROM score_history WHERE game_id = ? AND source = 'vpx'`, gameId))
            .toEqual({ score: 41234560 });
    });

    it('the rom tier never widens matching: a room game of ANOTHER name is not matched', async () => {
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        const { gameId } = await createRotationGame(roomId, 'Attack from Mars');
        await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
    });

    it('with no open game, the Global fall-through records it against the rom\'s catalogue game', async () => {
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(res.body.status).toBe('global');
        const db = await getDatabase();
        expect(await db.get(`SELECT global_game_id FROM global_scores WHERE player_id = ?`, USER))
            .toEqual({ global_game_id: mm });
    });

    it('a rom mapped to two catalogue games falls back to today\'s behaviour', async () => {
        const other = await seedCatalogue('Medieval Madness Remake', { vpsId: 'remakeVps', manufacturer: 'Original', year: 2024 });
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        await mapRoms(other, 'remakeVps', ['mm_109c']);
        const { gameId } = await createRotationGame(roomId, 'Medieval Madness');
        const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery() });
        expect(res.body.status).not.toBe('ingested');
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
    });

    it('a rom unknown to the map changes nothing: a name match still lands, a non-match still does not', async () => {
        await mapRoms(mm, '-5yMpqSy', ['mm_109c']);
        const { gameId } = await createRotationGame(roomId, 'Medieval Madness');
        let res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...scoreQuery({ rom: 'zzz_999' }) });
        expect(res.body.status).not.toBe('ingested');
        res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token, ...scoreQuery({ rom: 'zzz_999', table: 'Medieval Madness (Williams 1997)', score: 5000000 }),
        });
        expect(res.body).toMatchObject({ status: 'ingested', game: 'Medieval Madness' });
        const db = await getDatabase();
        expect(await db.all(`SELECT score FROM score_history WHERE game_id = ?`, gameId)).toEqual([{ score: 5000000 }]);
    });
});
