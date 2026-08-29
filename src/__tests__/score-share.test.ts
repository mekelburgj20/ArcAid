import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';

/**
 * v2.147.0 — GET /:roomId/score-share/:historyId.
 *
 * Public payload endpoint backing the per-score Share button's deep link
 * (`/:slug/games/:gameName?score=<historyId>`) and the FE's on-load fetch that
 * opens the photo modal for it. Same visibility rule as every other public
 * score read (`roomVisibilityGate`, mounted once in rooms.ts) — covered here
 * only for the approval-room case; the open-room byte-identical cases live in
 * room-visibility-gate.test.ts and aren't re-derived per route.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function insertScoreHistory(roomId: string, opts: {
    gameName: string; username: string; score: number;
    photoUrl?: string | null; discordUserId?: string | null; submittedByUserId?: string | null;
}) {
    const db = await getDatabase();
    const result = await db.run(
        `INSERT INTO score_history
            (game_name, game_room_id, iscored_username, score, photo_url, discord_user_id, submitted_by_user_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'tournament')`,
        opts.gameName, roomId, opts.username, opts.score,
        opts.photoUrl ?? null, opts.discordUserId ?? null, opts.submittedByUserId ?? null,
    );
    return result.lastID as number;
}

describe('GET /:roomId/score-share/:historyId', () => {
    it('returns the share payload with the raw iscored_username when no profile is linked', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-1');
        const historyId = await insertScoreHistory(roomId, {
            gameName: 'Medieval Madness', username: 'Ada', score: 1234567,
            photoUrl: '/api/score-photos/room/ada.jpg',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/score-share/${historyId}`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            historyId,
            gameName: 'Medieval Madness',
            score: 1234567,
            createdAt: expect.any(String),
            photoUrl: '/api/score-photos/room/ada.jpg',
            playerName: 'Ada',
            iscoredUsername: 'Ada',
        });
    });

    it('resolves display_name per the doctrine: submitted_by_user_id -> user_profiles', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-2');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('disc-ada', 'The Real Ada')`,
        );
        const historyId = await insertScoreHistory(roomId, {
            gameName: 'Whirlwind', username: 'ada_iscored', score: 500,
            discordUserId: 'disc-ada', submittedByUserId: 'disc-ada',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/score-share/${historyId}`);
        expect(res.status).toBe(200);
        expect(res.body.playerName).toBe('The Real Ada');
        expect(res.body.iscoredUsername).toBe('ada_iscored');
        expect(res.body.photoUrl).toBeNull();
    });

    it('resolves display_name for a synced row via the user_mappings iscored:* fallback', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-3');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-ben', 'Ben')`,
        );
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES ('disc-ben', 'Big Ben')`,
        );
        const historyId = await insertScoreHistory(roomId, {
            gameName: 'Taxi', username: 'Ben', score: 900, discordUserId: 'iscored:Ben',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/score-share/${historyId}`);
        expect(res.status).toBe(200);
        expect(res.body.playerName).toBe('Big Ben');
    });

    it('404s for a missing id', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-4');
        const res = await request(app).get(`/api/rooms/${roomId}/score-share/999999`);
        expect(res.status).toBe(404);
    });

    it('404s for a non-numeric id', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-5');
        const res = await request(app).get(`/api/rooms/${roomId}/score-share/not-a-number`);
        expect(res.status).toBe(404);
    });

    it('404s when the row belongs to a different room', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('share-room-6a');
        const roomB = await createTestRoom('share-room-6b');
        const historyId = await insertScoreHistory(roomA, { gameName: 'Taxi', username: 'Ada', score: 100 });

        const res = await request(app).get(`/api/rooms/${roomB}/score-share/${historyId}`);
        expect(res.status).toBe(404);
    });

    it('403s with APPROVAL_REQUIRED on an approval-policy room (no auth)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('share-room-approval');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const historyId = await insertScoreHistory(roomId, { gameName: 'Taxi', username: 'Ada', score: 100 });

        const res = await request(app).get(`/api/rooms/${roomId}/score-share/${historyId}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');
    });
});
