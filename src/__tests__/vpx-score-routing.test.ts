import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * P9b — VPXS score ROUTING: which board a cabinet's scores land on.
 *
 * The player designates a room (and optionally one tournament in it) per paired
 * cabinet. What these tests pin:
 *
 *   1. **Undesignated is a useful default, not a hole.** Scores still reach
 *      Arcaid — on the player's own Global Scoreboard record — so a cabinet can
 *      be paired and then forgotten about and still be worth having.
 *   2. **A rotation tournament requires the designation.** It runs for days
 *      with no per-session act, so ordinary play at home must not quietly enter
 *      somebody into a competition. An EVENT is different: joining it IS that
 *      act, so an event round still counts with nothing configured.
 *   3. **The designation resolves what a name never can** — the same table open
 *      in two tournaments of one room.
 *   4. **A stale pointer cannot swallow scores.** A designated tournament that
 *      has finished reads as absent.
 */

const USER = '123456789012345678';
const DEVICE = 'fp-device-uuid-routing';
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

function scoreQuery(overrides: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000),
        ended: Math.floor(endedMs / 1000),
        dur: 300,
        reason: 'game_over',
        ...overrides,
    };
}

async function addMember(roomId: string, userId = USER) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        userId, roomId,
    );
}

/** Point the cabinet at a room (and optionally one tournament in it). */
async function designate(roomId: string | null, tournamentId: string | null = null) {
    const { WitnessService } = await import('../services/WitnessService.js');
    await WitnessService.setDeviceTarget(USER, DEVICE, { roomId, tournamentId });
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

async function createEventRound(roomId: string, name: string, startMs: number, endMs: number) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, end_grace_sec)
         VALUES (?, 'Stream Night', 'DG', 'pinball', '{}', 1, ?, 'event', 60)`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no,
                            scheduled_start_at, scheduled_end_at)
         VALUES (?, ?, ?, 'ACTIVE', ?, 1, ?, ?)`,
        gameId, tournamentId, name, roomId,
        new Date(startMs).toISOString(), new Date(endMs).toISOString(),
    );
    return { tournamentId, gameId };
}

/** A catalogue row is required before anything can land on the Global board. */
async function seedCatalogue(name: string, manufacturer: string | null = null, year: number | null = null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status)
         VALUES (?, ?, 'pinball', ?, ?, 'approved')`,
        id, name, manufacturer, year,
    );
    return id;
}

async function addParticipant(tournamentId: string, userId = USER) {
    const db = await getDatabase();
    await db.run(
        // `checked_in_at` is NOT NULL and `source` is CHECK-constrained; an
        // INSERT OR IGNORE that violates either silently inserts NOTHING, which
        // is exactly how a fixture can lie about what it set up.
        `INSERT OR IGNORE INTO tournament_participants (tournament_id, user_id, checked_in_at, source)
         VALUES (?, ?, datetime('now'), 'checkin')`,
        tournamentId, userId,
    );
}

describe('VPXS score routing', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDevice(app);
        await addMember(roomId);
    });

    it('sends an undesignated cabinet score to the Global Scoreboard, not to a rotation tournament', async () => {
        const { gameId } = await createRotationGame(roomId, 'Bad Cats');
        const globalGameId = await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ ok: true, status: 'global' });

        const db = await getDatabase();
        const global = await db.get<{
            global_game_id: string; score: number; engine: string;
            device: string; player_id: string; origin_type: string;
        }>(
            `SELECT global_game_id, score, engine, device, player_id, origin_type
               FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(global).toMatchObject({
            global_game_id: globalGameId, score: 8366650,
            engine: 'vpx', device: 'atgames', player_id: USER, origin_type: 'global',
        });

        // And emphatically NOT on the rotation board.
        const history = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM score_history WHERE game_id = ?`, gameId,
        );
        expect(history!.n).toBe(0);
    });

    it('still counts an event round the player joined, with nothing configured', async () => {
        const now = Date.now();
        const round = await createEventRound(roomId, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);
        await addParticipant(round.tournamentId);
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const db = await getDatabase();
        const row = await db.get<{ game_id: string }>(
            `SELECT game_id FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row!.game_id).toBe(round.gameId);
    });

    it('does not put a non-participant into an event round they never joined', async () => {
        const now = Date.now();
        await createEventRound(roomId, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'global' });
    });

    it('resolves the same table running in TWO tournaments of one room', async () => {
        const first = await createRotationGame(roomId, 'Bad Cats');
        const second = await createRotationGame(roomId, 'Bad Cats');
        await designate(roomId, second.tournamentId);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const db = await getDatabase();
        const row = await db.get<{ game_id: string }>(
            `SELECT game_id FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row!.game_id).toBe(second.gameId);
        expect(row!.game_id).not.toBe(first.gameId);
    });

    it('treats a designated tournament that has FINISHED as absent', async () => {
        // Two things are being pinned at once: the dead pointer stops narrowing,
        // AND the finished tournament's own leftover game stops being a
        // candidate — otherwise the two would collide as an ambiguity.
        const { tournamentId } = await createRotationGame(roomId, 'Bad Cats');
        await designate(roomId, tournamentId);
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET is_active = 0 WHERE id = ?`, tournamentId);
        const second = await createRotationGame(roomId, 'Bad Cats');

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        // The ROOM designation survives; the dead tournament pointer stops
        // narrowing, so the room's other open game takes the score.
        expect(res.body).toMatchObject({ status: 'ingested' });
        const row = await db.get<{ game_id: string }>(
            `SELECT game_id FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row!.game_id).toBe(second.gameId);
    });

    it('does not record the same global score twice', async () => {
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        const q = scoreQuery();

        const first = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });
        const second = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });

        expect(first.body.status).toBe('global');
        expect(second.body.status).toBe('global_duplicate');
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(1);
    });

    it('says so plainly when the table is not in the catalogue', async () => {
        // `global_scores.global_game_id` is NOT NULL, so there is genuinely
        // nowhere to put it — reported, never invented.
        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery({ table: 'Some Homebrew Table', rom: '', slug: '' }) });
        expect(res.body).toMatchObject({ status: 'no_match' });
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(0);
    });

    it('uses the manufacturer and year in the launcher name to pick between same-named machines', async () => {
        const williams = await seedCatalogue('Bad Cats', 'Williams', 1989);
        await seedCatalogue('Bad Cats', 'Zaccaria', 1983);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(williams);
    });

    it('refuses a designation for a room the player is not in', async () => {
        const strangers = await createTestRoom('strangers-2', 'Strangers');
        const res = await request(app)
            .patch(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ roomId: strangers });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NOT_A_MEMBER');
    });

    it('refuses a tournament that is not in the designated room', async () => {
        const otherRoom = await createTestRoom('other-2', 'Other');
        await addMember(otherRoom);
        const elsewhere = await createRotationGame(otherRoom, 'Bad Cats');

        const res = await request(app)
            .patch(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ roomId, tournamentId: elsewhere.tournamentId });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('TOURNAMENT_NOT_IN_ROOM');
    });

    it('clears the tournament when the room designation is cleared', async () => {
        const { tournamentId } = await createRotationGame(roomId, 'Bad Cats');
        await designate(roomId, tournamentId);

        const res = await request(app)
            .patch(`/api/me/witness/devices/${DEVICE}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ roomId: null });

        expect(res.status).toBe(200);
        expect(res.body.device).toMatchObject({ targetRoomId: null, targetTournamentId: null });
    });
});
