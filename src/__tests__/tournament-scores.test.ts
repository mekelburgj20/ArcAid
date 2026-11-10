import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame,
} from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * `GET /api/rooms/:roomId/tournaments/:tournamentId/scores` — the per-tournament
 * score-board endpoint behind `/:slug/tournaments/:id` (v2.76).
 *
 * Every fixture row here is written in the shape production actually stores:
 * `game_name` + `game_room_id` + `submitted_during_tournament_id` populated,
 * **`game_id` NULL**. That is not a stylistic choice — verified 2026-08-02,
 * prod has zero non-NULL `game_id` rows table-wide, because the dominant web
 * submit path never sets one and every unpin/delete/cleanup path NULLs it
 * (ADR 0005). A reader that joins `games` on `sh.game_id` therefore matches
 * nothing in prod while passing happily against a `games`-derived fixture —
 * exactly how `getPersonalBests` shipped empty in v2.74.0. Pattern copied from
 * `s13-achievements.test.ts`'s `insertHistoryScore`.
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);

    return app;
}

async function insertHistoryScore(opts: {
    gameRoomId: string;
    gameName: string;
    username: string;
    score: number;
    tournamentId?: string | null;
    submittedByUserId?: string | null;
    discordUserId?: string | null;
    createdAt?: string;
    orphanedAt?: string | null;
    source?: 'tournament' | 'community' | 'sync';
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id,
            submitted_by_user_id, score, source, submitted_from_room_id,
            submitted_during_tournament_id, orphaned_at, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.username,
        opts.discordUserId ?? 'SYSTEM', opts.submittedByUserId ?? null,
        opts.score, opts.source ?? 'tournament', opts.gameRoomId,
        opts.tournamentId ?? null, opts.orphanedAt ?? null,
        opts.createdAt ?? new Date().toISOString(),
    );
}

