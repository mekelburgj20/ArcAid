import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { CommunityScoreService } from '../services/CommunityScoreService.js';

/**
 * Admin score CORRECTION — `PATCH /:roomId/score-history/:historyId/score`.
 *
 * Owner incident, 2026-08-30: `66,661,589,860` submitted for `6,666,158,980`
 * on a Daily Grind table that had already rotated to COMPLETED. There was no
 * edit path at any privilege level, and both available remedies were wrong —
 * deleting tombstoned the WRONG value and handed the win to another player,
 * and there was no way to add the right number back because every submit path
 * requires `games.status = 'ACTIVE'`.
 *
 * These pin the properties that make a correction a correction rather than a
 * delete-and-resubmit: the row survives, the recompute follows it, the
 * cascades move with it, and the iScored poller cannot undo it.
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
const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', discordId: 'admin-1', username: 'Admin', gameRoomIds: [roomId] });
const playerToken = (discordId: string) =>
    signToken({ role: 'player', discordId, username: 'Player', gameRoomIds: [] });

/** Room + tournament + one COMPLETED game — the incident's exact shape. */
async function completedGameFixture(scores: Array<{ username?: string; score?: number; discordUserId?: string }>) {
    const roomId = await createTestRoom('correct-room');
    const tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    const gameId = await createTestGame(tournamentId, { name: 'World Cup Soccer', status: 'COMPLETED' });
    for (const s of scores) {
        await createTestSubmission(gameId, s);
    }
    return { roomId, tournamentId, gameId };
}

/**
 * Give a room a full, valid iScored credential set — the state in which
 * `ScoreSyncPoller` actually reads the room, and therefore the only state in
 * which a downward correction needs its re-import tombstone.
 */
async function connectIScored(roomId: string) {
    const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
    await GameRoomSettingsService.set(roomId, 'ISCORED_USERNAME', 'RTX_Pinball');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'hunter2');
    await GameRoomSettingsService.set(roomId, 'ISCORED_PUBLIC_URL', 'https://www.iscored.info/RTX_Pinball');
}

async function historyRow(gameId: string, username: string) {
    const db = await getDatabase();
    return db.get<{ id: number; score: number }>(
        `SELECT id, score FROM score_history
         WHERE game_id = ? AND LOWER(iscored_username) = LOWER(?)
         ORDER BY id DESC LIMIT 1`,
        gameId, username,
    );
}

