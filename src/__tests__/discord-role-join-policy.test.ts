import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { IdentityLinkService } from '../services/IdentityLinkService.js';
import { RoomAccessService, parseJoinRoleIds, formatRoleList } from '../services/RoomAccessService.js';

/**
 * v2.213.0 - JOIN_POLICY='discord_role' ("open to view, Discord role to
 * join"), the DISCORD_JOIN_ROLE_IDS filter on approval-room auto-approve, and
 * the room write gate `RoomAccessService.checkMayWrite`. The Discord client is
 * faked through `getDiscordClient()`, the only seam these paths read through.
 */

interface FakeClient {
    isMemberOfGuild(guildId: string, userId: string): Promise<boolean>;
    getMemberRoleIds(guildId: string, userId: string): Promise<string[] | null>;
    listGuildRoles(guildId: string): Array<{ id: string; name: string; position: number; managed: boolean }>;
}

let fakeClient: FakeClient | null = null;

vi.mock('../discord/DiscordClient.js', () => ({
    getDiscordClient: () => fakeClient,
}));

const GUILD = '900000000000000001';
const ROLE_VPX = '800000000000000001';
const ROLE_MOD = '800000000000000002';
const ROLE_OTHER = '800000000000000003';

/** `roles`: guild member id -> role ids. A user absent from the map is
 * "member not found" (unknown). */
function gateway(roles: Record<string, string[]>): void {
    fakeClient = {
        isMemberOfGuild: async (_g, userId) => userId in roles,
        getMemberRoleIds: async (g, userId) => (g === GUILD && userId in roles ? roles[userId] : null),
        listGuildRoles: () => [
            { id: ROLE_VPX, name: 'VPX Player', position: 3, managed: false },
            { id: ROLE_MOD, name: 'Moderator', position: 5, managed: false },
            { id: ROLE_OTHER, name: 'Lurker', position: 1, managed: false },
        ],
    };
}

async function createTestApp() {
    await setupTestDb();
    fakeClient = null;
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

function playerToken(id: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId: id, username: 'Tester' });
}

async function makeRoleRoom(slug: string, roleIds: string[] = [ROLE_VPX, ROLE_MOD]) {
    const roomId = await createTestRoom(slug, 'Mox Test Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'discord_role');
    await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', GUILD);
    if (roleIds.length) await GameRoomSettingsService.set(roomId, 'DISCORD_JOIN_ROLE_IDS', JSON.stringify(roleIds));
    return roomId;
}

async function join(app: express.Express, roomId: string, userId: string) {
    return request(app).post(`/api/me/rooms/${roomId}`).set('Authorization', `Bearer ${playerToken(userId)}`);
}

async function pendingRow(roomId: string, userId: string) {
    const db = await getDatabase();
    return db.get(`SELECT status FROM join_requests WHERE game_room_id = ? AND user_id = ? AND status = 'pending'`, roomId, userId);
}

describe('getJoinPolicy / parseJoinRoleIds', () => {
    it('reads all three values; anything else is open', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('jp-parse', 'Parse Room');
        expect(await RoomAccessService.getJoinPolicy(roomId)).toBe('open');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        expect(await RoomAccessService.getJoinPolicy(roomId)).toBe('approval');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'discord_role');
        expect(await RoomAccessService.getJoinPolicy(roomId)).toBe('discord_role');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'bogus');
        expect(await RoomAccessService.getJoinPolicy(roomId)).toBe('open');
    });

    it('parses a JSON array of ids, dropping junk and duplicates', () => {
        expect(parseJoinRoleIds(null)).toEqual([]);
        expect(parseJoinRoleIds('not json')).toEqual([]);
        expect(parseJoinRoleIds('{"a":1}')).toEqual([]);
        expect(parseJoinRoleIds(`["${ROLE_VPX}", "x", "${ROLE_VPX}", " ${ROLE_MOD} "]`)).toEqual([ROLE_VPX, ROLE_MOD]);
    });

    it('formats role lists', () => {
        expect(formatRoleList(['A'])).toBe('"A"');
        expect(formatRoleList(['A', 'B', 'C'])).toBe('"A", "B" or "C"');
    });

    it('a discord_role room is viewable like an open one', async () => {
        await setupTestDb();
        const roomId = await makeRoleRoom('jp-view');
        const policy = await RoomAccessService.getJoinPolicy(roomId);
        // roomVisibilityGate / websocket only gate on 'approval'.
        expect(policy).not.toBe('approval');
    });
});