describe('GET /api/rooms/:roomId/tournaments/:tournamentId/scores', () => {
    it('groups boards by game name and ranks best-per-player within each', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId, { name: 'Daily Grind', type: 'DG' });
        await createTestGame(tId, {
            name: 'WHO dunnit', status: 'COMPLETED',
            startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-02T00:00:00.000Z',
        });
        await createTestGame(tId, {
            name: 'Medieval Madness', status: 'COMPLETED',
            startDate: '2026-01-03T00:00:00.000Z', endDate: '2026-01-04T00:00:00.000Z',
        });

        // Casing drift on purpose — boards key on LOWER(game_name).
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'WHO dunnit', username: 'Ann', score: 100, tournamentId: tId, createdAt: '2026-01-01T01:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'who dunnit', username: 'Ann', score: 300, tournamentId: tId, createdAt: '2026-01-01T02:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'WHO dunnit', username: 'Bob', score: 200, tournamentId: tId, createdAt: '2026-01-01T03:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Medieval Madness', username: 'Cid', score: 50, tournamentId: tId, createdAt: '2026-01-03T01:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        expect(res.status).toBe(200);
        expect(res.body.tournament).toMatchObject({
            id: tId, name: 'Daily Grind', type: 'DG', is_active: true,
            first_start: '2026-01-01T00:00:00.000Z', last_end: '2026-01-04T00:00:00.000Z',
        });

        // Most recent slot end_date first.
        expect(res.body.boards.map((b: any) => b.game_key)).toEqual(['medieval madness', 'who dunnit']);

        const who = res.body.boards.find((b: any) => b.game_key === 'who dunnit');
        expect(who.slot_count).toBe(1);
        expect(who.end_date).toBe('2026-01-02T00:00:00.000Z');
        // Ann's 100 collapses into her 300 — one row per player, best kept.
        expect(who.scores).toHaveLength(2);
        expect(who.scores.map((s: any) => [s.rank, s.iscored_username, s.score]))
            .toEqual([[1, 'Ann', 300], [2, 'Bob', 200]]);
    });

    it('assigns tied scores the same rank and skips the next (competition ranking)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Tie Game', status: 'COMPLETED', endDate: '2026-02-01T00:00:00.000Z' });

        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Tie Game', username: 'Ann', score: 500, tournamentId: tId, createdAt: '2026-01-05T01:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Tie Game', username: 'Bob', score: 500, tournamentId: tId, createdAt: '2026-01-05T02:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Tie Game', username: 'Cid', score: 100, tournamentId: tId, createdAt: '2026-01-05T03:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        expect(res.status).toBe(200);
        const board = res.body.boards[0];
        expect(board.scores.map((s: any) => [s.rank, s.iscored_username])).toEqual([
            [1, 'Ann'], [1, 'Bob'], [3, 'Cid'],
        ]);
        // Winner is the board's own rank-1 row — earliest of the tied pair.
        expect(board.winner.iscored_username).toBe('Ann');
        expect(board.winner.score).toBe(500);
    });

    it('collapses two mapped aliases of one Discord user into a single row', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Alias Game', status: 'COMPLETED', endDate: '2026-03-01T00:00:00.000Z' });

        const db = await getDatabase();
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-1', 'Ace')`);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-1', 'AceAlt')`);
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('disc-1', 'The Ace')`,
        );

        // `iscored:<name>` is the real shape a synced score carries when the
        // alias wasn't mapped yet (ScoreSyncPoller). A later `/map-user` links
        // it, and BOTH the identity partition and the display join pick it up
        // at read time — no backfill of historical rows.
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Alias Game', username: 'Ace', score: 400, tournamentId: tId, discordUserId: 'iscored:Ace', source: 'sync', createdAt: '2026-02-01T01:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Alias Game', username: 'AceAlt', score: 900, tournamentId: tId, discordUserId: 'iscored:AceAlt', source: 'sync', createdAt: '2026-02-01T02:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Alias Game', username: 'Zed', score: 600, tournamentId: tId, discordUserId: 'iscored:Zed', source: 'sync', createdAt: '2026-02-01T03:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        expect(res.status).toBe(200);
        const board = res.body.boards[0];
        expect(board.scores).toHaveLength(2);
        expect(board.scores[0]).toMatchObject({ rank: 1, iscored_username: 'AceAlt', score: 900 });
        expect(board.scores[1]).toMatchObject({ rank: 2, iscored_username: 'Zed', score: 600 });
        // display_name ships alongside the stable identifier, per the doctrine.
        expect(board.scores[0].display_name).toBe('The Ace');
        expect(board.scores[0].discord_user_id).toBe('disc-1');
        expect(board.scores[1].display_name).toBeNull();
    });

    it('404s when the tournament belongs to another room', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('room-a', 'Room A');
        const roomB = await createTestRoom('room-b', 'Room B');
        const tId = await createTestTournament(roomB);
        await createTestGame(tId, { name: 'Foreign Game', status: 'COMPLETED' });
        await insertHistoryScore({ gameRoomId: roomB, gameName: 'Foreign Game', username: 'Ann', score: 1, tournamentId: tId });

        const res = await request(app).get(`/api/rooms/${roomA}/tournaments/${tId}/scores`);
        expect(res.status).toBe(404);

        const missing = await request(app).get(`/api/rooms/${roomA}/tournaments/does-not-exist/scores`);
        expect(missing.status).toBe(404);
    });

    it('excludes orphaned rows and scores from other tournaments', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId, { name: 'Mine' });
        const otherId = await createTestTournament(roomId, { name: 'Theirs' });
        await createTestGame(tId, { name: 'Shared Game', status: 'COMPLETED', endDate: '2026-04-01T00:00:00.000Z' });

        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Shared Game', username: 'Keeper', score: 10, tournamentId: tId });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Shared Game', username: 'Orphan', score: 999, tournamentId: tId, orphanedAt: '2026-04-02T00:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Shared Game', username: 'Outsider', score: 888, tournamentId: otherId });
        // A freeplay/community score with no tournament stamp never counts.
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Shared Game', username: 'Freeplay', score: 777, tournamentId: null, source: 'community' });

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        expect(res.status).toBe(200);
        expect(res.body.boards).toHaveLength(1);
        expect(res.body.boards[0].scores.map((s: any) => s.iscored_username)).toEqual(['Keeper']);
    });

    it('still returns a board whose games slot was deleted, and counts repeat features', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        // "Twice" ran two slots; "Ghost" has no games row at all (slot deleted,
        // scores survive per ADR 0005).
        await createTestGame(tId, {
            name: 'Twice', status: 'COMPLETED',
            startDate: '2026-05-01T00:00:00.000Z', endDate: '2026-05-02T00:00:00.000Z',
        });
        await createTestGame(tId, {
            name: 'Twice', status: 'COMPLETED',
            startDate: '2026-05-10T00:00:00.000Z', endDate: '2026-05-11T00:00:00.000Z',
        });

        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Twice', username: 'Ann', score: 10, tournamentId: tId, createdAt: '2026-05-01T01:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'Ghost', username: 'Bob', score: 20, tournamentId: tId, createdAt: '2026-05-20T01:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/scores`);

        expect(res.status).toBe(200);
        const keys = res.body.boards.map((b: any) => b.game_key);
        expect(keys).toContain('ghost');

        const twice = res.body.boards.find((b: any) => b.game_key === 'twice');
        expect(twice.slot_count).toBe(2);
        // Metadata comes from the MOST RECENT slot.
        expect(twice.end_date).toBe('2026-05-11T00:00:00.000Z');

        const ghost = res.body.boards.find((b: any) => b.game_key === 'ghost');
        expect(ghost.slot_count).toBe(0);
        expect(ghost.end_date).toBeNull();
        expect(ghost.status).toBeNull();
        expect(ghost.scores).toHaveLength(1);
        // Dated slots sort ahead of the slot-less board.
        expect(keys[keys.length - 1]).toBe('ghost');
    });
});