describe('ScoreHistoryService.correctScore', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('changes the value in place and leaves the row (and its id) standing', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const before = await historyRow(gameId, 'Nudge');

        const row = await ScoreHistoryService.getDeletableRow(before!.id);
        await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        const db = await getDatabase();
        const after = await db.get<{ id: number; score: number }>(
            'SELECT id, score FROM score_history WHERE id = ?', before!.id,
        );
        expect(after!.id).toBe(before!.id);
        expect(after!.score).toBe(6666158980);
    });

    it('recomputes the submissions row (best-per-player-per-game) after the change', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        const db = await getDatabase();
        const sub = await db.get<{ score: number }>(
            'SELECT score FROM submissions WHERE id = ?', `${gameId}-nudge`,
        );
        expect(sub!.score).toBe(6666158980);
    });

    it('falls back to the next-best row when the corrected score is no longer the best', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const db = await getDatabase();
        // Grab the typo row BEFORE adding a second one — `historyRow` takes the
        // highest id, which the insert below would become.
        const typoRowId = (await historyRow(gameId, 'Nudge'))!.id;
        // An earlier, legitimate score for the same player + game.
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source)
             SELECT game_name, game_room_id, game_id, iscored_username, discord_user_id, 9000000000, source
             FROM score_history WHERE id = ?`,
            typoRowId,
        );

        const row = await ScoreHistoryService.getDeletableRow(typoRowId);
        await ScoreHistoryService.correctScore(row!, 100, 'admin-1');

        const sub = await db.get<{ score: number }>(
            'SELECT score FROM submissions WHERE id = ?', `${gameId}-nudge`,
        );
        // The 9,000,000,000 row is untouched and is now the best.
        expect(sub!.score).toBe(9000000000);
    });

    it('tombstones the OLD value when correcting DOWN, so the iScored poller cannot re-import it', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        await connectIScored(roomId);
        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        const result = await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        expect(result.suppressedAt).toBe(66661589860);
        const db = await getDatabase();
        const supp = await db.get<{ suppressed_score: number }>(
            'SELECT suppressed_score FROM deleted_score_suppressions WHERE game_id = ? AND iscored_username_lower = ?',
            gameId, 'nudge',
        );
        expect(supp!.suppressed_score).toBe(66661589860);
    });

    it('does NOT tombstone when correcting UP — the poller only ever raises a score', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        await connectIScored(roomId);
        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        const result = await ScoreHistoryService.correctScore(row!, 5000, 'admin-1');

        expect(result.suppressedAt).toBeNull();
        const db = await getDatabase();
        const supp = await db.all('SELECT * FROM deleted_score_suppressions WHERE game_id = ?', gameId);
        expect(supp).toHaveLength(0);
    });

    /**
     * Owner request 2026-08-31, after RTX_Pinball dropped iScored: the
     * tombstone exists ONLY to stop `ScoreSyncPoller` re-importing the old
     * value. A room the poller never reads gains nothing from it and pays the
     * full cost — a later genuine score between the new and old values would
     * be suppressed for no reason.
     */
    it('skips the tombstone when the room has iScored switched off', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        await connectIScored(roomId);
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'ISCORED_ENABLED', 'false');

        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        const result = await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        expect(result.suppressedAt).toBeNull();
        const db = await getDatabase();
        expect(await db.all('SELECT * FROM deleted_score_suppressions WHERE game_id = ?', gameId)).toHaveLength(0);
        // The correction itself still happened — only the guard was skipped.
        const after = await db.get<{ score: number }>('SELECT score FROM score_history WHERE id = ?', row!.id);
        expect(after!.score).toBe(6666158980);
    });

    it('skips the tombstone for a room that never had iScored configured', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        const result = await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        expect(result.suppressedAt).toBeNull();
        const db = await getDatabase();
        expect(await db.all('SELECT * FROM deleted_score_suppressions WHERE game_id = ?', gameId)).toHaveLength(0);
    });

    it('skips the tombstone on a PARTIALLY configured room — the poller does not read it either', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        // The exact state RTX_Pinball was left in by clearing the credential
        // fields: a stray password and nothing else.
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'ISCORED_PASSWORD', 'hunter2');

        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        const result = await ScoreHistoryService.correctScore(row!, 6666158980, 'admin-1');

        expect(result.suppressedAt).toBeNull();
    });

    it('carries the community_scores twin along instead of deleting it', async () => {
        const roomId = await createTestRoom('correct-community');
        await CommunityScoreService.submitScore(roomId, 'Whirlwind', 'Ada', 4200, 'disc-ada');

        const db = await getDatabase();
        const hist = await db.get<{ id: number }>(
            `SELECT id FROM score_history WHERE game_room_id = ? AND source = 'community'`, roomId,
        );
        const row = await ScoreHistoryService.getDeletableRow(hist!.id);
        await ScoreHistoryService.correctScore(row!, 420, 'admin-1');

        const twin = await db.get<{ score: number }>(
            'SELECT score FROM community_scores WHERE game_room_id = ?', roomId,
        );
        expect(twin!.score).toBe(420);
        // Corrected, never deleted — that is the whole difference between this
        // path and `deleteEvent`.
        const survivors = await db.all('SELECT id FROM community_scores WHERE game_room_id = ?', roomId);
        expect(survivors).toHaveLength(1);
    });

    it('refuses a negative or non-integer score', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const row = await ScoreHistoryService.getDeletableRow((await historyRow(gameId, 'Nudge'))!.id);
        await expect(ScoreHistoryService.correctScore(row!, -1, 'admin-1')).rejects.toThrow();
        await expect(ScoreHistoryService.correctScore(row!, 1.5, 'admin-1')).rejects.toThrow();
    });
});

/**
 * v2.149.1 — the admin Manage Scores modal offers a correction beside its
 * delete, and a correction is keyed on `score_history.id`, which this endpoint
 * did not ship. The owner went looking for the pencil here first.
 */
describe('GET /:roomId/leaderboard/:gameId/submissions — history_id', () => {
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('ships the score_history id backing each submissions row', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}/submissions`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].history_id).toBe(hist!.id);
        expect(res.body[0].score).toBe(66661589860);
    });

    it('matches on the EXACT score, so the pencil never opens on a different number', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 5000 }]);
        const db = await getDatabase();
        // A LOWER earlier score for the same player. The submissions row holds
        // 5000, so history_id must be the 5000 row, not this one.
        const lower = await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source)
             VALUES ('World Cup Soccer', ?, ?, 'Nudge', 'SYSTEM', 100, 'tournament')`,
            roomId, gameId,
        );
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}/submissions`);

        expect(res.body[0].history_id).not.toBe(lower.lastID);
        const matched = await db.get<{ score: number }>(
            'SELECT score FROM score_history WHERE id = ?', res.body[0].history_id,
        );
        expect(matched!.score).toBe(5000);
    });

    it('returns a NULL history_id when nothing matches, rather than guessing', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 5000 }]);
        const db = await getDatabase();
        // Simulate a legacy row: the submissions row survives, its history does not.
        await db.run('DELETE FROM score_history WHERE game_id = ?', gameId);

        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}/submissions`);

        expect(res.body).toHaveLength(1);
        expect(res.body[0].history_id).toBeNull();
    });

    it('resolves for a row whose game_id is NULL (every modern web submission)', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 5000 }]);
        const db = await getDatabase();
        // v2.75.1 doctrine: game_id is a transient pointer, NULL on web rows.
        await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', gameId);

        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard/${gameId}/submissions`);

        expect(res.body[0].history_id).not.toBeNull();
    });
});