describe('self-join on a discord_role room', () => {
    it('role held -> member', async () => {
        const app = await createTestApp();
        const roomId = await makeRoleRoom('dr-held');
        const userId = '100000000000000101';
        gateway({ [userId]: [ROLE_OTHER, ROLE_MOD] });

        const res = await join(app, roomId, userId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('member');
        expect(await RoomMembershipService.isMember(userId, roomId)).toBe(true);
    });

    it('member fetched, role NOT held -> 403 ROLE_REQUIRED naming the roles, nothing written', async () => {
        const app = await createTestApp();
        const roomId = await makeRoleRoom('dr-missing');
        const userId = '100000000000000102';
        gateway({ [userId]: [ROLE_OTHER] });

        const res = await join(app, roomId, userId);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROLE_REQUIRED');
        expect(res.body.error).toContain('VPX Player');
        expect(res.body.error).toContain('Moderator');
        expect(await RoomMembershipService.isMember(userId, roomId)).toBe(false);
        expect(await pendingRow(roomId, userId)).toBeFalsy();
    });

    it('unknown (bot down / member not found) -> pending join request, never a deny', async () => {
        const app = await createTestApp();
        const roomId = await makeRoleRoom('dr-unknown');
        const userId = '100000000000000103';
        fakeClient = null;

        const res = await join(app, roomId, userId);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
        expect(await RoomMembershipService.isMember(userId, roomId)).toBe(false);
        expect(await pendingRow(roomId, userId)).toBeTruthy();

        // A user the guild fetch cannot find is unknown too.
        const other = '100000000000000104';
        gateway({});
        const res2 = await join(app, roomId, other);
        expect(res2.body.status).toBe('pending');
    });

    it('a Google login with no Discord identity -> 403 DISCORD_LINK_REQUIRED', async () => {
        const app = await createTestApp();
        const roomId = await makeRoleRoom('dr-google');
        gateway({});
        const res = await join(app, roomId, 'google:abc123');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('DISCORD_LINK_REQUIRED');
    });

    it('a Google login linked to Discord is checked through the Discord id', async () => {
        const app = await createTestApp();
        const roomId = await makeRoleRoom('dr-google-linked');
        const discordId = '100000000000000105';
        await IdentityLinkService.createLink('google:linked1', discordId);
        gateway({ [discordId]: [ROLE_VPX] });

        const res = await join(app, roomId, 'google:linked1');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('member');
    });
});

describe('approval + auto-approve + DISCORD_JOIN_ROLE_IDS', () => {
    async function makeApprovalRoom(slug: string, roleIds: string[]) {
        const roomId = await createTestRoom(slug, 'Approval Roles Room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', GUILD);
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'true');
        if (roleIds.length) await GameRoomSettingsService.set(roomId, 'DISCORD_JOIN_ROLE_IDS', JSON.stringify(roleIds));
        return roomId;
    }
    const requestJoin = (app: express.Express, roomId: string, id: string) =>
        request(app).post(`/api/me/rooms/${roomId}/join-request`).set('Authorization', `Bearer ${playerToken(id)}`);

    it('role holder is auto-approved; a guild member without the role waits', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('ar-roles', [ROLE_VPX]);
        const holder = '100000000000000201';
        const plain = '100000000000000202';
        gateway({ [holder]: [ROLE_VPX], [plain]: [ROLE_OTHER] });

        expect((await requestJoin(app, roomId, holder)).body.status).toBe('member');
        expect((await requestJoin(app, roomId, plain)).body.status).toBe('pending');
        expect(await RoomMembershipService.isMember(plain, roomId)).toBe(false);
    });

    it('an empty role list keeps any-guild-member auto-approval', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('ar-noroles', []);
        const plain = '100000000000000203';
        gateway({ [plain]: [] });
        expect((await requestJoin(app, roomId, plain)).body.status).toBe('member');
    });
});

describe('RoomAccessService.checkMayWrite', () => {
    it('open room: anyone passes', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('wg-open', 'Open Room');
        expect((await RoomAccessService.checkMayWrite(roomId, '100000000000000301')).ok).toBe(true);
    });

    it('null room (Throwdown) is never gated', async () => {
        await setupTestDb();
        expect((await RoomAccessService.checkMayWrite(null, '100000000000000302')).ok).toBe(true);
    });

    it('discord_role room: non-member refused JOIN_REQUIRED naming the room and roles; member passes', async () => {
        await setupTestDb();
        gateway({});
        const roomId = await makeRoleRoom('wg-role');
        const userId = '100000000000000303';

        const refused = await RoomAccessService.checkMayWrite(roomId, userId);
        expect(refused.ok).toBe(false);
        if (!refused.ok) {
            expect(refused.code).toBe('JOIN_REQUIRED');
            expect(refused.message).toContain('Mox Test Room');
            expect(refused.message).toContain('VPX Player');
        }

        await RoomMembershipService.addMember(userId, roomId, 'self_join');
        expect((await RoomAccessService.checkMayWrite(roomId, userId)).ok).toBe(true);
    });

    it('approval room: non-member refused; super admin and room-admin tokens pass', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('wg-approval', 'Approval Room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const userId = '100000000000000304';
        expect((await RoomAccessService.checkMayWrite(roomId, userId)).ok).toBe(false);
        expect((await RoomAccessService.checkMayWrite(roomId, userId,
            { role: 'super_admin', gameRoomIds: [] } as never)).ok).toBe(true);
        expect((await RoomAccessService.checkMayWrite(roomId, userId,
            { role: 'room_admin', gameRoomIds: [roomId] } as never)).ok).toBe(true);
    });
});
