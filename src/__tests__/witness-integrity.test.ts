import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { CreateTournamentSchema, UpdateTournamentSchema } from '../api/schemas.js';
import { DEFAULT_SANCTIONED_RULES } from '../utils/sanctionedRules.js';

/**
 * Integrity mode — Open play / Sanctioned play, end to end (v2.165.0, ADR 0027).
 *
 * What these pin, worst-bug-first:
 *
 *   1. **Sanctioned play holds a failing score out of THAT board only.** It is
 *      not written to the tournament, the device is told `not_sanctioned` with
 *      the reasons, and the play still reaches the player's Global record.
 *   2. **Open play never refuses.** The same evidence lands the score and
 *      stores the verdict as a badge.
 *   3. **Every witness score leaves an evidence row** — both modes, every
 *      outcome — keyed to the `score_history` row it produced, so the runner's
 *      review and the board badge read the same record.
 *   4. **The VPS game id matches before the name**, so a room's own spelling
 *      of a table no longer decides whether a companion score is found.
 *   5. **A cabinet is unaffected on the wire**: no evidence means a Sanctioned
 *      refusal, but the cabinet is told `no_match` (a status it knows).
 */

const USER = '123456789012345678';
const DESKTOP = '7f0c1a9e-3b2d-4c5e-9f6a-1b2c3d4e5f60';
const CABINET = 'fp-device-uuid-vpx';
const MINUTE = 60_000;
const SHA = 'a'.repeat(64);

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: integrityRouter } = await import('../api/routes/integrity.js');
    app.use('/api', globalRouter);
    app.use('/api', integrityRouter);
    return app;
}

async function pair(app: express.Express, device: string, type?: 'desktop') {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device, username: 'Owner', ...(type ? { type } : {}) });
    return pairRes.body.token as string;
}

async function addMember(roomId: string, userId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, userId, roomId);
}

async function designate(device: string, roomId: string, tournamentId: string | null = null) {
    const { WitnessService } = await import('../services/WitnessService.js');
    await WitnessService.setDeviceTarget(USER, device, { roomId, tournamentId });
}

async function createRotationGame(roomId: string, name: string, opts: {
    mode?: 'open' | 'sanctioned'; rules?: Record<string, unknown> | null;
    requiredVpsTableId?: string | null;
} = {}) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, integrity_mode, sanctioned_rules)
         VALUES (?, 'Weekly VPX', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?, ?)`,
        tournamentId, roomId, opts.mode ?? 'open', opts.rules ? JSON.stringify(opts.rules) : null,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date, required_vps_table_id)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(), opts.requiredVpsTableId ?? null,
    );
    return { tournamentId, gameId };
}

async function seedCatalogue(name: string, vpsId: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status, vps_id)
         VALUES (?, ?, 'pinball', 'Data East', 1993, 'approved', ?)`,
        id, name, vpsId,
    );
    return id;
}

/** What Castcade 0.2.8 sent for the owner's Tales from the Crypt game on 2026-10-20 (tilt sensitivity as given). */
function evidence(over: { ini?: Record<string, unknown>; build?: Record<string, unknown>; vps_table?: string; omit?: boolean } = {}) {
    if (over.omit) return {};
    const ini = {
        set: 0, set_name: null, flippers: false, stock: true, difficulty: 0.56, difficulty_override: null,
        slope: 6.2, nudge: 0.0008, legacy_nudge: false, nudge_filter: false, nudge_sensitivity: null,
        accel: true, accel_gain_x: 115, accel_gain_y: 115, accel_max_x: 100, accel_max_y: 100, accel_velocity: false,
        tilt_sens: 500, tilt_sens_set: true, options: {}, overrides: [], table_ini: true, ...(over.ini ?? {}),
    };
    const build = {
        vpx: { sha256: SHA, version: '10.8.0.2078.Panasony', known: null, family: 'panasony' },
        vpinmame: { sha256: 'b'.repeat(64), version: '3, 7, 0, 222', known: null, family: 'nightly' },
        cheat: false, ...(over.build ?? {}),
    };
    return {
        vps_game: 'fXaQ33KC', vps_table: over.vps_table ?? 'uVgZUZdK', table_sha256: SHA, table_save_rev: 12,
        ini: JSON.stringify(ini), build: JSON.stringify(build),
    };
}

