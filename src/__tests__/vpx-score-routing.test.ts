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
async function seedCatalogue(name: string, manufacturer: string | null = null, year: number | null = null, vpsId: string | null = null) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, status, vps_id)
         VALUES (?, ?, 'pinball', ?, ?, 'approved', ?)`,
        id, name, manufacturer, year, vpsId,
    );
    return id;
}

/** W110 — what a Wizard sync stores: the manifest's install folder -> VPS game id. */
async function mapWizardFolder(slug: string, vpsId: string) {
    const { GlobalGameSlugService } = await import('../services/GlobalGameSlugService.js');
    await GlobalGameSlugService.storeFromManifest([{ slug, vpsId, name: null }]);
}

async function latestGlobalGameId() {
    const db = await getDatabase();
    const row = await db.get<{ global_game_id: string }>(`SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`);
    return row?.global_game_id ?? null;
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

    it('W37: an "All my rooms" device (the default) lands in a MEMBER room\'s rotation (ADR 0033)', async () => {
        // Pre-v2.175.0 a rotation tournament REQUIRED a designation.
        await addMember(roomId);
        const { gameId } = await createRotationGame(roomId, 'Bad Cats');
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeTruthy();
    });

    it('W37: an "All my rooms" device does NOT enter a room the player is not a member of', async () => {
        const { gameId } = await createRotationGame(roomId, 'Bad Cats');
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        const db = await getDatabase();
        await db.run(`DELETE FROM room_members WHERE user_id = ?`, USER);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'global' });
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
    });

    it('sends a "Global Scoreboard only" device\'s score to the Global Scoreboard, not to a rotation tournament', async () => {
        await addMember(roomId);
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId: null, globalOnly: true });
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

    it('W26: "Global Scoreboard only" sends a joined ROOM event\'s play to Global (ADR 0032)', async () => {
        // Pre-v2.174.0 an undesignated device still reached the rounds of any
        // event the player had joined; the label said "Global Scoreboard only".
        // v2.175.0 (W37): Global-only is now an explicit setting (no room =
        // All my rooms), so the device opts out here.
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId: null, globalOnly: true });
        const now = Date.now();
        const round = await createEventRound(roomId, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);
        await addParticipant(round.tournamentId);
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, round.gameId)).toBeUndefined();
    });

    it('W26: a joined Throwdown (no room to point at) still counts, even from a Global-only device', async () => {
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, DEVICE, { roomId: null, globalOnly: true });
        const now = Date.now();
        const round = await createEventRound(null as unknown as string, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);
        await addParticipant(round.tournamentId);
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, round.gameId)).toBeTruthy();
    });

    it('W26: a joined Throwdown counts from a ROOM-pointed device too; a device pinned to a tournament stays pinned', async () => {
        const now = Date.now();
        await addMember(roomId);
        const pinned = await createRotationGame(roomId, 'Other Table');
        await designate(roomId);
        const round = await createEventRound(null as unknown as string, 'Bad Cats', now - 10 * MINUTE, now + 10 * MINUTE);
        await addParticipant(round.tournamentId);
        await seedCatalogue('Bad Cats', 'Williams', 1989);

        let res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });
        expect(res.body).toMatchObject({ status: 'ingested' });

        await designate(roomId, pinned.tournamentId);
        res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery({ score: 9000001 }) });
        expect(res.body).toMatchObject({ status: 'global' });
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
        // FINISHED = the W33 open-card rule (`utils/openCard.ts`): an event
        // whose clock has ended. A rotation cannot finish; `is_active = 0` on
        // one is a PAUSE (next test).
        await db.run(
            `UPDATE tournaments SET format = 'event', is_active = 0, event_finished_at = datetime('now') WHERE id = ?`,
            tournamentId,
        );
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

    it('W33: a designated tournament that is PAUSED still takes the score (pause only stops rotating)', async () => {
        const { tournamentId, gameId } = await createRotationGame(roomId, 'Bad Cats');
        await designate(roomId, tournamentId);
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET is_active = 0 WHERE id = ?`, tournamentId);
        await createRotationGame(roomId, 'Bad Cats'); // a same-named game elsewhere: the designation decides

        const res = await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery() });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const row = await db.get<{ game_id: string }>(
            `SELECT game_id FROM score_history ORDER BY id DESC LIMIT 1`,
        );
        expect(row!.game_id).toBe(gameId);
    });

    it('does not record the same global score twice; a repeat inside the window is told it landed (v2.167.1)', async () => {
        await seedCatalogue('Bad Cats', 'Williams', 1989);
        const q = scoreQuery();

        const first = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });
        const second = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...q });

        expect(first.body.status).toBe('global');
        expect(second.body.status).toBe('global');
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

    it('prefers the row whose name equals the launcher display name when maker and year still leave two (Scooby-Doo!, 09-30)', async () => {
        // Both are "Original 2022", so the parenthetical hint cannot split
        // them; the folder slug squashes to "scoobydoo" and so matched both.
        // The display name "Scooby-Doo!" normalises to "scooby-doo", which
        // only one of the rows shares.
        const hyphenated = await seedCatalogue('Scooby-Doo!', 'Original', 2022);
        await seedCatalogue('Scooby Doo', 'Original', 2022);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'Scooby-Doo! (Original 2022)', rom: 'Scooby Doo, 2022', slug: 'vpx-scoobydoo', score: 23282790 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(hyphenated);
    });

    it('prefers the display-name row over the one the rom matched (Halloween, 09-30)', async () => {
        const named = await seedCatalogue('Halloween (Original, 2023)', 'Original', 2023);
        await seedCatalogue('Halloween MM Edition', 'Original', 2023);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'Halloween (Original 2023)', rom: 'Halloween MM Edition', slug: 'vpx-halloweenmmedition', score: 10326850 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(named);
    });

    it('still refuses to guess between two rows that BOTH equal the display name (a true duplicate)', async () => {
        // The identity index forbids two rows with the same raw name, maker
        // and year, so a true duplicate differs only in punctuation — which
        // normalises away, leaving two rows the display name cannot split.
        await seedCatalogue('Scooby-Doo!', 'Original', 2022);
        await seedCatalogue('Scooby-Doo', 'Original', 2022);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'Scooby-Doo! (Original 2022)', rom: 'Scooby Doo, 2022', slug: 'vpx-scoobydoo' }),
        });
        expect(res.body).toMatchObject({ status: 'no_match' });
        // The reason names the rows it tied between, so the fix (a catalogue
        // merge) is readable off the player's own "Where your plays went".
        expect(res.body.notCounted).toBe(
            '"Scooby-Doo! (Original 2022)" matches 2 catalogue games: Scooby-Doo (Original 2022), Scooby-Doo! (Original 2022)',
        );
    });

    it('decodes a \\u0026 the launcher left in the table name before matching (Attack & Revenge from Mars, W113)', async () => {
        // LU's journal is Go JSON, which writes "&" as &; the cabinet
        // passed it on undecoded and every play missed the catalogue row.
        const game = await seedCatalogue('Attack & Revenge from Mars', 'Original', 2015);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({
                table: 'Attack \\u0026 Revenge from Mars (Original 2015)',
                rom: 'afm_113b', slug: 'vpx-attackandrevengefrommars', score: 1746620930,
            }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(game);
        // The trail keeps the name the player would recognise, not the escape.
        const trail = await db.get<{ table_name: string }>(
            `SELECT table_name FROM witness_evidence ORDER BY id DESC LIMIT 1`,
        );
        expect(trail!.table_name).toBe('Attack & Revenge from Mars (Original 2015)');
    });

    it('says "not in the catalogue" when only the folder slug matched and the launcher year contradicts every row (TRON Classic Neon, 11-17)', async () => {
        // The table sits in `vpx-tronclassic`, so the slug matched both
        // "TRON Classic" rows; the display name matched nothing ("TRON Neon"
        // is another name). Neither row is the 2024 table.
        await seedCatalogue('TRON Classic', 'Original', 2018);
        await seedCatalogue('Tron Classic', 'Original', 2022);
        await seedCatalogue('TRON Neon', 'Original', 2024);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'TRON Classic Neon (Original 2024)', rom: 'panther7', slug: 'vpx-tronclassic', score: 115810 }),
        });

        expect(res.body).toMatchObject({ status: 'no_match' });
        expect(res.body.notCounted).toBe('"TRON Classic Neon (Original 2024)" is not in the Arcaid catalogue');
        const db = await getDatabase();
        const count = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores`);
        expect(count!.n).toBe(0);
    });

    it('keeps the tie, and names it, when one slug-matched row does not contradict the launcher year', async () => {
        // A row with no year is not contradicted, so this is still a real
        // tie: refused as before, never resolved by elimination.
        await seedCatalogue('TRON Classic', 'Original', 2018);
        await seedCatalogue('Tron Classic', null, null);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'TRON Classic Neon (Original 2024)', rom: 'panther7', slug: 'vpx-tronclassic', score: 115810 }),
        });

        expect(res.body).toMatchObject({ status: 'no_match' });
        expect(res.body.notCounted).toBe(
            '"TRON Classic Neon (Original 2024)" matches 2 catalogue games: TRON Classic (Original 2018), Tron Classic',
        );
    });

    it('still lands a single slug-matched row whose year differs from the launcher name', async () => {
        // The contradiction rule only relabels a refusal; one candidate is
        // one candidate, exactly as before.
        const only = await seedCatalogue('TRON Classic', 'Original', 2018);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'TRON Classic Neon (Original 2024)', rom: 'panther7', slug: 'vpx-tronclassic', score: 115810 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(only);
    });

    it('W114: reads a launcher name in library sort form ("Spider-Man, JP\'s") as the catalogue\'s "JP\'s Spider-Man"', async () => {
        // ChalataLove, 2026-11-18: the folder slug matched only the stock
        // Spider-Man rows, whose years contradict 2018, so the play was refused
        // as "not in the Arcaid catalogue" although "JP's Spider-Man" is there.
        const jps = await seedCatalogue("JP's Spider-Man", 'Original', 2018);
        await seedCatalogue('Spider-Man', 'Stern', 2007);
        await seedCatalogue('Spider-Man', 'Zen Studios', 2010);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: "Spider-Man, JP's (Original 2018)", rom: 'smanve_101', slug: 'vpx-spiderman', score: 41675530 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(jps);
    });

    it('W114: the display-name tier compares the front form of a ", The" name when maker and year leave two', async () => {
        // Both rows are Bally 1998: "Champ Pub" through the folder slug
        // (`champpub`), "The Champion Pub" through the display name's front
        // form. Only the front form equals a row's name, so it breaks the tie.
        const pub = await seedCatalogue('The Champion Pub', 'Bally', 1998);
        await seedCatalogue('Champ Pub', 'Bally', 1998);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'Champion Pub, The (Bally 1998)', rom: 'cp_16', slug: 'vpx-champpub', score: 12345670 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(pub);
    });

    it('W114: a row named exactly as the launcher writes it still wins over the front form', async () => {
        // The catalogue keeps older Wizard rows under LU's own sort-form
        // names. A play of one landed there before W114 and must land there
        // still: the name as written is tried before its front form.
        const asWritten = await seedCatalogue('Addams Family, The (Bally 1992)', 'Bally', 1992);
        await seedCatalogue('The Addams Family', 'Bally', 1992);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'Addams Family, The (Bally 1992)', rom: 'taf_l7', slug: 'vpx-taf', score: 98765430 }),
        });

        expect(res.body).toMatchObject({ status: 'global' });
        const db = await getDatabase();
        const row = await db.get<{ global_game_id: string }>(
            `SELECT global_game_id FROM global_scores ORDER BY rowid DESC LIMIT 1`,
        );
        expect(row!.global_game_id).toBe(asWritten);
    });

    it('W114: a comma tail that is not just an article is left as written ("X Files, The Hannibal Mod")', async () => {
        // No rom: the real record's `xfiles` squashes to the row's own name and
        // would land it on its own, which is not what this case is about.
        await seedCatalogue('The X Files', 'Sega', 1997);

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: 'X Files, The Hannibal Mod (Sega 1997)', rom: '', slug: 'vpx-xfileshanibal', score: 5550000 }),
        });

        expect(res.body).toMatchObject({ status: 'no_match' });
        expect(res.body.notCounted).toBe('"X Files, The Hannibal Mod (Sega 1997)" is not in the Arcaid catalogue');
    });

    it('W114: a room game named in front form takes a launcher play named in sort form', async () => {
        const { gameId } = await createRotationGame(roomId, "JP's Spider-Man");

        const res = await request(app).get('/api/witness/score').query({
            device: DEVICE, token,
            ...scoreQuery({ table: "Spider-Man, JP's (Original 2018)", rom: 'smanve_101', slug: 'vpx-spiderman', score: 41675530 }),
        });

        expect(res.body).toMatchObject({ status: 'ingested' });
        const db = await getDatabase();
        expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeTruthy();
    });

    describe('W110: the Wizard install folder resolves before any name', () => {
        /** The catalogue the James Bond plays met on 2026-11-19: two rows of the name, the table under another. */
        async function seedBond() {
            await seedCatalogue('James Bond 007', 'Gottlieb', 1980, 'jb1980vp');
            await seedCatalogue('James Bond 007 (Stern 2022)', 'Stern', 2022);
            return seedCatalogue('Bond 60th', 'Original', 2022, 'bwggWE8UrF');
        }
        const bondPlay = (over: Record<string, unknown> = {}) => scoreQuery({
            table: 'James Bond 007 (Original 2022)', rom: '', slug: 'vpx-jamesbond007', score: 174368670, ...over,
        });

        it('lands on the VPS row the manifest names although the names tie (James Bond 007, vpx-jamesbond007)', async () => {
            const bond = await seedBond();

            // An empty map (before the first Wizard sync) is exactly the name match: a tie.
            const before = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...bondPlay() });
            expect(before.body).toMatchObject({ status: 'no_match' });
            expect(before.body.notCounted).toMatch(/matches 2 catalogue games: James Bond 007 \(Gottlieb 1980\), James Bond 007 \(Stern 2022\)/);

            await mapWizardFolder('vpx-jamesbond007', 'bwggWE8UrF');
            const after = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...bondPlay({ score: 174368680 }) });
            expect(after.body).toMatchObject({ status: 'global', game: 'Bond 60th' });
            expect(await latestGlobalGameId()).toBe(bond);
        });

        it('an unknown folder behaves exactly as before: a hand-installed vpx-alijp still ties, the manifest\'s vpx-jpali lands', async () => {
            const ali = await seedCatalogue('Ali', 'Stern', 1980, 'z9BMLCAY');
            await seedCatalogue("Ali (JP's, Stern 1980)", 'Stern', 1980);
            await mapWizardFolder('vpx-jpali', 'z9BMLCAY');

            const handInstalled = await request(app).get('/api/witness/score').query({
                device: DEVICE, token, ...scoreQuery({ table: 'Ali (Stern 1980)', rom: 'ali', slug: 'vpx-alijp', score: 400000 }),
            });
            expect(handInstalled.body).toMatchObject({ status: 'no_match' });
            expect(handInstalled.body.notCounted).toMatch(/matches 2 catalogue games/);
            const db = await getDatabase();
            expect(await db.get(`SELECT id FROM global_scores`)).toBeUndefined();

            const wizard = await request(app).get('/api/witness/score').query({
                device: DEVICE, token, ...scoreQuery({ table: 'Ali (Stern 1980)', rom: 'ali', slug: 'vpx-jpali', score: 400010 }),
            });
            expect(wizard.body).toMatchObject({ status: 'global', game: 'Ali' });
            expect(await latestGlobalGameId()).toBe(ali);
        });

        it('a room game named the VPS way takes the play, on the score call and the attempt call (Getaway: Baby Driver Edition)', async () => {
            await seedCatalogue('The Getaway - High Speed II', 'Williams', 1992, 'cCV4A6uc');
            const { gameId } = await createRotationGame(roomId, 'The Getaway - High Speed II');
            const play = (score: number) => scoreQuery({
                table: 'Getaway: Baby Driver Edition (Williams 1992)', rom: 'gw_l5', slug: 'vpx-getawaypup', score,
            });

            // No name the cabinet sends is the room's: without the map the play misses the room.
            const before = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...play(5123450) });
            expect(before.body.status).not.toBe('ingested');
            const db = await getDatabase();
            expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();

            await mapWizardFolder('vpx-getawaypup', 'cCV4A6uc');
            const after = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...play(5123460) });
            expect(after.body).toMatchObject({ status: 'ingested', game: 'The Getaway - High Speed II' });
            expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeTruthy();

            // The attempt call shares `match`, so a start resolves through the folder too.
            const started = Math.floor(Date.now() / 1000) - 60;
            const attempt = await request(app).get('/api/witness/attempt').query({
                device: DEVICE, token, table: 'Getaway: Baby Driver Edition (Williams 1992)', slug: 'vpx-getawaypup',
                started, key: `cab:${started}`,
            });
            expect(attempt.body).toMatchObject({ ok: true, status: 'unlimited', game: 'The Getaway - High Speed II' });
        });

        it('is matching only: a cabinet landing by its folder gets no verdict and stores no VPS id as evidence', async () => {
            await seedBond();
            await mapWizardFolder('vpx-jamesbond007', 'bwggWE8UrF');
            const { gameId } = await createRotationGame(roomId, 'Bond 60th');

            const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...bondPlay() });
            expect(res.body).toMatchObject({ status: 'ingested', game: 'Bond 60th' });
            const db = await getDatabase();
            expect(await db.get(`SELECT outcome, verdict, vps_game, integrity_mode FROM witness_evidence WHERE game_id = ?`, gameId))
                .toEqual({ outcome: 'ingested', verdict: null, vps_game: null, integrity_mode: 'open' });
        });

        it('is matching only: a Sanctioned tournament still holds a cabinet out, folder or not', async () => {
            await seedBond();
            await mapWizardFolder('vpx-jamesbond007', 'bwggWE8UrF');
            const db = await getDatabase();
            const tournamentId = crypto.randomUUID();
            await db.run(
                `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, integrity_mode)
                 VALUES (?, 'Sanctioned VPXS', 'WG', 'pinball', '{}', 1, ?, 'rotation', 'sanctioned')`,
                tournamentId, roomId,
            );
            const gameId = crypto.randomUUID();
            await db.run(
                `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
                 VALUES (?, ?, 'Bond 60th', 'ACTIVE', ?, ?)`,
                gameId, tournamentId, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
            );

            const res = await request(app).get('/api/witness/score').query({ device: DEVICE, token, ...bondPlay() });
            // The cabinet's own vocabulary for "accepted, not placed"; the play still reaches Global.
            expect(res.body).toMatchObject({ ok: true, status: 'no_match', game: 'Bond 60th' });
            expect(await db.get(`SELECT id FROM score_history WHERE game_id = ?`, gameId)).toBeUndefined();
            const trail = await db.get<{ outcome: string; reasons: string; vps_game: string | null }>(
                `SELECT outcome, reasons, vps_game FROM witness_evidence WHERE tournament_id = ?`, tournamentId,
            );
            expect(trail!.outcome).toBe('not_sanctioned');
            expect(JSON.parse(trail!.reasons)[0]).toMatch(/no evidence/);
            expect(trail!.vps_game).toBeNull();
        });

        it('a desktop\'s slug is never read as a Wizard folder (Castcade sends the ROM\'s catalogue name there)', async () => {
            await seedBond();
            await mapWizardFolder('vpx-jamesbond007', 'bwggWE8UrF');
            const desktop = 'f1d2e3c4-0000-4000-8000-00000000d35c';
            const codeRes = await request(app)
                .post('/api/me/witness/pairing-code')
                .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
            const desktopToken = (await request(app).get('/api/witness/pair')
                .query({ code: codeRes.body.code, device: desktop, username: 'Desk', type: 'desktop' })).body.token as string;

            const res = await request(app).get('/api/witness/score').query({ device: desktop, token: desktopToken, ...bondPlay() });
            expect(res.body).toMatchObject({ status: 'no_match' });
            expect(res.body.notCounted).toMatch(/matches 2 catalogue games/);
        });
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

    it('tags a retro-reported score on the observation it files', async () => {
        // Round 5 shipped a tester's whole back catalogue tagged 'live' — a
        // claim we had not earned. The device now marks anything older than its
        // live grace as retro, and that tag has to survive into the evidence.
        await createRotationGame(roomId, 'Bad Cats');
        await designate(roomId);

        await request(app).get('/api/witness/score')
            .query({ device: DEVICE, token, ...scoreQuery(), via: 'retro' });

        const db = await getDatabase();
        const obs = await db.get<{ via: string }>(
            `SELECT via FROM witness_observations ORDER BY id DESC LIMIT 1`,
        );
        expect(obs!.via).toBe('retro');
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
