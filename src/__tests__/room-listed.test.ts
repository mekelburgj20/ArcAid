import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { signToken } from '../api/auth.js';

// v2.80.0 — ROOM_LISTED (unlisted rooms). Default-on idiom: absent/'true'
// stays listed on the public landing-page room list, only an explicit
// 'false' drops it. The room is still reachable by anyone with the direct
// URL (GET /api/portal?slug=) and still shown to its own members
// (GET /api/me/rooms, which reads room_members, not this endpoint) — only
// GET /api/rooms (the unauthenticated landing-page listing) filters.

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

describe('GET /api/rooms — ROOM_LISTED filter', () => {
    it('drops a room with ROOM_LISTED=false entirely from the response', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rl-unlisted', 'Unlisted Room');
        await GameRoomSettingsService.set(roomId, 'ROOM_LISTED', 'false');

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        expect(res.body.find((r: any) => r.id === roomId)).toBeUndefined();
    });

    it('keeps a room with no ROOM_LISTED row (default-on)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rl-default', 'Default Room');

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        expect(res.body.find((r: any) => r.id === roomId)).toBeDefined();
    });

    it('keeps a room with ROOM_LISTED=true (explicit)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rl-explicit-true', 'Explicit Listed Room');
        await GameRoomSettingsService.set(roomId, 'ROOM_LISTED', 'true');

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        expect(res.body.find((r: any) => r.id === roomId)).toBeDefined();
    });

    it('an unlisted room is still resolvable via GET /api/portal?slug=', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rl-portal', 'Portal Reachable Room');
        await GameRoomSettingsService.set(roomId, 'ROOM_LISTED', 'false');

        const res = await request(app).get('/api/portal').query({ slug: 'rl-portal' });
        expect(res.status).toBe(200);
        expect(res.body.id).toBe(roomId);
    });

    it('a member still sees their unlisted room in GET /api/me/rooms', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rl-member', 'Member Visible Unlisted Room');
        await GameRoomSettingsService.set(roomId, 'ROOM_LISTED', 'false');
        const discordId = 'discord-rl-member-1';
        await RoomMembershipService.addMember(discordId, roomId, 'self_join');

        const res = await request(app)
            .get('/api/me/rooms')
            .set('Authorization', `Bearer ${playerToken(discordId)}`);
        expect(res.status).toBe(200);
        expect(res.body.find((r: any) => r.roomId === roomId)).toBeDefined();
    });
});
