import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * W22 (v2.190.0) — the witness verdict reaches the room board and the game page.
 *
 * WWS test event, 2026-10-23: TomatoGrass geared up on purpose (table launched
 * before round 1 opened). The event page, under `witness_flag_mode = 'prevent'`
 * (ADR 0031), left the score out of the round standings — but the ROOM
 * SCOREBOARD card for that round and the GAME PAGE still showed it first, and
 * as the all-time high, with no mark. Those are the surfaces players reach.
 *
 * What these tests pin, worst-bug-first:
 *   1. Under 'prevent' the room board and the game page rank the round EXACTLY
 *      as `EventResultService.getRoundBoard` does (the one computation of a
 *      round's standings), and the flagged score rides `notCounted`.
 *   2. Under 'flag' every row stays and carries its verdict.
 *   3. `leaderboard_cache` is untouched — a verdict is never baked in.
 *   4. A rotation game in the same room is unchanged (no `witness`, no
 *      `notCounted`).
 *   5. The game page's all-time high leaves out the prevented score.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { EventResultService } = await import('../services/EventResultService.js');
const { LeaderboardService } = await import('../services/LeaderboardService.js');

const MINUTE = 60_000;
const BASE = Date.parse('2026-09-01T20:00:00.000Z');
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const GAME = 'Medieval Madness';

/** SQLite's own UTC shape — what the witness ingest stores in `created_at`. */
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

/** A `source='vpx'` score plus the game observation the witness filed for it. */
async function witnessedScore(opts: {
    roomId: string; tournamentId: string; gameId: string;
    username: string; userId: string; score: number; launchMs: number; exitMs: number;
}): Promise<number> {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
            platform, engine, device, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'vpx', ?, ?, ?, 'vpxs', 'vpx', 'atgames', ?)`,
        GAME, opts.roomId, opts.gameId, opts.username, opts.userId, opts.score,
        opts.roomId, opts.tournamentId, opts.userId, sqliteTs(opts.exitMs),
    );
    const launch = Math.floor(opts.launchMs / 1000);
    const exit = Math.floor(opts.exitMs / 1000);
    await db.run(
        `INSERT INTO witness_observations
            (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind)
         VALUES (?, ?, 'mm_109c', ?, ?, ?, 'live', 'game')`,
        `dev-${opts.userId}`, opts.userId, launch, exit, exit - launch,
    );
    return res.lastID as number;
}

interface Fixture {
    roomId: string;
    tournamentId: string;
    roundId: string;
    rotationGameId: string;
    aFlagged: number;
    aVerified: number;
    bVerified: number;
}

async function makeFixture(): Promise<Fixture> {
    const db = await getDatabase();
    const roomId = await createTestRoom(`w22-${crypto.randomUUID().slice(0, 8)}`);
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, witness_flag_mode)
         VALUES (?, 'WWS Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 'prevent')`,
        tournamentId, roomId,
    );
    const rounds = await EventService.createOrUpdateEvent(tournamentId, {
        rounds: [{
            roundNo: 1,
            gameName: GAME,
            scheduledStartAt: new Date(BASE).toISOString(),
            scheduledEndAt: new Date(BASE + 30 * MINUTE).toISOString(),
        }],
        checkinRequired: false,
    });
    const roundId = rounds[0]!.id;
    // The round is live: an open card on the room board.
    await db.run(`UPDATE games SET status = 'ACTIVE', start_date = ? WHERE id = ?`, sqliteTs(BASE), roundId);

    // A: geared up (launched 5 min BEFORE the round) for 900, then a clean 500.
    const aFlagged = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'TomatoGrass', userId: USER_A,
        score: 900, launchMs: BASE - 5 * MINUTE, exitMs: BASE + 10 * MINUTE,
    });
    const aVerified = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'TomatoGrass', userId: USER_A,
        score: 500, launchMs: BASE + 16 * MINUTE, exitMs: BASE + 20 * MINUTE,
    });
    // B: one clean 700, between A's two.
    const bVerified = await witnessedScore({
        roomId, tournamentId, gameId: roundId, username: 'Bee', userId: USER_B,
        score: 700, launchMs: BASE + 8 * MINUTE, exitMs: BASE + 12 * MINUTE,
    });

    // A rotation game in the same room, with an ordinary typed score.
    const rotationId = await createTestTournament(roomId, { name: 'Weekly' });
    const rotationGameId = await createTestGame(rotationId, { name: 'Attack from Mars', startDate: sqliteTs(BASE - 60 * MINUTE) });
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, iscored_username, discord_user_id, score, source,
            submitted_during_tournament_id, submitted_by_user_id, platform, engine, device, created_at
         ) VALUES ('Attack from Mars', ?, 'Bee', ?, 4242, 'tournament', ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        roomId, USER_B, rotationId, USER_B, sqliteTs(BASE),
    );

    return { roomId, tournamentId, roundId, rotationGameId, aFlagged, aVerified, bVerified };
}

