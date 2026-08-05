import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * WP-C — community-scores attribution must derive from the verified Bearer
 * token (req.user.discordId), never from the request body. Pre-fix, the
 * handler destructured `discord_user_id` straight out of the validated body
 * and handed it to CommunityScoreService.submitScore — any guest could
 * attribute a score (and its global fan-out) to an arbitrary Discord user.
 *
 * Bootstrap pattern copied from s11-trust-safety.test.ts / room-scores.test.ts:
 * mount rooms.ts at /api/rooms against a fresh setupTestDb() per test.
 */
async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function playerToken(discordId: string, username: string, roomId: string) {
    return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
}

// ensurePlatformAllowed must pass so the handler reaches the submit logic —
// an approved catalogue row exposing the 'real' platform satisfies it (same
// setup as s11-trust-safety.test.ts's "submit-score rejects a spoofed..." test).
async function seedPlatformForGame(gameName: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        crypto.randomUUID(), gameName, JSON.stringify(['real']),
    );
}

describe('POST /api/rooms/:roomId/community-scores/:gameName — attribution security', () => {
    // v2.79.0 (login mandate) — the route now sits behind requireDiscordUser,
    // so a tokenless guest POST (spoofed discord_user_id or not) never even
    // reaches the handler; it 401s before any row is written. The spoofed-id
    // scenario this test used to cover is exercised authed in (b)/(c) below.
    it('(a) a tokenless POST 401s, even with a spoofed discord_user_id in the body, and writes no row', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('wpc-guest', 'WPC Guest');
        const gameName = 'Guest Game';
        await seedPlatformForGame(gameName);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .send({ username: 'Guesty', score: 1000, platform: 'real', engine: 'real', device: 'real_cabinet', discord_user_id: 'someone-elses-id' });

        expect(res.status).toBe(401);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT id FROM community_scores WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row).toBeFalsy();

        const globalRow = await db.get(
            `SELECT id FROM global_scores WHERE player_id = ?`,
            'someone-elses-id',
        );
        expect(globalRow).toBeFalsy();
    });

    it('(b) authed POST attributes to the TOKEN identity even when the body tries to spoof a different one', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('wpc-authed', 'WPC Authed');
        const gameName = 'Authed Game';
        await seedPlatformForGame(gameName);

        const token = playerToken('DREAL', 'RealPlayer', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ username: 'RealPlayer', score: 2000, platform: 'real', engine: 'real', device: 'real_cabinet', discord_user_id: 'DATTACKER' });

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT discord_user_id, submitted_by_user_id FROM community_scores
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row).toBeTruthy();
        expect(row.discord_user_id).toBe('DREAL');
        expect(row.submitted_by_user_id).toBe('DREAL');
        expect(row.discord_user_id).not.toBe('DATTACKER');
        expect(row.submitted_by_user_id).not.toBe('DATTACKER');
    });

    it('(c) authed POST without any discord_user_id in the body still attributes from the token (non-regression)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('wpc-authed-noattr', 'WPC Authed No Attr');
        const gameName = 'Authed No Attr Game';
        await seedPlatformForGame(gameName);

        const token = playerToken('DREAL2', 'RealPlayer2', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .send({ username: 'RealPlayer2', score: 3000, platform: 'real', engine: 'real', device: 'real_cabinet' });

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT discord_user_id, submitted_by_user_id FROM community_scores
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(row).toBeTruthy();
        expect(row.discord_user_id).toBe('DREAL2');
        expect(row.submitted_by_user_id).toBe('DREAL2');
    });
});
