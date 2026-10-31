import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { GameRoomService } from '../services/GameRoomService.js';

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

// "Listed on Arcaid" (ROOM_LISTED) is the ONE listing switch; is_public
// mirrors it. arcaid_witness_demo (2026-10-30) was created private, so its
// owner's toggle read "on" while the room stayed off the landing page.
describe('ROOM_LISTED is the only listing switch', () => {
    async function roomsApp() {
        const a = express();
        a.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        a.use('/api/rooms', roomsRouter);
        a.use('/api', globalRouter);
        return a;
    }
    const adminToken = (roomId: string) =>
        signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'ra', discordId: '111' } as never);
    const listed = async (a: express.Express, roomId: string) =>
        (await request(a).get('/api/rooms')).body.some((r: any) => r.id === roomId);

    it("the owner's toggle lists a room that is_public had hidden", async () => {
        await setupTestDb();
        const a = await roomsApp();
        const roomId = await createTestRoom('rl-owner', 'Owner Room');
        const db = await getDatabase();
        await db.run('UPDATE game_rooms SET is_public = 0 WHERE id = ?', roomId);
        expect(await listed(a, roomId)).toBe(false);

        const res = await request(a).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ ROOM_LISTED: 'true' });
        expect(res.status).toBe(200);
        expect(await listed(a, roomId)).toBe(true);

        await request(a).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ ROOM_LISTED: 'false' });
        expect(await listed(a, roomId)).toBe(false);
        expect((await GameRoomService.getById(roomId))!.is_public).toBe(0);
    });

    it('a save that does not touch ROOM_LISTED leaves is_public alone', async () => {
        await setupTestDb();
        const a = await roomsApp();
        const roomId = await createTestRoom('rl-untouched', 'Untouched Room');
        const db = await getDatabase();
        await db.run('UPDATE game_rooms SET is_public = 0 WHERE id = ?', roomId);
        await request(a).post(`/api/rooms/${roomId}/settings`)
            .set('Authorization', `Bearer ${adminToken(roomId)}`).send({ KIOSK_ZOOM: '100' });
        expect((await GameRoomService.getById(roomId))!.is_public).toBe(0);
    });

    it('creating a private room stores the toggle off', async () => {
        await setupTestDb();
        const room = await GameRoomService.create({ name: 'Private', slug: 'rl_private', is_public: false });
        expect(await GameRoomSettingsService.get(room.id, 'ROOM_LISTED')).toBe('false');
        const pub = await GameRoomService.create({ name: 'Public', slug: 'rl_public' });
        expect(await GameRoomSettingsService.get(pub.id, 'ROOM_LISTED')).toBeNull();
    });

    it('a super-admin is_public edit moves the toggle with it', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('rl-super', 'Super Room');
        await GameRoomService.update(roomId, { is_public: false });
        expect(await GameRoomSettingsService.get(roomId, 'ROOM_LISTED')).toBe('false');
        await GameRoomService.update(roomId, { is_public: true });
        expect(await GameRoomSettingsService.get(roomId, 'ROOM_LISTED')).toBe('true');
    });

    it('migration 201 keeps a never-toggled private room hidden and honours a saved toggle', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const untouched = await createTestRoom('rl-m-untouched', 'Untouched');
        const ownerOn = await createTestRoom('rl-m-on', 'Owner On');
        const ownerOff = await createTestRoom('rl-m-off', 'Owner Off');
        const plain = await createTestRoom('rl-m-plain', 'Plain');
        await db.run('UPDATE game_rooms SET is_public = 0 WHERE id IN (?, ?)', untouched, ownerOn);
        await GameRoomSettingsService.set(ownerOn, 'ROOM_LISTED', 'true');
        await GameRoomSettingsService.set(ownerOff, 'ROOM_LISTED', 'false');
        const { roomListedSingleSwitch } = await import('../database/migrations/roomListedSingleSwitch.js');
        await roomListedSingleSwitch(db);

        const pub = async (id: string) => (await GameRoomService.getById(id))!.is_public;
        expect(await pub(untouched)).toBe(0);
        expect(await GameRoomSettingsService.get(untouched, 'ROOM_LISTED')).toBe('false');
        expect(await pub(ownerOn)).toBe(1);
        expect(await pub(ownerOff)).toBe(0);
        expect(await pub(plain)).toBe(1);
        expect(await GameRoomSettingsService.get(plain, 'ROOM_LISTED')).toBeNull();
    });
});
