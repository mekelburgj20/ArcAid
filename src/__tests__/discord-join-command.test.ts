import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { BanService } from '../services/BanService.js';
import { join } from '../discord/commands/join.js';

// ---------------------------------------------------------------------------
// `/join` (v2.222.0, E12) — join the room(s) linked to the invoking server.
// Mirrors the web self-join route branch for branch; the Discord gateway is
// faked through `getDiscordClient()`, the only seam JoinRequestService reads.
// ---------------------------------------------------------------------------

interface FakeClient {
    isMemberOfGuild(guildId: string, userId: string): Promise<boolean>;
    getMemberRoleIds(guildId: string, userId: string): Promise<string[] | null>;
    listGuildRoles(guildId: string): Array<{ id: string; name: string; position: number; managed: boolean }>;
}

let fakeClient: FakeClient | null = null;

vi.mock('../discord/DiscordClient.js', () => ({
    getDiscordClient: () => fakeClient,
}));

const GUILD = '910000000000000001';
const GUILD_UNLINKED = '910000000000000002';
const ROLE_VPX = '810000000000000001';
const ROLE_OTHER = '810000000000000002';
const ME = '710000000000000001';

/** `roles`: guild member id -> role ids. A user absent from the map is "member not found". */
function gateway(roles: Record<string, string[]>): void {
    fakeClient = {
        isMemberOfGuild: async (_g, userId) => userId in roles,
        getMemberRoleIds: async (g, userId) => (g === GUILD && userId in roles ? roles[userId] : null),
        listGuildRoles: () => [
            { id: ROLE_VPX, name: 'VPX Player', position: 3, managed: false },
            { id: ROLE_OTHER, name: 'Lurker', position: 1, managed: false },
        ],
    };
}

