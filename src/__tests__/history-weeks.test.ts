import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.241.0 (B26) — History and the tournament page show runs a WEEK at a time
 * as cards with their final standings open (owner 2026-11-10: "show maybe 1
 * week's worth of history on page 1, and then they can cycle through them").
 *
 * Week 0 is the seven days ending at the NEWEST run in the filter (not now),
 * so a tournament that finished months ago still opens on a full week.
 */

async function app() {
    await setupTestDb();
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

/** Runs ending (UTC noon) on these November/October days, newest first. */
async function seedRuns(tId: string, ends: Array<[string, string]>) {
    const ids: Record<string, string> = {};
    for (const [name, end] of ends) {
        ids[name] = await createTestGame(tId, {
            name, status: 'COMPLETED',
            startDate: new Date(Date.parse(end) - 86_400_000).toISOString(), endDate: end,
        });
    }
    return ids;
}

const ENDS: Array<[string, string]> = [
    ['Nov10', '2026-11-10T12:00:00.000Z'],
    ['Nov08', '2026-11-08T12:00:00.000Z'],
    ['Nov04', '2026-11-04T12:00:00.000Z'],
    ['Nov02', '2026-11-02T12:00:00.000Z'],
    ['Oct19', '2026-10-19T12:00:00.000Z'],
];

const names = (body: { results: Array<{ game_name: string }> }) => body.results.map(r => r.game_name);

describe('GET /api/rooms/:roomId/history?week=', () => {
    it('week 0 is the seven days ending at the newest run; older weeks step back from there', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await seedRuns(tId, ENDS);

        const w0 = (await request(a).get(`/api/rooms/${roomId}/history?week=0`)).body;
        expect(names(w0)).toEqual(['Nov10', 'Nov08', 'Nov04']);
        expect(w0).toMatchObject({
            week: 0, total: 5, has_newer: false, has_older: true,
            window: { from: '2026-11-03T12:00:00.000Z', to: '2026-11-10T12:00:00.000Z' },
        });

        const w1 = (await request(a).get(`/api/rooms/${roomId}/history?week=1`)).body;
        expect(names(w1)).toEqual(['Nov02']);
        expect(w1).toMatchObject({ week: 1, has_newer: true, has_older: true });

        // A quiet week is still a week: empty, with the way on in both directions.
        const w2 = (await request(a).get(`/api/rooms/${roomId}/history?week=2`)).body;
        expect(names(w2)).toEqual([]);
        expect(w2).toMatchObject({ has_newer: true, has_older: true });

        const w3 = (await request(a).get(`/api/rooms/${roomId}/history?week=3`)).body;
        expect(names(w3)).toEqual(['Oct19']);
        expect(w3).toMatchObject({ has_older: false });
    });

    it('?run= answers the week that holds the run', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const ids = await seedRuns(tId, ENDS);

        const res = (await request(a).get(`/api/rooms/${roomId}/history?week=0&run=${ids.Oct19}`)).body;
        expect(res.week).toBe(3);
        expect(names(res)).toEqual(['Oct19']);
    });

    it('anchors on the filtered set, so a finished tournament opens on its last week', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const live = await createTestTournament(roomId, { name: 'Live' });
        const old = await createTestTournament(roomId, { name: 'Spring Cup' });
        await seedRuns(live, [['Recent', '2026-11-10T12:00:00.000Z']]);
        await seedRuns(old, [['Final', '2026-04-30T12:00:00.000Z'], ['Semi', '2026-04-28T12:00:00.000Z']]);

        const res = (await request(a).get(`/api/rooms/${roomId}/history?week=0&tournament_id=${old}`)).body;
        expect(names(res)).toEqual(['Final', 'Semi']);
    });

    it('no runs at all: an empty week with no window', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        await createTestTournament(roomId);
        const res = (await request(a).get(`/api/rooms/${roomId}/history?week=0`)).body;
        expect(res).toMatchObject({ results: [], window: null, has_newer: false, has_older: false });
    });

    it('standings=1 ships each run\'s whole final board, rank 1 first, with names and avatars', async () => {
        const a = await app();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await seedRuns(tId, [['Godzilla', '2026-11-10T12:00:00.000Z']]);
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES ('111111111111111111', 'Pete', 'ph')`);
        const scoreAt = '2026-11-10T01:00:00.000Z';
        for (const [user, owner, score] of [['PeteG', '111111111111111111', 900], ['Ann', null, 500], ['Bob', null, 700]] as const) {
            await db.run(
                `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id,
                    submitted_by_user_id, score, source, submitted_from_room_id, submitted_during_tournament_id, created_at)
                 VALUES ('Godzilla', ?, NULL, ?, ?, ?, ?, 'tournament', ?, ?, ?)`,
                roomId, user, owner ?? 'SYSTEM', owner, score, roomId, tId, scoreAt,
            );
        }

        const run = (await request(a).get(`/api/rooms/${roomId}/history?week=0&standings=1`)).body.results[0];

        expect(run.standings.map((s: { iscored_username: string; rank: number }) => [s.rank, s.iscored_username]))
            .toEqual([[1, 'PeteG'], [2, 'Bob'], [3, 'Ann']]);
        expect(run.standings[0]).toMatchObject({ display_name: 'Pete', avatar_hash: 'ph', score: 900 });
        expect(run).toMatchObject({ winner_name: 'Pete', winner_avatar_hash: 'ph', players: 3 });

        // Without the flag there is no board on the row.
        const plain = (await request(a).get(`/api/rooms/${roomId}/history?week=0`)).body.results[0];
        expect(plain.standings).toBeUndefined();
        expect(plain).toMatchObject({ winner_name: 'Pete', players: 3 });
    });

    it('page mode is unchanged when no week is asked for', async () => {
        const a = await app();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        await seedRuns(tId, ENDS);
        const res = (await request(a).get(`/api/rooms/${roomId}/history?limit=2`)).body;
        expect(res).toMatchObject({ page: 1, limit: 2, total: 5 });
        expect(names(res)).toEqual(['Nov10', 'Nov08']);
    });
});
