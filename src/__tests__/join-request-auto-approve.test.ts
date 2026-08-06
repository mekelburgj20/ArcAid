import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { IdentityLinkService } from '../services/IdentityLinkService.js';

/**
 * v2.80.0 — AUTO_APPROVE_GUILD_MEMBERS (Identity & membership arc Phase 2,
 * WS1). Mirrors discord-hq.test.ts's fake-`getDiscordClient()` mock pattern
 * — `getDiscordClient()` is the only seam `JoinRequestService.tryAutoApprove`
 * reads through, so swapping its return value is the whole mock surface.
 */

interface FakeClient {
    isMemberOfGuild(guildId: string, userId: string): Promise<boolean>;
}

let fakeClient: FakeClient | null = null;

vi.mock('../discord/DiscordClient.js', () => ({
    getDiscordClient: () => fakeClient,
}));

function gatewayWithMembership(membership: Record<string, string[]>): void {
    fakeClient = {
        isMemberOfGuild: async (guildId, userId) => (membership[guildId] ?? []).includes(userId),
    };
}

function gatewayDown(): void {
    fakeClient = null;
}

const GUILD = 'guild-auto-approve-1';

async function createTestApp() {
    await setupTestDb();
    fakeClient = null;
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function makeAutoApproveRoom(slug: string, opts: { guildId?: string | null; enabled?: boolean } = {}) {
    const roomId = await createTestRoom(slug, 'Auto Approve Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
    if (opts.guildId !== null) {
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', opts.guildId ?? GUILD);
    }
    if (opts.enabled !== false) {
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'true');
    }
    return roomId;
}

async function seedBan(discordUserId: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by) VALUES (?, ?, 'test ban', 'test-admin')`,
        crypto.randomUUID(), discordUserId,
    );
}

async function joinRequest(app: express.Express, roomId: string, discordId: string) {
    return request(app)
        .post(`/api/me/rooms/${roomId}/join-request`)
        .set('Authorization', `Bearer ${playerToken(discordId)}`);
}

describe('AUTO_APPROVE_GUILD_MEMBERS', () => {
    it('guild member -> instant member, approved row with resolved_by=auto:guild, room_members row', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-member');
        const discordId = '100000000000000001';
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('member');

        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(true);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT status, resolved_by, resolved_at FROM join_requests WHERE game_room_id = ? AND user_id = ?`,
            roomId, discordId,
        );
        expect(row.status).toBe('approved');
        expect(row.resolved_by).toBe('auto:guild');
        expect(row.resolved_at).toBeTruthy();
    });

    it('non-member of the guild -> pending, no membership granted', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-nonmember');
        const discordId = '100000000000000002';
        gatewayWithMembership({ [GUILD]: ['999999999999999999'] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(false);
    });

    it('getDiscordClient() returns null (gateway down) -> pending, never denies', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-gateway-down');
        const discordId = '100000000000000003';
        gatewayDown();

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(false);
    });

    it('isMemberOfGuild resolves false -> pending', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-false');
        const discordId = '100000000000000004';
        gatewayWithMembership({}); // empty membership map -> isMemberOfGuild always false

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
    });

    it('unlinked google:* user -> pending (cannot resolve to a Discord id)', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-unlinked-google');
        const googleId = 'google:unlinked-user-1';
        gatewayWithMembership({ [GUILD]: [] });

        const res = await joinRequest(app, roomId, googleId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(await RoomMembershipService.isMember(googleId, roomId)).toBe(false);
    });

    it('linked google:* user resolves via IdentityLinkService to a guild-member Discord id -> member', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-linked-google');
        const googleId = 'google:linked-user-1';
        const discordId = '100000000000000005';
        await IdentityLinkService.createLink(googleId, discordId);
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, googleId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('member');
        // The join_requests row (and membership) stay keyed on the original
        // token id — only the guild membership CHECK uses the resolved id.
        expect(await RoomMembershipService.isMember(googleId, roomId)).toBe(true);
        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(false);
    });

    it('setting absent -> pending (default off)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('aa-setting-absent', 'Setting Absent Room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', GUILD);
        const discordId = '100000000000000006';
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
    });

    it('setting explicitly off -> pending', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-setting-off', { enabled: false });
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'false');
        const discordId = '100000000000000007';
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
    });

    it('no DISCORD_GUILD_ID configured -> pending', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('aa-no-guild', 'No Guild Room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'true');
        const discordId = '100000000000000008';
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
    });

    it('open-policy room still 400s unchanged (auto-approve setting is irrelevant on an open room)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('aa-open-policy');
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'true');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', GUILD);
        const discordId = '100000000000000009';
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(400);
    });

    it('a banned user is still blocked before any auto-approve logic runs', async () => {
        const app = await createTestApp();
        const roomId = await makeAutoApproveRoom('aa-banned');
        const discordId = '100000000000000010';
        await seedBan(discordId);
        gatewayWithMembership({ [GUILD]: [discordId] });

        const res = await joinRequest(app, roomId, discordId);
        expect(res.status).toBe(403);
        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(false);
    });
});