async function roundBoard(f: Fixture) {
    const event = (await EventService.getEvent(f.tournamentId))!;
    const round = (await EventService.getRounds(f.tournamentId))[0]!;
    return EventResultService.getRoundBoard(event, round);
}

async function cacheSnapshot(): Promise<Array<{ game_id: string; rankings: string }>> {
    const db = await getDatabase();
    return db.all(`SELECT game_id, rankings FROM leaderboard_cache ORDER BY game_id`);
}

describe('W22 — witness verdicts on the room board and the game page', () => {
    let app: express.Express;
    let f: Fixture;

    beforeEach(async () => {
        await setupTestDb();
        app = await createTestApp();
        f = await makeFixture();
    });

    it('prevent: the game page ranks the round exactly as getRoundBoard does, flagged score in notCounted', async () => {
        const res = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}`);
        expect(res.status).toBe(200);

        const ids = res.body.rankings.map((r: any) => r.history_id);
        expect(ids).toEqual([f.bVerified, f.aVerified]);
        expect(res.body.rankings.map((r: any) => r.score)).toEqual([700, 500]);
        expect(res.body.rankings.map((r: any) => r.rank)).toEqual([1, 2]);
        expect(res.body.rankings.every((r: any) => r.witness?.status === 'verified')).toBe(true);

        expect(res.body.notCounted).toHaveLength(1);
        expect(res.body.notCounted[0]).toMatchObject({
            history_id: f.aFlagged, score: 900, iscored_username: 'TomatoGrass',
            witness: { status: 'flagged', method: 'session' },
        });
        expect(res.body.witnessFlagMode).toBe('prevent');
        // Every score of the round is in the verdict map — including A's
        // flagged one, which is nobody's ranked row (the history expand reads it).
        expect(res.body.witnessByHistoryId[String(f.aFlagged)].status).toBe('flagged');
        expect(res.body.witnessByHistoryId[String(f.aVerified)].status).toBe('verified');

        // The equality the whole design rests on.
        const board = await roundBoard(f);
        expect(ids).toEqual(board.scores.map(s => s.history_id));
        expect(res.body.notCounted.map((r: any) => r.history_id))
            .toEqual(board.notCounted.map(s => s.history_id));
    });

    it('prevent: the room board card for the round behaves the same', async () => {
        const boards = await LeaderboardService.getActiveLeaderboards(f.roomId) as any[];
        const card = boards.find(b => b.gameId === f.roundId);
        expect(card).toBeTruthy();
        expect(card.rankings.map((r: any) => r.history_id)).toEqual([f.bVerified, f.aVerified]);
        expect(card.notCounted.map((r: any) => r.history_id)).toEqual([f.aFlagged]);
        expect(card.notCounted[0].witness.status).toBe('flagged');

        const board = await roundBoard(f);
        expect(card.rankings.map((r: any) => r.history_id)).toEqual(board.scores.map(s => s.history_id));
        // Names resolve at read time like any other board row.
        expect(card.rankings[0].iscored_username).toBe('Bee');
    });

    it('flag: every row stays and carries its verdict, the flagged one first', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET witness_flag_mode = 'flag' WHERE id = ?`, f.tournamentId);

        const res = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}`);
        expect(res.body.rankings.map((r: any) => r.history_id)).toEqual([f.aFlagged, f.bVerified]);
        expect(res.body.rankings[0].witness.status).toBe('flagged');
        expect(res.body.rankings[1].witness.status).toBe('verified');
        expect(res.body.notCounted).toEqual([]);
        expect(res.body.witnessFlagMode).toBe('flag');

        const board = await roundBoard(f);
        expect(res.body.rankings.map((r: any) => r.history_id)).toEqual(board.scores.map(s => s.history_id));

        const boards = await LeaderboardService.getActiveLeaderboards(f.roomId) as any[];
        const card = boards.find(b => b.gameId === f.roundId);
        expect(card.rankings.map((r: any) => r.history_id)).toEqual([f.aFlagged, f.bVerified]);
        expect(card.rankings[0].witness.status).toBe('flagged');
    });

    it('a rotation game in the same room is unchanged — no witness, no notCounted', async () => {
        const boards = await LeaderboardService.getActiveLeaderboards(f.roomId) as any[];
        const card = boards.find(b => b.gameId === f.rotationGameId);
        expect(card).toBeTruthy();
        expect(card.rankings).toHaveLength(1);
        expect(card.rankings[0].score).toBe(4242);
        expect('witness' in card.rankings[0]).toBe(false);
        expect('notCounted' in card).toBe(false);
        expect('witnessByHistoryId' in card).toBe(false);

        const res = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.rotationGameId}`);
        expect(res.body.rankings).toHaveLength(1);
        expect(res.body.rankings[0].witness).toBeUndefined();
        expect(res.body.notCounted).toBeUndefined();
    });

    it('leaderboard_cache is untouched by the verdict reads', async () => {
        // Prime the cache through the ordinary path, then snapshot it.
        await LeaderboardService.getActiveLeaderboards(f.roomId);
        const before = await cacheSnapshot();
        const roundBlob = before.find(r => r.game_id === f.roundId);
        expect(roundBlob).toBeTruthy();
        // The cache still holds the raw identity-stable ranking (A's 900 first)
        // and never a verdict.
        expect(roundBlob!.rankings).not.toContain('witness');
        expect(JSON.parse(roundBlob!.rankings).rows[0].score).toBe(900);

        await LeaderboardService.getActiveLeaderboards(f.roomId);
        await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}`);
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET witness_flag_mode = 'flag' WHERE id = ?`, f.tournamentId);
        await LeaderboardService.getActiveLeaderboards(f.roomId);

        expect(await cacheSnapshot()).toEqual(before);
    });

    it('an engine tab on the game page filters the round board, never re-adds the flagged score', async () => {
        const res = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}?engine=vpx`);
        expect(res.body.rankings.map((r: any) => r.history_id)).toEqual([f.bVerified, f.aVerified]);
        expect(res.body.notCounted.map((r: any) => r.history_id)).toEqual([f.aFlagged]);

        const none = await request(app).get(`/api/rooms/${f.roomId}/leaderboard/${f.roundId}?engine=fx`);
        expect(none.body.rankings).toEqual([]);
        expect(none.body.notCounted).toEqual([]);
    });

    it('the game page all-time high leaves out a prevented score, and keeps it under flag', async () => {
        const res = await request(app).get(`/api/rooms/${f.roomId}/stats/game/${encodeURIComponent(GAME)}`);
        expect(res.status).toBe(200);
        expect(res.body.allTimeHigh).toBe(700);
        expect(res.body.allTimeHighPlayer).toBe('Bee');

        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET witness_flag_mode = 'flag' WHERE id = ?`, f.tournamentId);
        const flagged = await request(app).get(`/api/rooms/${f.roomId}/stats/game/${encodeURIComponent(GAME)}`);
        expect(flagged.body.allTimeHigh).toBe(900);
        expect(flagged.body.allTimeHighPlayer).toBe('TomatoGrass');
    });
});
