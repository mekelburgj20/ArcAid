import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { CommunityScoreService } from '../services/CommunityScoreService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { RoomScoresService } from '../services/RoomScoresService.js';

/**
 * v2.108.0 — quick self-delete of your own scores.
 *
 * Covers the two cascades the per-row delete grew (community_scores twin,
 * global_scores fan-out), the three new identity-stable ranked-row fields and
 * the cache-envelope bump they forced, and the route's authorization tiers now
 * that `source='community'` is accepted.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const superToken = () =>
    signToken({ role: 'super_admin', discordId: 'super-1', username: 'Super', gameRoomIds: [] });
const adminToken = (roomId: string, discordId = 'admin-1') =>
    signToken({ role: 'room_admin', discordId, username: 'Admin', gameRoomIds: [roomId] });
const playerToken = (discordId: string, username = 'someone') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

/** The score_history row a community submit just wrote. */
async function communityHistoryRow(roomId: string, gameName: string, username: string) {
    const db = await getDatabase();
    return db.get(
        `SELECT * FROM score_history
         WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND LOWER(iscored_username) = LOWER(?)
           AND source = 'community'`,
        roomId, gameName, username,
    );
}

// ---------------------------------------------------------------------------
// B1 — community cascade
// ---------------------------------------------------------------------------

describe('B1 — community-source cascade', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('deletes the community_scores twin alongside the score_history row', async () => {
        const roomId = await createTestRoom('b1-room');
        await CommunityScoreService.submitScore(roomId, 'Whirlwind', 'Ada', 4200, 'disc-ada');

        const db = await getDatabase();
        const before = await db.all('SELECT id FROM community_scores WHERE game_room_id = ?', roomId);
        expect(before).toHaveLength(1);

        const row = await communityHistoryRow(roomId, 'Whirlwind', 'Ada');
        expect(row.source).toBe('community');
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(row.id) as any, 'disc-ada',
        );

        expect(await db.all('SELECT id FROM score_history WHERE id = ?', row.id)).toHaveLength(0);
        expect(await db.all('SELECT id FROM community_scores WHERE game_room_id = ?', roomId)).toHaveLength(0);
    });

    it('writes NO iScored suppression tombstone for a community row', async () => {
        const roomId = await createTestRoom('b1-tombstone');
        await CommunityScoreService.submitScore(roomId, 'Taxi', 'Ben', 900, 'disc-ben');

        const db = await getDatabase();
        const row = await communityHistoryRow(roomId, 'Taxi', 'Ben');
        // Give the row a game_id so the tombstone branch is even reachable —
        // the gate that must hold is `source IN ('sync','tournament')`.
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Taxi' });
        await db.run('UPDATE score_history SET game_id = ? WHERE id = ?', gameId, row.id);

        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(row.id) as any, 'disc-ben',
        );

        expect(await db.all('SELECT * FROM deleted_score_suppressions')).toHaveLength(0);
    });

    it('leaves BOTH community_scores rows alone when the match is ambiguous', async () => {
        const roomId = await createTestRoom('b1-ambiguous');
        await CommunityScoreService.submitScore(roomId, 'Congo', 'Cy', 700, 'disc-cy');

        const db = await getDatabase();
        // A second community_scores row identical on every match column. Only
        // one score_history row exists (its insert-time dedup collapsed them),
        // so there is no way to tell which twin is being deleted.
        const dupe = await db.get('SELECT * FROM community_scores WHERE game_room_id = ?', roomId);
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score,
                                           submitted_from_room_id, submitted_by_user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            dupe.game_name, roomId, dupe.iscored_username, dupe.discord_user_id, dupe.score,
            roomId, dupe.submitted_by_user_id,
        );

        const row = await communityHistoryRow(roomId, 'Congo', 'Cy');
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(row.id) as any, 'disc-cy',
        );

        // score_history row is gone (that IS the delete the caller asked for),
        // but nothing was guessed at in community_scores.
        expect(await db.all('SELECT id FROM score_history WHERE id = ?', row.id)).toHaveLength(0);
        expect(await db.all('SELECT id FROM community_scores WHERE game_room_id = ?', roomId)).toHaveLength(2);
    });

    it('leaves the submissions recompute alone — a community delete never drops a tournament best', async () => {
        const roomId = await createTestRoom('b1-recompute');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Congo' });
        await createTestSubmission(gameId, { username: 'Dee', score: 5000, discordUserId: 'disc-dee' });

        await CommunityScoreService.submitScore(roomId, 'Congo', 'Dee', 100, 'disc-dee');
        const db = await getDatabase();
        const row = await communityHistoryRow(roomId, 'Congo', 'Dee');
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(row.id) as any, 'disc-dee',
        );

        const submission = await db.get('SELECT score FROM submissions WHERE game_id = ?', gameId);
        expect(submission.score).toBe(5000);
    });
});