function scoreQuery(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Tales from the Crypt (Data East 1993)', rom: 'tftc_400', slug: 'vpx-talesfromthecrypt',
        score: 107434140, started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

describe('Integrity mode — the ingest', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pair(app, DESKTOP, 'desktop');
        await addMember(roomId, USER);
        await seedCatalogue('Tales from the Crypt (Data East 1993)', 'fXaQ33KC');
    });

    it('Open play: the score lands, the verdict is stored as a badge, and the public integrity read maps it', async () => {
        const { tournamentId, gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)');
        await designate(DESKTOP, roomId);

        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...evidence() });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        expect(res.body.reasons).toBeUndefined();

        const db = await getDatabase();
        const score = await db.get<{ id: number }>(`SELECT id FROM score_history WHERE game_id = ?`, gameId);
        const row = await db.get<{ outcome: string; verdict: string; integrity_mode: string; score_history_id: number; vps_table: string; ini: string }>(
            `SELECT outcome, verdict, integrity_mode, score_history_id, vps_table, ini FROM witness_evidence WHERE tournament_id = ?`, tournamentId,
        );
        expect(row).toMatchObject({ outcome: 'ingested', verdict: 'pass', integrity_mode: 'open', score_history_id: score!.id, vps_table: 'uVgZUZdK' });
        expect(JSON.parse(row!.ini)).toMatchObject({ tilt_sens: 500, accel_gain_x: 115 });

        const pub = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(pub.status).toBe(200);
        expect(pub.body.mode).toBe('open');
        expect(pub.body.rules).toEqual(DEFAULT_SANCTIONED_RULES);
        expect(pub.body.verdicts[String(score!.id)]).toEqual({ verdict: 'pass', reasons: [] });
    });

    it('Open play never refuses: tilt sensitivity 10 still lands, flagged, with the reason on record', async () => {
        const { gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)');
        await designate(DESKTOP, roomId);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DESKTOP, token, ...scoreQuery(), ...evidence({ ini: { tilt_sens: 10 } }) });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });

        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeTruthy();
        const row = await db.get<{ verdict: string; reasons: string }>(`SELECT verdict, reasons FROM witness_evidence WHERE game_id = ?`, gameId);
        expect(row!.verdict).toBe('flagged');
        expect(JSON.parse(row!.reasons)).toEqual(['tilt sensitivity 10 is below the minimum 300']);
    });

    it('Sanctioned play: the same clean evidence lands with a pass', async () => {
        const { gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned' });
        await designate(DESKTOP, roomId);
        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...evidence() });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const db = await getDatabase();
        expect(await db.get(`SELECT verdict FROM witness_evidence WHERE game_id = ?`, gameId)).toMatchObject({ verdict: 'pass' });
    });

    it('Sanctioned play holds a failing score out of the board, says why, and the play still reaches Global', async () => {
        const { tournamentId, gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned' });
        await designate(DESKTOP, roomId);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DESKTOP, token, ...scoreQuery(), ...evidence({ ini: { tilt_sens: 10 } }) });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            ok: true, status: 'not_sanctioned', game: 'Tales from the Crypt (Data East 1993)',
            reasons: ['tilt sensitivity 10 is below the minimum 300'], fallback: 'global',
        });

        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
        const global = await db.get<{ id: string; score: number }>(`SELECT id, score FROM global_scores WHERE player_id = ?`, USER);
        expect(global).toMatchObject({ score: 107434140 });

        const trail = await db.all<Array<{ outcome: string; verdict: string; global_score_id: string | null; score_history_id: number | null }>>(
            `SELECT outcome, verdict, global_score_id, score_history_id FROM witness_evidence WHERE tournament_id = ?`, tournamentId,
        );
        expect(trail).toEqual([{ outcome: 'not_sanctioned', verdict: 'flagged', global_score_id: global!.id, score_history_id: null }]);

        // The runner's view lists it; the public verdict map does not (no board row to badge).
        const admin = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
        const review = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/evidence`).set('Authorization', `Bearer ${admin}`);
        expect(review.status).toBe(200);
        expect(review.body.evidence).toHaveLength(1);
        expect(review.body.evidence[0]).toMatchObject({ outcome: 'not_sanctioned', verdict: 'flagged', score: 107434140, tableName: 'Tales from the Crypt (Data East 1993)' });
        expect(review.body.evidence[0].evidence.ini.tilt_sens).toBe(10);
        expect(review.body.evidence[0].checks.find((c: { rule: string }) => c.rule === 'tilt_sensitivity')).toMatchObject({ status: 'fail' });
        const pub = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(pub.body.verdicts).toEqual({});
    });

    it('the runner\'s rules apply: a nightly VPinMAME is refused once nightlies are off, and a blessed hash admits an unknown VPX', async () => {
        await designate(DESKTOP, roomId);
        const strict = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', {
            mode: 'sanctioned', rules: { allow_nightly_builds: false },
        });
        let res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...evidence() });
        expect(res.body.status).toBe('not_sanctioned');
        expect(res.body.reasons[0]).toMatch(/VPinMAME .* nightly/);
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET is_active = 0 WHERE id = ?`, strict.tournamentId);

        await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', {
            mode: 'sanctioned', rules: { blessed_build_hashes: [SHA] },
        });
        const unknownVpx = evidence({ build: { vpx: { sha256: SHA, version: '10.8.0.9999', known: null, family: 'unknown' } } });
        res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery({ score: 5 }), ...unknownVpx });
        expect(res.body.status).toBe('ingested');
    });

    it('the named table: a different table of the same game is refused, the required one is accepted', async () => {
        await designate(DESKTOP, roomId);
        await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned', requiredVpsTableId: 'uVgZUZdK' });
        let res = await request(app).get('/api/witness/score')
            .query({ device: DESKTOP, token, ...scoreQuery(), ...evidence({ vps_table: 'OTHER1' }) });
        expect(res.body.status).toBe('not_sanctioned');
        expect(res.body.reasons[0]).toMatch(/different table of this game/);
        res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery({ score: 6 }), ...evidence() });
        expect(res.body.status).toBe('ingested');
    });

    it('the VPS game id finds the game when the room spelled the table differently', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE global_games SET name = 'TFTC (Data East)' WHERE vps_id = 'fXaQ33KC'`);
        const { gameId } = await createRotationGame(roomId, 'TFTC (Data East)');
        await designate(DESKTOP, roomId);

        // Without the id the names do not meet, so the score would go to Global.
        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...evidence() });
        expect(res.body).toMatchObject({ status: 'ingested', game: 'TFTC (Data East)' });
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeTruthy();
    });

    it('a cabinet in a Sanctioned tournament is told no_match (its own vocabulary) while the trail says not_sanctioned', async () => {
        const cabinetToken = await pair(app, CABINET);
        const { tournamentId, gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned' });
        await designate(CABINET, roomId);

        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token: cabinetToken, ...scoreQuery() });
        expect(res.body).toEqual({ ok: true, status: 'no_match', game: 'Tales from the Crypt (Data East 1993)' });

        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
        const row = await db.get<{ outcome: string; reasons: string; ini: string | null }>(`SELECT outcome, reasons, ini FROM witness_evidence WHERE tournament_id = ?`, tournamentId);
        expect(row!.outcome).toBe('not_sanctioned');
        expect(JSON.parse(row!.reasons)[0]).toMatch(/no evidence/);
        expect(row!.ini).toBeNull();
    });

    it('a cabinet in Open play is untouched: ingested, with an evidence row that only says "no evidence"', async () => {
        const cabinetToken = await pair(app, CABINET);
        const { gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)');
        await designate(CABINET, roomId);
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token: cabinetToken, ...scoreQuery() });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const db = await getDatabase();
        expect(await db.get(`SELECT outcome, verdict FROM witness_evidence WHERE game_id = ?`, gameId)).toMatchObject({ outcome: 'ingested', verdict: 'flagged' });
    });

    it('an undesignated desktop score still goes to Global, and leaves a trail with no tournament and no verdict', async () => {
        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...evidence() });
        expect(res.body).toMatchObject({ ok: true, status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ outcome: string; verdict: string | null; tournament_id: string | null; global_score_id: string | null }>(
            `SELECT outcome, verdict, tournament_id, global_score_id FROM witness_evidence WHERE canonical_user_id = ?`, USER,
        );
        expect(row).toMatchObject({ outcome: 'global', verdict: null, tournament_id: null });
        expect(row!.global_score_id).toBeTruthy();

        const mine = await request(app).get('/api/me/witness/evidence/latest?vps_game=fXaQ33KC').set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(mine.status).toBe(200);
        expect(mine.body.evidence).toMatchObject({ outcome: 'global', evidence: { vpsTable: 'uVgZUZdK', tableSha256: SHA } });
    });

    it('the check-in line names Sanctioned play so the player sees it before the game', async () => {
        const { tournamentId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned' });
        await designate(DESKTOP, roomId, tournamentId);
        const res = await request(app).get('/api/witness/checkin').query({ device: DESKTOP, token });
        expect(res.body.sendingTo).toMatch(/Weekly VPX \(Sanctioned play\)/);
    });
});

describe('Integrity mode — the runner\'s configuration', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
    });

    it('the tournament schemas accept the mode and a partial rule set, and TournamentService stores them normalised', async () => {
        const base = { id: crypto.randomUUID(), name: 'Sanctioned Weekly', type: 'SW', cadence: { cron: '0 0 * * *', autoRotate: true, autoLock: true } };
        const parsed = CreateTournamentSchema.parse({ ...base, integrity_mode: 'sanctioned', sanctioned_rules: { min_tilt_sensitivity: 350, nonsense: 1 } });
        expect(parsed.integrity_mode).toBe('sanctioned');
        expect(() => CreateTournamentSchema.parse({ ...base, integrity_mode: 'strict' })).toThrow();

        const { TournamentService } = await import('../services/TournamentService.js');
        await TournamentService.create({ ...parsed, game_room_id: roomId } as any);
        const db = await getDatabase();
        let row = await db.get<{ integrity_mode: string; sanctioned_rules: string }>(`SELECT integrity_mode, sanctioned_rules FROM tournaments WHERE id = ?`, base.id);
        expect(row!.integrity_mode).toBe('sanctioned');
        expect(JSON.parse(row!.sanctioned_rules)).toEqual({ ...DEFAULT_SANCTIONED_RULES, min_tilt_sensitivity: 350 });

        // An edit that does not mention integrity keeps it (a form that predates the field must not reset it).
        const update = UpdateTournamentSchema.parse({ name: 'Renamed', type: 'SW', cadence: base.cadence });
        await TournamentService.update(base.id, { ...update, game_room_id: roomId } as any);
        row = await db.get(`SELECT integrity_mode, sanctioned_rules FROM tournaments WHERE id = ?`, base.id);
        expect(row!.integrity_mode).toBe('sanctioned');
        expect(JSON.parse(row!.sanctioned_rules).min_tilt_sensitivity).toBe(350);

        // null = back to the defaults; 'open' switches the mode off.
        await TournamentService.update(base.id, { ...update, game_room_id: roomId, integrity_mode: 'open', sanctioned_rules: null } as any);
        row = await db.get(`SELECT integrity_mode, sanctioned_rules FROM tournaments WHERE id = ?`, base.id);
        expect(row).toEqual({ integrity_mode: 'open', sanctioned_rules: null });

        // A tournament created by any older writer defaults to Open play.
        const legacy = crypto.randomUUID();
        await db.run(`INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id) VALUES (?, 'Old', 'O', 'pinball', '{}', 1, ?)`, legacy, roomId);
        expect(await db.get(`SELECT integrity_mode FROM tournaments WHERE id = ?`, legacy)).toEqual({ integrity_mode: 'open' });
    });

    it('a room admin names the required table per game; null clears it; a game outside the tournament is a 404; a player is refused', async () => {
        const { tournamentId, gameId } = await createRotationGame(roomId, 'Tales from the Crypt (Data East 1993)', { mode: 'sanctioned' });
        const other = await createRotationGame(roomId, 'Bad Cats');
        const admin = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
        const url = `/api/rooms/${roomId}/tournaments/${tournamentId}/games/${gameId}/requirements`;

        let res = await request(app).patch(url).set('Authorization', `Bearer ${admin}`).send({ required_vps_table_id: ' uVgZUZdK ', required_rom: 'tftc_400' });
        expect(res.status).toBe(200);
        expect(res.body.game).toMatchObject({ gameId, requiredVpsTableId: 'uVgZUZdK', requiredRom: 'tftc_400', requiredFingerprint: null });

        const pub = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(pub.body.mode).toBe('sanctioned');
        expect(pub.body.games).toEqual([{ gameId, name: 'Tales from the Crypt (Data East 1993)', status: 'ACTIVE', requiredVpsTableId: 'uVgZUZdK', requiredRom: 'tftc_400', requiredFingerprint: null }]);

        res = await request(app).patch(url).set('Authorization', `Bearer ${admin}`).send({ required_rom: null });
        expect(res.body.game).toMatchObject({ requiredVpsTableId: 'uVgZUZdK', requiredRom: null });

        res = await request(app).patch(`/api/rooms/${roomId}/tournaments/${tournamentId}/games/${other.gameId}/requirements`)
            .set('Authorization', `Bearer ${admin}`).send({ required_vps_table_id: 'x' });
        expect(res.status).toBe(404);

        res = await request(app).patch(url).set('Authorization', `Bearer ${playerToken(USER)}`).send({ required_vps_table_id: 'x' });
        expect([401, 403]).toContain(res.status);

        const stranger = signToken({ role: 'room_admin', gameRoomIds: ['some-other-room'] });
        res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/evidence`).set('Authorization', `Bearer ${stranger}`);
        expect([401, 403]).toContain(res.status);
        res = await request(app).get(`/api/rooms/some-other-room/tournaments/${tournamentId}/integrity`);
        expect(res.status).toBe(404);
    });

    it('the VPS import stores each game\'s tables and the catalogue route lists them; a dropped table id is removed on re-sync', async () => {
        const { VpsImportService } = await import('../services/VpsImportService.js');
        const gameId = await seedCatalogue('Tales from the Crypt (Data East 1993)', 'fXaQ33KC');
        const vps = {
            id: 'fXaQ33KC', name: 'Tales from the Crypt', updatedAt: 1760000000000,
            tableFiles: [
                { id: 'uVgZUZdK', tableFormat: 'VPX', authors: ['VPW'], version: '1.22', features: ['VR', 'FSS', 'SSF'] },
                { id: 'OLDTABLE', tableFormat: 'VPX', authors: ['someone'], version: '1.0' },
            ],
        };
        await VpsImportService.syncTableFiles(gameId, vps as any);
        let res = await request(app).get(`/api/global/games/${gameId}/tables`);
        expect(res.status).toBe(200);
        expect(res.body.vpsGameId).toBe('fXaQ33KC');
        expect(res.body.tables).toHaveLength(2);
        expect(res.body.tables.find((t: { vpsTableId: string }) => t.vpsTableId === 'uVgZUZdK')).toMatchObject({
            name: 'VPW v1.22', authors: ['VPW'], version: '1.22', tableFormat: 'vpx', features: ['VR', 'FSS', 'SSF'],
        });

        await VpsImportService.syncTableFiles(gameId, { ...vps, tableFiles: [vps.tableFiles[0]] } as any);
        res = await request(app).get(`/api/global/games/${gameId}/tables`);
        expect(res.body.tables.map((t: { vpsTableId: string }) => t.vpsTableId)).toEqual(['uVgZUZdK']);
        expect((await request(app).get(`/api/global/games/${crypto.randomUUID()}/tables`)).status).toBe(404);
    });
});
