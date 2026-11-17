import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * W106 — one Witness play, one Global Scoreboard row.
 *
 * Prod 2026-11-16: one table was open in a Limited-attempts tournament and in
 * a rotation. Once the attempts ran out the limited tournament refused each
 * play and sent it to the Global Scoreboard (a Global-origin row), and then
 * the rotation landed the same play and fanned out a second row for it.
 *
 *   1. A play one board refuses and another takes has ONE `global_scores`
 *      row, the fan-out of the board it landed on. The refusal's trail row
 *      points at no Global row (it did not fall through to Global).
 *   2. The same holds when the taking board is processed FIRST or LAST.
 *   3. A play NO board takes still falls through to Global (unchanged).
 *   4. A player who shares nothing to Global gets no Global row from a
 *      refusal either, once a board took the play.
 */

const USER = '123456789012345678';
const CABINET = 'fp-device-uuid-w106';
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

async function pairCabinet(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: CABINET, username: 'Owner' });
    return pairRes.body.token as string;
}

async function addMember(roomId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
}

async function createGame(roomId: string, maxAttempts: number | null, name = 'Bad Cats') {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts)
         VALUES (?, ?, 'WG', 'pinball', '{}', 1, ?, 'rotation', ?)`,
        tournamentId, maxAttempts ? 'Limited' : 'Weekly', roomId, maxAttempts,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

/** A play; `n` keeps every play's score and times distinct. All inside the games' window. */
const T0 = Date.now();
function play(n: number) {
    const endedMs = T0 - (10 - n) * 2 * MINUTE;
    return {
        table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
        score: 1_000_000 + n * 1_110,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over',
    };
}

type GlobalRow = { id: string; origin_type: string; origin_game_room_id: string | null; score: number };
async function globalRows(score: number): Promise<GlobalRow[]> {
    const db = await getDatabase();
    return db.all<GlobalRow[]>(
        `SELECT id, origin_type, origin_game_room_id, score FROM global_scores WHERE score = ? ORDER BY rowid`, score,
    );
}

type TrailRow = { outcome: string; game_id: string | null; global_score_id: string | null };
async function trailRows(score: number): Promise<TrailRow[]> {
    const db = await getDatabase();
    return db.all<TrailRow[]>(
        `SELECT outcome, game_id, global_score_id FROM witness_evidence WHERE score = ? ORDER BY id`, score,
    );
}

describe('W106 — one Witness play, one Global Scoreboard row', () => {
    let app: express.Express;
    let token: string;
    let limitedRoom: string;
    let openRoom: string;

    const send = (n: number) => request(app).get('/api/witness/score').query({ device: CABINET, token, ...play(n) });

    beforeEach(async () => {
        app = await createTestApp();
        token = await pairCabinet(app); // a new device sends to All my rooms
        limitedRoom = await createTestRoom('w106-limited', 'W106 Limited');
        openRoom = await createTestRoom('w106-open', 'W106 Open');
        await addMember(limitedRoom);
        await addMember(openRoom);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Bad Cats', 'pinball', 'Williams', 1989, 'approved')`,
            crypto.randomUUID(),
        );
    });

    it('refused by a limited tournament, taken by a rotation: one Global row, the rotation\'s fan-out', async () => {
        const limited = await createGame(limitedRoom, 1);
        const open = await createGame(openRoom, null);

        // Play 1 uses the one attempt and lands on both boards.
        const first = await send(1);
        expect(first.body).toMatchObject({ ok: true, status: 'ingested' });
        expect(first.body.landed.map((l: { status: string }) => l.status)).toEqual(['ingested', 'ingested']);

        // Play 2 is over the limit there, and still counts in the rotation.
        const second = await send(2);
        expect(second.body).toMatchObject({ ok: true, status: 'ingested' });
        expect(second.body.landed.map((l: { status: string }) => l.status).sort()).toEqual(['ingested', 'no_match']);

        const rows = await globalRows(play(2).score);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ origin_type: 'game_room', origin_game_room_id: openRoom });

        const trail = await trailRows(play(2).score);
        expect(trail).toHaveLength(2);
        const refused = trail.find(t => t.outcome === 'attempt_refused')!;
        const landed = trail.find(t => t.outcome === 'ingested')!;
        expect(refused).toMatchObject({ game_id: limited.gameId, global_score_id: null });
        expect(landed).toMatchObject({ game_id: open.gameId, global_score_id: rows[0]!.id });
    });

    it('the same when both tournaments are in ONE room', async () => {
        await createGame(openRoom, 1);
        await createGame(openRoom, null);
        await send(1);
        await send(2);
        const rows = await globalRows(play(2).score);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ origin_type: 'game_room', origin_game_room_id: openRoom });
    });

    it('a replay of that play writes nothing more', async () => {
        await createGame(limitedRoom, 1);
        await createGame(openRoom, null);
        await send(1);
        await send(2);
        const db = await getDatabase();
        // Outside the repeat window, as a cabinet restart days later would be.
        await db.run(`UPDATE global_scores SET submitted_at = '2020-01-01T00:00:00.000Z'`);
        await db.run(`UPDATE score_history SET created_at = '2020-01-01 00:00:00'`);
        await send(2);
        expect(await globalRows(play(2).score)).toHaveLength(1);
    });

    it('refused with NO other board to take it: still falls through to Global', async () => {
        const limited = await createGame(limitedRoom, 1);
        await send(1);
        const second = await send(2);
        expect(second.body).toMatchObject({ ok: true, status: 'no_match' }); // a cabinet's word for a refusal

        const rows = await globalRows(play(2).score);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ origin_type: 'global', origin_game_room_id: null });
        const trail = await trailRows(play(2).score);
        expect(trail).toEqual([
            { outcome: 'attempt_refused', game_id: limited.gameId, global_score_id: rows[0]!.id },
        ]);
    });

    describe('migration 217 removes the twins already stored', () => {
        const GAME = 'gg-w106';
        const AT = '2026-11-16T05:27:12.857Z';
        let n = 0;

        async function row(over: Record<string, unknown>) {
            const db = await getDatabase();
            const r = {
                id: `gs-${++n}`, global_game_id: GAME, player_id: USER, score: 12620,
                origin_type: 'global', origin_game_room_id: null as string | null, origin_game_id: null as string | null,
                submitted_during_tournament_id: null as string | null, exclude_from_global: 0,
                submitted_at: AT, source: 'vpx', deleted_at: null as string | null, ...over,
            };
            await db.run(
                `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type,
                    origin_game_room_id, origin_game_id, submitted_during_tournament_id, exclude_from_global,
                    submitted_at, source, deleted_at, engine, device)
                 VALUES (?, ?, ?, 'Owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vpx', 'atgames')`,
                r.id, r.global_game_id, r.player_id, r.score, r.origin_type, r.origin_game_room_id, r.origin_game_id,
                r.submitted_during_tournament_id, r.exclude_from_global, r.submitted_at, r.source, r.deleted_at,
            );
            return r.id;
        }
        const keeper = (over: Record<string, unknown> = {}) => row({
            origin_type: 'game_room', origin_game_room_id: openRoom, submitted_during_tournament_id: 't-rotation',
            submitted_at: '2026-11-16T05:27:12.898Z', ...over,
        });
        async function ids() {
            const db = await getDatabase();
            return (await db.all<Array<{ id: string }>>(`SELECT id FROM global_scores ORDER BY id`)).map(r => r.id);
        }

        beforeEach(async () => {
            n = 0;
            const db = await getDatabase();
            await db.run(
                `INSERT INTO global_games (id, name, type, status) VALUES (?, 'Beastie Boys', 'pinball', 'approved')`, GAME,
            );
        });

        it('removes the fall-through twin, keeps the room row, unpoints the trail, and is idempotent', async () => {
            const { removeWitnessGlobalTwins } = await import('../database/migrations/witnessGlobalTwins.js');
            const db = await getDatabase();
            const twin = await row({});
            const kept = await keeper();
            await db.run(
                `INSERT INTO witness_evidence (device_id, canonical_user_id, outcome, table_name, score, played_at, global_score_id)
                 VALUES (?, ?, 'attempt_refused', 'Beastie Boys', 12620, '2026-11-16 05:20:00', ?)`,
                CABINET, USER, twin,
            );
            await db.run(
                `INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at) VALUES (?, 'global', '[]', ?)`,
                GAME, AT,
            );

            expect(await removeWitnessGlobalTwins(db)).toBe(1);
            expect(await ids()).toEqual([kept]);
            const trail = await db.get<{ global_score_id: string | null }>(`SELECT global_score_id FROM witness_evidence`);
            expect(trail!.global_score_id).toBeNull();
            expect((await db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM global_leaderboard_cache`))!.c).toBe(0);
            expect(await removeWitnessGlobalTwins(db)).toBe(0);
        });

        it('leaves alone everything that is not an exact twin', async () => {
            const { removeWitnessGlobalTwins } = await import('../database/migrations/witnessGlobalTwins.js');
            const db = await getDatabase();
            const kept = [
                // A Global-only play with no room row at all.
                await row({ score: 1 }),
                // The same score on Global days before it landed in a room.
                await row({ score: 2, submitted_at: '2026-11-10T05:27:12.857Z' }), await keeper({ score: 2 }),
                // A Throwdown landing: Global-origin, but it carries its tournament.
                await row({ score: 3, submitted_during_tournament_id: 't-throwdown' }), await keeper({ score: 3 }),
                // The player deleted the Global-origin row.
                await row({ score: 4, deleted_at: AT }), await keeper({ score: 4 }),
                // The room row is deleted, so the Global-origin row is the only live copy.
                await row({ score: 5 }), await keeper({ score: 5, deleted_at: AT }),
                // The player hid one of the two.
                await row({ score: 6, exclude_from_global: 1 }), await keeper({ score: 6 }),
                // Another player's room row.
                await row({ score: 7 }), await keeper({ score: 7, player_id: '999999999999999999' }),
                // A typed Global entry (not a Witness row).
                await row({ score: 8, source: null }), await keeper({ score: 8 }),
                // Somebody reported the Global-origin row.
                await row({ score: 9 }), await keeper({ score: 9 }),
            ];
            await db.run(
                `INSERT INTO score_reports (id, score_id, reporter_discord_id, score_source) VALUES ('r1', ?, ?, 'global')`,
                kept[kept.length - 2], USER,
            );
            expect(await removeWitnessGlobalTwins(db)).toBe(0);
            expect(await ids()).toEqual([...kept].sort());
        });
    });

    it('a player who shares nothing to Global gets no Global row from the refusal once a board took the play', async () => {
        await createGame(limitedRoom, 1);
        const open = await createGame(openRoom, null);
        const { PreferencesService } = await import('../services/PreferencesService.js');
        await PreferencesService.setShareToGlobal(USER, false);
        await send(1);
        await send(2);
        expect(await globalRows(play(2).score)).toHaveLength(0);
        const db = await getDatabase();
        const board = await db.all(`SELECT id FROM score_history WHERE game_id = ? AND score = ?`, open.gameId, play(2).score);
        expect(board).toHaveLength(1);
    });
});
