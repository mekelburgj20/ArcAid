import { describe, it, expect, beforeEach, vi } from 'vitest';

// Task B's admin-gated guild-members search route delegates to the same
// `searchGuildMembers` resolver the player-facing nominee typeahead uses.
// Mock ONLY that export — everything else in the module stays real.
const searchGuildMembersMock = vi.hoisted(() => vi.fn());
vi.mock('../services/DiscordNicknameResolver.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/DiscordNicknameResolver.js')>();
    return { ...actual, searchGuildMembers: searchGuildMembersMock };
});

// Task C's "you've been added as an admin" DM. Mock ONLY `sendDirectMessage`
// — `resolveDiscordUserId` (used by the resolve-username branch of the
// admins/discord route) and everything else in utils/discord stays real.
const sendDirectMessageMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../utils/discord.js')>();
    return { ...actual, sendDirectMessage: sendDirectMessageMock };
});

import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { IdentityLinkService } from '../services/IdentityLinkService.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';

/**
 * feature/admin-users-card, Task B + Task C.
 *
 * Task B: `GET /:roomId/admin/guild-members/search` — the admin-gated twin of
 * the player-facing nominee typeahead (`GET /:roomId/guild-members/search`,
 * covered by next-win-disposition.test.ts). Same never-500 contract.
 *
 * Task C: `POST /:roomId/admins/discord` now fires a best-effort "you've been
 * added as an admin" DM after a successful grant, wrapped in
 * `trackBackground` so tests must `drainBackgroundTasks()` before asserting
 * on it. Resolution walks the identity-link graph
 * (`BanService.expandIdentityCandidates`) the same cheap way
 * `ScoreReportService.sendBanNotification` does, so a `google:*` grant with a
 * linked Discord alias still finds a DM-able id.
 */
async function createApp() {
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

describe('GET /:roomId/admin/guild-members/search (Task B)', () => {
    beforeEach(async () => {
        await setupTestDb();
        searchGuildMembersMock.mockReset();
        sendDirectMessageMock.mockReset();
    });

    it('401s a tokenless request', async () => {
        const request = (await import('supertest')).default;
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-1', 'AGDS Room 1');

        const res = await request(app).get(`/api/rooms/${roomId}/admin/guild-members/search?q=chuck`);

        expect(res.status).toBe(401);
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('403s a room_admin token scoped to a different room', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-2', 'AGDS Room 2');
        const otherRoomToken = signToken({ role: 'room_admin', gameRoomIds: ['some-other-room'] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${otherRoomToken}`);

        expect(res.status).toBe(403);
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('a query under 2 characters returns empty and never calls the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-3', 'AGDS Room 3');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-agds');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=c`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('no DISCORD_GUILD_ID configured returns empty and never calls the resolver', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-4', 'AGDS Room 4');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
        expect(searchGuildMembersMock).not.toHaveBeenCalled();
    });

    it('happy path maps resolver results through to the response, stripping one leading @', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-5', 'AGDS Room 5');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-agds');
        searchGuildMembersMock.mockResolvedValue([
            { discordUserId: '444455556666777788', displayName: 'ChuckRibbits', username: 'chuckribbits', avatarHash: 'abc123' },
        ]);
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=${encodeURIComponent('@chuck')}`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            members: [
                { discordUserId: '444455556666777788', displayName: 'ChuckRibbits', username: 'chuckribbits', avatarHash: 'abc123' },
            ],
        });
        expect(searchGuildMembersMock).toHaveBeenCalledWith('guild-agds', 'chuck');
    });

    it('a resolver throw degrades to empty members, never a 500', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-6', 'AGDS Room 6');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-agds');
        searchGuildMembersMock.mockRejectedValue(new Error('discord REST blew up'));
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${adminToken}`);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ members: [] });
    });

    it('a super_admin token (no gameRoomIds) can search any room', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('agds-room-7', 'AGDS Room 7');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', 'guild-agds');
        searchGuildMembersMock.mockResolvedValue([]);
        const superToken = signToken({ role: 'super_admin', gameRoomIds: [] });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/guild-members/search?q=chuck`)
            .set('Authorization', `Bearer ${superToken}`);

        expect(res.status).toBe(200);
        expect(searchGuildMembersMock).toHaveBeenCalledWith('guild-agds', 'chuck');
    });
});

describe('POST /:roomId/admins/discord — welcome DM (Task C)', () => {
    beforeEach(async () => {
        await setupTestDb();
        searchGuildMembersMock.mockReset();
        sendDirectMessageMock.mockReset();
        sendDirectMessageMock.mockResolvedValue(true);
    });

    it('DMs a plain Discord id grant with the room name and admin link, wrapped in trackBackground', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('dm-room-1', 'DM Test Room');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admins/discord`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ discord_user_id: '111122223333444455' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });

        // The grant itself must not block on the DM — response lands first,
        // then the fire-and-forget chain is drained.
        await drainBackgroundTasks();

        expect(sendDirectMessageMock).toHaveBeenCalledTimes(1);
        const [dmTarget, message] = sendDirectMessageMock.mock.calls[0];
        expect(dmTarget).toBe('111122223333444455');
        expect(message).toContain('DM Test Room');
        expect(message).toContain(`https://arcaid.app/dm-room-1/admin`);
    });

    it('a google:* grant with NO linked Discord alias never attempts a DM', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('dm-room-2', 'DM Test Room 2');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admins/discord`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ discord_user_id: 'google:unlinked-sub-1' });

        expect(res.status).toBe(200);
        await drainBackgroundTasks();

        expect(sendDirectMessageMock).not.toHaveBeenCalled();
    });

    it('a google:* grant WITH a linked Discord alias DMs the linked Discord id (identity-graph resolution)', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('dm-room-3', 'DM Test Room 3');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
        await IdentityLinkService.createLink('google:linked-sub-1', '999988887777666655');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admins/discord`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ discord_user_id: 'google:linked-sub-1' });

        expect(res.status).toBe(200);
        await drainBackgroundTasks();

        expect(sendDirectMessageMock).toHaveBeenCalledTimes(1);
        expect(sendDirectMessageMock.mock.calls[0][0]).toBe('999988887777666655');
    });

    it('a DM send failure never fails the grant (non-fatal, logged only)', async () => {
        const request = (await import('supertest')).default;
        const { signToken } = await import('../api/auth.js');
        const app = await createApp();
        const roomId = await createTestRoom('dm-room-4', 'DM Test Room 4');
        const adminToken = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
        sendDirectMessageMock.mockRejectedValue(new Error('discord REST blew up'));

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admins/discord`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ discord_user_id: '222233334444555566' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true });
        await drainBackgroundTasks();

        // Grant itself is unaffected — the admin was actually added.
        const db = await getDatabase();
        const row = await db.get(
            'SELECT * FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?',
            roomId, '222233334444555566',
        );
        expect(row).toBeTruthy();
    });
});
