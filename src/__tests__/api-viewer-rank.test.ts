import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

// S4: "Your best — Rank #N" viewer-rank revival. GET /:roomId/leaderboard
// annotates each board with `viewerEntry` for the logged-in player. The fix
// resolves the viewer across their discord_user_id AND all mapped aliases, to
// match the same partition the leaderboard collapses by — pre-S4 it matched one
// arbitrary alias, so multi-alias users saw no rank.

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const playerToken = (discordId: string, username = 'someone') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

describe('S4 — leaderboard viewerEntry (Your best — Rank #N)', () => {
    it('annotates viewerEntry via discord_user_id for a Discord-submitted score', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('vr-disc', 'VR Disc');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Medieval Madness' });
        await createTestSubmission(gameId, { username: 'Ace', discordUserId: 'disc-1', score: 9000 });
        await createTestSubmission(gameId, { username: 'Rival', discordUserId: 'disc-2', score: 4000 });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${playerToken('disc-1', 'Ace')}`);

        expect(res.status).toBe(200);
        const board = res.body.find((b: any) => b.gameName === 'Medieval Madness');
        expect(board).toBeTruthy();
        expect(board.viewerEntry).toBeTruthy();
        expect(board.viewerEntry.iscored_username).toBe('Ace');
        expect(board.viewerEntry.score).toBe(9000);
    });

    it('finds viewerEntry for a MULTI-ALIAS user whose row is under a different alias', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const roomId = await createTestRoom('vr-multi', 'VR Multi');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Attack from Mars' });
        // disc-9 holds two aliases; their score is under the SECOND one ("Bob").
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-9', 'Ace9')`);
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES ('disc-9', 'Bob9')`);
        await createTestSubmission(gameId, { username: 'Bob9', score: 7777 });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            // token username is the OTHER alias — pre-S4 the arbitrary single-alias
            // lookup could pick "Ace9" and miss the "Bob9" row entirely.
            .set('Authorization', `Bearer ${playerToken('disc-9', 'Ace9')}`);

        expect(res.status).toBe(200);
        const board = res.body.find((b: any) => b.gameName === 'Attack from Mars');
        expect(board).toBeTruthy();
        expect(board.viewerEntry).toBeTruthy();
        expect(board.viewerEntry.iscored_username).toBe('Bob9');
    });

    it('returns no viewerEntry for an anonymous viewer (no token)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('vr-anon', 'VR Anon');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Twilight Zone' });
        await createTestSubmission(gameId, { username: 'Ace', score: 5000 });

        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);

        expect(res.status).toBe(200);
        const board = res.body.find((b: any) => b.gameName === 'Twilight Zone');
        expect(board).toBeTruthy();
        expect(board.viewerEntry).toBeUndefined();
    });
});