describe('GET /api/rooms/:roomId/history — ids for click-through', () => {
    it('ships game_id and tournament_id on every row', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, {
            name: 'Linked Game', status: 'COMPLETED', endDate: '2026-06-01T00:00:00.000Z',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/history`);

        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(1);
        expect(res.body.results[0]).toMatchObject({
            game_id: gameId, tournament_id: tId, game_name: 'Linked Game',
        });
    });
});

/**
 * v2.238.0 (B24) — one winner rule for every list of past runs: the run
 * board's rank 1 (the board the run's card showed), named at read. Before it
 * History crowned the best `submissions` row under its raw iScored name, so it
 * could disagree with the tournament page for the same run.
 */
describe('GET /api/rooms/:roomId/history — run winners and deep links (B24)', () => {
    it('names each run\'s own rank 1 with the display name, and counts its players', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId, { name: 'Daily Grind', type: 'DG' });
        // Two runs of ONE table in one tournament: each run's board is its own.
        const run1 = await createTestGame(tId, {
            name: 'WHO dunnit', status: 'COMPLETED',
            startDate: '2026-01-01T00:00:00.000Z', endDate: '2026-01-02T00:00:00.000Z',
        });
        const run2 = await createTestGame(tId, {
            name: 'WHO dunnit', status: 'COMPLETED',
            startDate: '2026-01-05T00:00:00.000Z', endDate: '2026-01-06T00:00:00.000Z',
        });
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('u-ann', 'Annie')`);
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'WHO dunnit', username: 'Ann', submittedByUserId: 'u-ann', score: 300, tournamentId: tId, createdAt: '2026-01-01T05:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'WHO dunnit', username: 'Bob', score: 200, tournamentId: tId, createdAt: '2026-01-01T06:00:00.000Z' });
        await insertHistoryScore({ gameRoomId: roomId, gameName: 'WHO dunnit', username: 'Bob', score: 900, tournamentId: tId, createdAt: '2026-01-05T05:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/history?tournament_id=${tId}`);

        expect(res.status).toBe(200);
        const byId = new Map(res.body.results.map((r: { game_id: string }) => [r.game_id, r]));
        // Run 1: Ann's 300 wins under her display name; Bob's 900 from run 2
        // does not leak back into it.
        expect(byId.get(run1)).toMatchObject({
            winner_name: 'Annie', winner_username: 'Ann', winner_score: 300, players: 2,
        });
        expect(byId.get(run2)).toMatchObject({
            winner_name: 'Bob', winner_username: 'Bob', winner_score: 900, players: 1,
        });
        // Newest run first.
        expect(res.body.results.map((r: { game_id: string }) => r.game_id)).toEqual([run2, run1]);
    });

    it('a run nobody played has no winner and zero players', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await createTestGame(tId, { name: 'Empty Table', status: 'COMPLETED', endDate: '2026-02-01T00:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/history`);

        expect(res.body.results[0]).toMatchObject({
            winner_name: null, winner_username: null, winner_score: null, players: 0,
        });
    });

    it('?run= answers the page that holds that run', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const oldest = await createTestGame(tId, { name: 'A', status: 'COMPLETED', endDate: '2026-03-01T00:00:00.000Z' });
        await createTestGame(tId, { name: 'B', status: 'COMPLETED', endDate: '2026-03-02T00:00:00.000Z' });
        await createTestGame(tId, { name: 'C', status: 'COMPLETED', endDate: '2026-03-03T00:00:00.000Z' });

        const res = await request(app).get(`/api/rooms/${roomId}/history?tournament_id=${tId}&limit=2&run=${oldest}`);

        expect(res.body.page).toBe(2);
        expect(res.body.total).toBe(3);
        expect(res.body.results.map((r: { game_id: string }) => r.game_id)).toEqual([oldest]);

        // An id outside the filter (or unknown) leaves the requested page alone.
        const miss = await request(app).get(`/api/rooms/${roomId}/history?tournament_id=${tId}&limit=2&page=1&run=nope`);
        expect(miss.body.page).toBe(1);
        expect(miss.body.results).toHaveLength(2);
    });
});