describe('PATCH /:roomId/score-history/:historyId/score — authorization + validation', () => {
    // `createTestApp` calls `setupTestDb` itself; a second call here would
    // close the handle the app is already holding (same idiom as
    // `score-self-delete.test.ts`'s route describe).
    let app: express.Express;
    beforeEach(async () => { app = await createTestApp(); });

    it('a room admin may correct a row in their room', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ score: 6666158980 });

        expect(res.status).toBe(200);
        expect(res.body.score).toBe(6666158980);
        expect(res.body.previousScore).toBe(66661589860);
    });

    it('a super admin may correct any row', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ score: 2000 });

        expect(res.status).toBe(200);
    });

    it('a PLAYER may not correct their own score — that would be an edit-the-leaderboard tool', async () => {
        const { roomId, gameId } = await completedGameFixture([
            { username: 'Nudge', score: 1000, discordUserId: 'disc-nudge' },
        ]);
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${playerToken('disc-nudge')}`)
            .send({ score: 999999 });

        expect(res.status).toBe(403);
        const db = await getDatabase();
        const after = await db.get<{ score: number }>('SELECT score FROM score_history WHERE id = ?', hist!.id);
        expect(after!.score).toBe(1000);
    });

    it('an admin of a DIFFERENT room is refused', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const otherRoomId = await createTestRoom('other-room');
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${adminToken(otherRoomId)}`)
            .send({ score: 2000 });

        expect(res.status).toBe(403);
    });

    it('404s a row that belongs to another room', async () => {
        const { gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const otherRoomId = await createTestRoom('other-room');
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${otherRoomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${adminToken(otherRoomId)}`)
            .send({ score: 2000 });

        expect(res.status).toBe(404);
    });

    it('rejects a non-integer, a negative, and an unsafe-integer score', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const hist = await historyRow(gameId, 'Nudge');
        const auth = `Bearer ${adminToken(roomId)}`;

        for (const bad of [1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
            const res = await request(app)
                .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
                .set('Authorization', auth)
                .send({ score: bad });
            expect(res.status).toBe(400);
        }
    });

    it('rejects a no-op correction rather than writing a pointless audit row', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 1000 }]);
        const hist = await historyRow(gameId, 'Nudge');

        const res = await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ score: 1000 });

        expect(res.status).toBe(400);
    });

    it('writes an audit row naming both values', async () => {
        const { roomId, gameId } = await completedGameFixture([{ username: 'Nudge', score: 66661589860 }]);
        const hist = await historyRow(gameId, 'Nudge');

        await request(app)
            .patch(`/api/rooms/${roomId}/score-history/${hist!.id}/score`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`)
            .send({ score: 6666158980 });

        const db = await getDatabase();
        const audit = await db.get<{ action: string; details: string }>(
            `SELECT action, details FROM audit_log WHERE action = 'score.correct' ORDER BY id DESC LIMIT 1`,
        );
        expect(audit).toBeTruthy();
        const details = JSON.parse(audit!.details);
        expect(details.from).toBe(66661589860);
        expect(details.to).toBe(6666158980);
    });
});