function makeInteraction(guildId: string | null, userId = ME) {
    const replies: unknown[] = [];
    const deferred: unknown[] = [];
    const interaction = {
        user: { id: userId, tag: `${userId}#0000`, displayName: userId },
        guildId,
        options: { getString: () => null, getUser: () => null },
        deferReply: async (payload: unknown) => { deferred.push(payload); },
        editReply: async (payload: unknown) => { replies.push(payload); return payload; },
        reply: async (payload: unknown) => { replies.push(payload); return payload; },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    return { interaction, replies, deferred };
}

const replyText = (replies: unknown[]) => JSON.stringify(replies);

async function linkedRoom(slug: string, name: string, policy?: 'open' | 'approval' | 'discord_role') {
    const roomId = await createTestRoom(slug, name);
    await GameRoomSettingsService.set(roomId, 'DISCORD_GUILD_ID', GUILD);
    if (policy) await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', policy);
    return roomId;
}

async function pendingRow(roomId: string, userId: string) {
    const db = await getDatabase();
    return db.get(`SELECT status FROM join_requests WHERE game_room_id = ? AND user_id = ? AND status = 'pending'`, roomId, userId);
}

describe('/join (E12)', () => {
    beforeEach(async () => {
        await setupTestDb();
        fakeClient = null;
        BanService.clearCache();
    });
    afterEach(() => { fakeClient = null; });

    it('carries no default member permission', () => {
        const json = join.data.toJSON() as { name: string; default_member_permissions?: string | null };
        expect(json.name).toBe('join');
        expect(json.default_member_permissions ?? null).toBeNull();
    });

    it('refuses in a DM', async () => {
        const { interaction, replies } = makeInteraction(null);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/only works inside a server/i);
    });

    it('says no room is linked when the guild maps to nothing', async () => {
        await linkedRoom('join-elsewhere', 'Elsewhere', 'open');
        const { interaction, replies } = makeInteraction(GUILD_UNLINKED);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/No Arcaid room is linked to this Discord server/);
    });

    it('drops a Discord-off room from the list', async () => {
        const roomId = await linkedRoom('join-off', 'Off Room', 'open');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/No Arcaid room is linked/);
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(false);
    });

    it('joins an open room at once and links its page', async () => {
        const roomId = await linkedRoom('join-open', 'Open Room', 'open');
        const { interaction, replies, deferred } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(deferred).toHaveLength(1);
        expect(replyText(replies)).toContain('Joined **Open Room**');
        expect(replyText(replies)).toContain('/join-open/');
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(true);
    });

    it('a room with no JOIN_POLICY reads as open', async () => {
        const roomId = await linkedRoom('join-default', 'Default Room');
        const { interaction } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(true);
    });

    it('says already a member when the row exists', async () => {
        const roomId = await linkedRoom('join-member', 'Member Room', 'open');
        await RoomMembershipService.addMember(ME, roomId, 'self_join');
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/already a member of \*\*Member Room\*\*/);
    });

    it('refuses a suspended room with the web wording', async () => {
        const roomId = await linkedRoom('join-susp', 'Suspended Room', 'open');
        const db = await getDatabase();
        await db.run(`UPDATE game_rooms SET suspended_at = datetime('now') WHERE id = ?`, roomId);
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/suspended pending review/);
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(false);
    });

    it('refuses a banned user neutrally and writes nothing', async () => {
        const roomId = await linkedRoom('join-banned', 'Banned Room', 'open');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_bans (id, discord_user_id, reason, banned_by) VALUES (?, ?, 'test ban', 'admin-1')`,
            'ban-join-1', ME,
        );
        BanService.clearCache();
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toContain("You can't join **Banned Room**.");
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(false);
    });

    it('approval room files a pending request', async () => {
        const roomId = await linkedRoom('join-approval', 'Approval Room', 'approval');
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/Request sent to \*\*Approval Room\*\*'s admins/);
        expect(await pendingRow(roomId, ME)).toBeTruthy();
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(false);
    });

    it('approval room with AUTO_APPROVE_GUILD_MEMBERS auto-approves a guild member', async () => {
        const roomId = await linkedRoom('join-auto', 'Auto Room', 'approval');
        await GameRoomSettingsService.set(roomId, 'AUTO_APPROVE_GUILD_MEMBERS', 'true');
        gateway({ [ME]: [] });
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toMatch(/Joined \*\*Auto Room\*\* — you were auto-approved/);
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(true);
    });

    it('discord_role room admits a holder of the role', async () => {
        const roomId = await linkedRoom('join-role', 'Role Room', 'discord_role');
        await GameRoomSettingsService.set(roomId, 'DISCORD_JOIN_ROLE_IDS', JSON.stringify([ROLE_VPX]));
        gateway({ [ME]: [ROLE_VPX] });
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        expect(replyText(replies)).toContain('Joined **Role Room**');
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(true);
    });

    it('discord_role room refuses a member without the role, naming the role (never its id)', async () => {
        const roomId = await linkedRoom('join-norole', 'No Role Room', 'discord_role');
        await GameRoomSettingsService.set(roomId, 'DISCORD_JOIN_ROLE_IDS', JSON.stringify([ROLE_VPX]));
        gateway({ [ME]: [ROLE_OTHER] });
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        const text = replyText(replies);
        expect(text).toContain('VPX Player');
        expect(text).not.toContain(ROLE_VPX);
        expect(text).toMatch(/can join \*\*No Role Room\*\*/);
        expect(await RoomMembershipService.isMember(ME, roomId)).toBe(false);
    });

    it('answers one line per room when several rooms share the guild', async () => {
        await linkedRoom('join-multi-a', 'Alpha Room', 'open');
        await linkedRoom('join-multi-b', 'Beta Room', 'approval');
        const { interaction, replies } = makeInteraction(GUILD);
        await join.execute(interaction);
        const last = replies[replies.length - 1] as string;
        const lines = last.split('\n');
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('Joined **Alpha Room**');
        expect(lines[1]).toMatch(/Request sent to \*\*Beta Room\*\*/);
    });
});