// ---------------------------------------------------------------------------
// B2 — global fan-out cleanup
// ---------------------------------------------------------------------------

describe('B2 — global fan-out cleanup', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seedGlobalScore(roomId: string, opts: {
        playerId: string | null; username: string; score: number; gameName?: string;
    }) {
        const db = await getDatabase();
        const globalGameId = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, features, status)
             VALUES (?, ?, 'pinball', '[]', '[]', 'approved')`,
            globalGameId, opts.gameName ?? 'Whirlwind',
        );
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score,
                                        origin_type, origin_game_room_id, submitted_at, submitted_by_user_id)
             VALUES (?, ?, ?, ?, ?, 'game_room', ?, datetime('now'), ?)`,
            id, globalGameId, opts.playerId, opts.username, opts.score, roomId, opts.playerId,
        );
        return { id, globalGameId };
    }

    it('soft-deletes the fanned-out global row on a unique match', async () => {
        const roomId = await createTestRoom('b2-hit');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Whirlwind' });
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        await db.run(
            `UPDATE score_history SET submitted_by_user_id = 'disc-ada' WHERE game_id = ?`, gameId,
        );
        const { id: globalId } = await seedGlobalScore(roomId, {
            playerId: 'disc-ada', username: 'Ada', score: 4200,
        });

        const historyRow = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(historyRow.id) as any, 'disc-ada',
        );

        const after = await db.get('SELECT deleted_at, deleted_by FROM global_scores WHERE id = ?', globalId);
        expect(after.deleted_at).toBeTruthy();
        expect(after.deleted_by).toBe('disc-ada');
    });

    it('skips when two global rows match — never guesses at the second candidate', async () => {
        const roomId = await createTestRoom('b2-ambiguous');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Whirlwind' });
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        await db.run(`UPDATE score_history SET submitted_by_user_id = 'disc-ada' WHERE game_id = ?`, gameId);
        const first = await seedGlobalScore(roomId, { playerId: 'disc-ada', username: 'Ada', score: 4200 });
        const secondId = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score,
                                        origin_type, origin_game_room_id, submitted_at, submitted_by_user_id)
             VALUES (?, ?, 'disc-ada', 'Ada', 4200, 'game_room', ?, datetime('now'), 'disc-ada')`,
            secondId, first.globalGameId, roomId,
        );

        const historyRow = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(historyRow.id) as any, 'disc-ada',
        );

        const rows = await db.all('SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?', roomId);
        expect(rows).toHaveLength(2);
        expect(rows.every((r: any) => r.deleted_at == null)).toBe(true);
    });

    it('skips entirely for an unattributed row — a guest score has no global twin', async () => {
        const roomId = await createTestRoom('b2-anon');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Whirlwind' });
        await createTestSubmission(gameId, { username: 'Ada', score: 4200 });

        const db = await getDatabase();
        const { id: globalId } = await seedGlobalScore(roomId, {
            playerId: 'someone-else', username: 'Ada', score: 4200,
        });

        const historyRow = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);
        await ScoreHistoryService.deleteEvent(
            await ScoreHistoryService.getDeletableRow(historyRow.id) as any, 'admin-1',
        );

        const after = await db.get('SELECT deleted_at FROM global_scores WHERE id = ?', globalId);
        expect(after.deleted_at).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// B3 — ranked-row payload + cache envelope
// ---------------------------------------------------------------------------

describe('B3 — ranked-row identity fields', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ships history_id, source and the RAW submitted_by_user_id on the live path', async () => {
        const roomId = await createTestRoom('b3-live');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId);
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        await db.run(`UPDATE score_history SET submitted_by_user_id = 'disc-ada' WHERE game_id = ?`, gameId);
        const expected = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);

        const rankings = await LeaderboardService.recalculate(gameId);
        expect(rankings[0]!.history_id).toBe(expected.id);
        expect(rankings[0]!.source).toBe('tournament');
        expect(rankings[0]!.submitted_by_user_id).toBe('disc-ada');
    });

    it('carries the fields through the CACHED read path', async () => {
        const roomId = await createTestRoom('b3-cached');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId);
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });
        await LeaderboardService.recalculate(gameId);

        const cachedRankings = await LeaderboardService.getForGame(gameId);
        expect(cachedRankings[0]!.history_id).toBeTypeOf('number');
        expect(cachedRankings[0]!.source).toBe('tournament');
    });

    it('bumps the cache envelope to v3 so a v2 blob reads as a miss', async () => {
        const roomId = await createTestRoom('b3-envelope');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId);
        await createTestSubmission(gameId, { username: 'Ada', score: 4200 });

        const db = await getDatabase();
        // A v2 blob: right envelope shape, no history_id/source on the rows.
        await db.run(
            `INSERT OR REPLACE INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)`,
            gameId,
            JSON.stringify({ v: 2, rows: [{
                rank: 1, discord_user_id: 'stale', submitted_by_user_id: null,
                iscored_username: 'Stale', score: 1, platform: null, engine: 'unknown', device: 'unknown',
            }] }),
            new Date().toISOString(),
        );

        const rankings = await LeaderboardService.getForGame(gameId);
        // Recalculated, not served from the stale blob.
        expect(rankings[0]!.iscored_username).toBe('Ada');
        expect(rankings[0]!.history_id).toBeTypeOf('number');

        const rewritten = await db.get('SELECT rankings FROM leaderboard_cache WHERE game_id = ?', gameId);
        expect(JSON.parse(rewritten.rankings).v).toBe(3);
    });

    it('RoomScoresService card rankings carry the same three fields', async () => {
        const roomId = await createTestRoom('b3-roomscores');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Whirlwind' });
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        await db.run(`UPDATE score_history SET submitted_by_user_id = 'disc-ada' WHERE game_id = ?`, gameId);

        const { data } = await RoomScoresService.getRoomScores(roomId, {});
        const row = data[0]!.rankings[0]!;
        expect(row.history_id).toBeTypeOf('number');
        expect(row.source).toBe('tournament');
        expect(row.submitted_by_user_id).toBe('disc-ada');
    });
});

// ---------------------------------------------------------------------------
// B4 — route authorization, now that community rows are accepted
// ---------------------------------------------------------------------------

describe('B4 — DELETE /:roomId/score-history/:historyId tiers', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    /** Community score by `discordId`, returning its score_history id. */
    async function seedCommunity(roomId: string, discordId: string | undefined, username: string) {
        await CommunityScoreService.submitScore(roomId, 'Whirlwind', username, 4200, discordId);
        const row = await communityHistoryRow(roomId, 'Whirlwind', username);
        return row.id as number;
    }

    it('lets a player delete their OWN community score (the v2.9.0 gap, closed)', async () => {
        const roomId = await createTestRoom('b4-own');
        const historyId = await seedCommunity(roomId, 'disc-ada', 'Ada');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${historyId}`)
            .set('Authorization', `Bearer ${playerToken('disc-ada', 'Ada')}`);
        expect(res.status).toBe(200);

        const db = await getDatabase();
        expect(await db.all('SELECT id FROM score_history WHERE id = ?', historyId)).toHaveLength(0);
        expect(await db.all('SELECT id FROM community_scores WHERE game_room_id = ?', roomId)).toHaveLength(0);
    });

    it('refuses another player\'s community score', async () => {
        const roomId = await createTestRoom('b4-other');
        const historyId = await seedCommunity(roomId, 'disc-ada', 'Ada');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${historyId}`)
            .set('Authorization', `Bearer ${playerToken('disc-ben', 'Ben')}`);
        expect(res.status).toBe(403);

        const db = await getDatabase();
        expect(await db.all('SELECT id FROM score_history WHERE id = ?', historyId)).toHaveLength(1);
    });

    it('lets a room admin delete anyone\'s community score in their room', async () => {
        const roomId = await createTestRoom('b4-admin');
        const historyId = await seedCommunity(roomId, 'disc-ada', 'Ada');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${historyId}`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`);
        expect(res.status).toBe(200);
    });

    it('lets a super admin delete it too', async () => {
        const roomId = await createTestRoom('b4-super');
        const historyId = await seedCommunity(roomId, 'disc-ada', 'Ada');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${historyId}`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);
    });

    it('gates on the RAW submitted_by_user_id, not the display discord_user_id', async () => {
        const roomId = await createTestRoom('b4-raw');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId);
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        // The per-row `discord_user_id` says disc-ada, but the row was never
        // ATTRIBUTED (submitted_by_user_id NULL) — nobody owns it.
        await db.run(`UPDATE score_history SET submitted_by_user_id = NULL WHERE game_id = ?`, gameId);
        const row = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/score-history/${row.id}`)
            .set('Authorization', `Bearer ${playerToken('disc-ada', 'Ada')}`);
        expect(res.status).toBe(403);
    });

    it('route allowlist now covers the WHOLE source domain the schema permits', async () => {
        // The route's `source` guard used to reject `community`, which is why
        // the community cascade was needed. Now that all three are accepted,
        // the guard is a belt-and-braces check with nothing left to reject —
        // `score_history.source` carries a CHECK constraint pinning it to
        // exactly these three values, so a fourth source cannot even be
        // written. This test is what fails if a migration widens the column
        // without someone revisiting the delete allowlist.
        const roomId = await createTestRoom('b4-source-domain');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId);
        await createTestSubmission(gameId, { username: 'Ada', score: 4200, discordUserId: 'disc-ada' });

        const db = await getDatabase();
        const row = await db.get('SELECT id FROM score_history WHERE game_id = ?', gameId);
        await expect(
            db.run(`UPDATE score_history SET source = 'freeplay' WHERE id = ?`, row.id),
        ).rejects.toThrow(/CHECK constraint failed/);
    });
});
