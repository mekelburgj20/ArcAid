import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { BanService } from '../services/BanService.js';
import { ScoreReportService } from '../services/ScoreReportService.js';
import { SubmissionDraftService } from '../services/SubmissionDraftService.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { AdminService } from '../services/AdminService.js';
import { AuditService } from '../services/AuditService.js';
import { JoinRequestService } from '../services/JoinRequestService.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { RoomRosterService } from '../services/RoomRosterService.js';

/**
 * v2.49.0 — room-tier bans (tmp/room-bans-contract.md, Workstream 1) + the
 * admin-facing name-resolution follow-up (Workstream 2, AdminService slice).
 *
 * `ban-enforcement.test.ts` (v2.47.0) already covers the GLOBAL ban shape in
 * depth — cache, identity-link expansion, `requireNotBanned` route gating.
 * This file covers what's NEW: the `game_room_id` scoping dimension on top
 * of that existing machinery.
 */

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: usersRouter } = await import('../api/routes/users.js');
    app.use('/api/rooms', roomsRouter);
    app.use('/api/users', usersRouter);
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

function roomAdminToken(discordId: string, roomIds: string[]) {
    return signToken({ role: 'room_admin', gameRoomIds: roomIds, discordId, username: 'RoomAdmin' });
}

function superToken(discordId = 'super-admin-1') {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId, username: 'Super' });
}

async function seedBan(
    discordUserId: string,
    opts: { gameRoomId?: string | null; expiresAt?: string | null; liftedAt?: string | null } = {},
): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by, expires_at, lifted_at, game_room_id)
         VALUES (?, ?, 'test ban', 'test-admin', ?, ?, ?)`,
        id, discordUserId, opts.expiresAt ?? null, opts.liftedAt ?? null, opts.gameRoomId ?? null,
    );
    return id;
}

describe('BanService.isIdentityBanned — room scoping', () => {
    it('a room-scoped ban blocks that room but not another room', async () => {
        await setupTestDb();
        const roomA = 'room-a';
        const roomB = 'room-b';
        await seedBan('discord-room-ban-1', { gameRoomId: roomA });

        expect((await BanService.isIdentityBanned('discord-room-ban-1', roomA)).banned).toBe(true);
        expect((await BanService.isIdentityBanned('discord-room-ban-1', roomB)).banned).toBe(false);
    });

    it('a room-scoped ban does NOT bite the global-only check (no room passed)', async () => {
        await setupTestDb();
        await seedBan('discord-room-ban-2', { gameRoomId: 'room-x' });
        expect((await BanService.isIdentityBanned('discord-room-ban-2')).banned).toBe(false);
    });

    it('a global ban (game_room_id NULL) still bites inside every room', async () => {
        await setupTestDb();
        await seedBan('discord-global-ban-1'); // no gameRoomId -> global
        expect((await BanService.isIdentityBanned('discord-global-ban-1', 'any-room')).banned).toBe(true);
        expect((await BanService.isIdentityBanned('discord-global-ban-1', 'another-room')).banned).toBe(true);
        expect((await BanService.isIdentityBanned('discord-global-ban-1')).banned).toBe(true);
    });

    it('a room ban on a linked google alias catches the canonical discord id inside that room', async () => {
        await setupTestDb();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:room-link-a', 'discord-room-link-canonical-a',
        );
        await seedBan('google:room-link-a', { gameRoomId: 'room-link-test' });

        const result = await BanService.isIdentityBanned('discord-room-link-canonical-a', 'room-link-test');
        expect(result.banned).toBe(true);
        // Different room -> not banned, even via the link.
        expect((await BanService.isIdentityBanned('discord-room-link-canonical-a', 'other-room')).banned).toBe(false);
    });

    it('composite cache key: room-scoped and global-only checks for the same id cache independently', async () => {
        await setupTestDb();
        BanService.clearCacheForTests();
        const id = 'discord-room-cache-1';
        const roomId = 'room-cache-test';

        // Prime the GLOBAL cache entry as "not banned".
        const globalFirst = await BanService.isIdentityBanned(id);
        expect(globalFirst.banned).toBe(false);

        // Now seed a ROOM ban and check room-scoped — must NOT be masked by
        // the global cache entry (different cache key).
        await seedBan(id, { gameRoomId: roomId });
        const roomCheck = await BanService.isIdentityBanned(id, roomId);
        expect(roomCheck.banned).toBe(true);

        // The global-only cache entry is untouched (still cached "false").
        const globalSecond = await BanService.isIdentityBanned(id);
        expect(globalSecond.banned).toBe(false);
    });
});

describe('room-admin ban API — POST/GET/lift /:roomId/admin/bans', () => {
    it('bans a member: writes a room-scoped user_bans row, strips room_members, clears cache', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-room-1');
        const adminId = 'discord-ban-api-admin-1';
        const targetId = 'discord-ban-api-target-1';
        await RoomMembershipService.addMember(targetId, roomId, 'self_join');
        expect(await RoomMembershipService.isMember(targetId, roomId)).toBe(true);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: targetId, durationDays: 7, reason: 'testing' });
        expect(res.status).toBe(201);
        expect(res.body.game_room_id).toBe(roomId);

        const db = await getDatabase();
        const banRow = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ? AND game_room_id = ?', targetId, roomId);
        expect(banRow).toBeTruthy();
        expect(banRow.reason).toBe('testing');

        expect(await RoomMembershipService.isMember(targetId, roomId)).toBe(false);

        // Cache reflects the fresh ban immediately (BanService.ban clears the whole cache).
        expect((await BanService.isIdentityBanned(targetId, roomId)).banned).toBe(true);
    });

    it('GET lists only THIS room\'s bans, enriched with resolved display names', async () => {
        const app = await createApp();
        const roomA = await createTestRoom('ban-api-list-a');
        const roomB = await createTestRoom('ban-api-list-b');
        const adminId = 'discord-ban-api-list-admin';
        const targetA = 'discord-ban-api-list-target-a';
        const targetB = 'discord-ban-api-list-target-b';

        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
            targetA, 'Target A Display Name',
        );

        await seedBan(targetA, { gameRoomId: roomA });
        await seedBan(targetB, { gameRoomId: roomB });

        const res = await request(app)
            .get(`/api/rooms/${roomA}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomA, roomB])}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].discord_user_id).toBe(targetA);
        expect(res.body[0].discord_user_display_name).toBe('Target A Display Name');
    });

    it('lift 404s a ban that belongs to a DIFFERENT room', async () => {
        const app = await createApp();
        const roomA = await createTestRoom('ban-api-cross-lift-a');
        const roomB = await createTestRoom('ban-api-cross-lift-b');
        const adminId = 'discord-ban-api-cross-lift-admin';
        const banId = await seedBan('discord-ban-api-cross-lift-target', { gameRoomId: roomA });

        const res = await request(app)
            .post(`/api/rooms/${roomB}/admin/bans/${banId}/lift`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomA, roomB])}`);
        expect(res.status).toBe(404);

        const db = await getDatabase();
        const row = await db.get('SELECT lifted_at FROM user_bans WHERE id = ?', banId);
        expect(row.lifted_at).toBeNull();
    });

    it('lift succeeds for a ban belonging to THIS room, and re-join works afterward', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-lift-own-room');
        const adminId = 'discord-ban-api-lift-own-admin';
        const targetId = 'discord-ban-api-lift-own-target';
        const banId = await seedBan(targetId, { gameRoomId: roomId });

        const lift = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans/${banId}/lift`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`);
        expect(lift.status).toBe(200);

        // Lifted -> no longer banned -> self-join succeeds.
        const join = await request(app)
            .post(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${playerToken(targetId)}`)
            .send({});
        expect(join.status).toBe(200);
        expect(await RoomMembershipService.isMember(targetId, roomId)).toBe(true);
    });

    it('400s self-ban (actor cannot ban their own discordId)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-self-ban-room');
        const selfId = 'discord-ban-api-self-1';
        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(selfId, [roomId])}`)
            .send({ discordUserId: selfId });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/cannot ban your own account/i);
    });

    it('403s banning a super admin', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-super-target-room');
        const adminId = 'discord-ban-api-super-target-admin';
        const superId = 'discord-ban-api-super-target-victim';
        await AdminService.addSuperAdmin(superId, 'SuperVictim');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: superId });
        expect(res.status).toBe(403);

        const db = await getDatabase();
        const banRow = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', superId);
        expect(banRow).toBeUndefined();
    });

    it('403s banning a room admin of THIS room', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-room-admin-target-room');
        const actingAdminId = 'discord-ban-api-acting-admin';
        const targetAdminId = 'discord-ban-api-target-admin';
        await AdminService.addRoomDiscordAdmin(roomId, targetAdminId, 'admin');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(actingAdminId, [roomId])}`)
            .send({ discordUserId: targetAdminId });
        expect(res.status).toBe(403);
    });

    it('400s an iscored:* synthetic id — no login identity to ban', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-api-iscored-room');
        const adminId = 'discord-ban-api-iscored-admin';
        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: 'iscored:some_alias' });
        expect(res.status).toBe(400);
    });
});

describe('room-ban enforcement — submit/comment gating (requireNotBanned room-param pickup)', () => {
    it('room ban 403s a room-scoped write in THAT room', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('room-ban-enforce-1');
        const discordId = 'discord-room-enforce-banned-1';
        await seedBan(discordId, { gameRoomId: roomId });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/games/${encodeURIComponent('Some Game')}/comments`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ display_name: 'Tester', type: 'comment', body: 'hello' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('This account is banned.');
    });

    it('room ban does NOT 403 a write in a DIFFERENT room (decision 5 — room isolation)', async () => {
        const app = await createApp();
        const bannedInRoom = await createTestRoom('room-ban-enforce-2a');
        const otherRoom = await createTestRoom('room-ban-enforce-2b');
        const discordId = 'discord-room-enforce-isolated-1';
        await seedBan(discordId, { gameRoomId: bannedInRoom });

        const res = await request(app)
            .post(`/api/rooms/${otherRoom}/games/${encodeURIComponent('Some Game')}/comments`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ display_name: 'Tester', type: 'comment', body: 'hello' });
        expect(res.status).toBe(201);
    });

    it('room ban does NOT 403 a pure-global route (no roomId param)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('room-ban-enforce-3');
        const discordId = 'discord-room-enforce-global-1';
        await seedBan(discordId, { gameRoomId: roomId });

        const res = await request(app)
            .patch('/api/users/me/profile')
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ display_name: 'NewName' });
        expect(res.status).not.toBe(403);
    });

    it('a global ban still 403s a room-scoped write (global bites everywhere)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('room-ban-enforce-4');
        const discordId = 'discord-room-enforce-global-ban-1';
        await seedBan(discordId); // global

        const res = await request(app)
            .post(`/api/rooms/${roomId}/games/${encodeURIComponent('Some Game')}/comments`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ display_name: 'Tester', type: 'comment', body: 'hello' });
        expect(res.status).toBe(403);
    });

    it('room-banned user is blocked from re-joining (open room) and from join-requesting (approval room) while active', async () => {
        const app = await createApp();
        const openRoom = await createTestRoom('room-ban-rejoin-open');
        const approvalRoom = await createTestRoom('room-ban-rejoin-approval');
        await GameRoomSettingsService.set(approvalRoom, 'JOIN_POLICY', 'approval');
        const discordId = 'discord-room-ban-rejoin-1';
        await seedBan(discordId, { gameRoomId: openRoom });
        await seedBan(discordId, { gameRoomId: approvalRoom });

        const joinRes = await request(app)
            .post(`/api/me/rooms/${openRoom}`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({});
        expect(joinRes.status).toBe(403);
        expect(await RoomMembershipService.isMember(discordId, openRoom)).toBe(false);

        const joinReqRes = await request(app)
            .post(`/api/me/rooms/${approvalRoom}/join-request`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({});
        expect(joinReqRes.status).toBe(403);
    });

    it('an expired room ban stops blocking', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('room-ban-expired-1');
        const discordId = 'discord-room-ban-expired-1';
        const past = new Date(Date.now() - 60_000).toISOString();
        await seedBan(discordId, { gameRoomId: roomId, expiresAt: past });

        const res = await request(app)
            .post(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({});
        expect(res.status).toBe(200);
    });
});

describe('draft-commit — room-target ban check (draft.target.roomId, not req.params)', () => {
    it('403s a room-banned user and writes no submissions row', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('draft-room-ban-1');
        const tournamentId = await createTestTournament(roomId);
        await createTestGame(tournamentId, { name: 'Draft Ban Target Game' });
        const discordId = 'discord-draft-room-banned-1';
        await seedBan(discordId, { gameRoomId: roomId });

        const stateParam = 'draft-room-ban-state-1';
        await SubmissionDraftService.create(
            stateParam,
            { kind: 'tournament', roomId, gameName: 'Draft Ban Target Game' },
            { playerName: 'RoomBannedDrafter', score: 123456 },
        );

        const res = await request(app)
            .post(`/api/submission-drafts/${stateParam}/commit`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({});
        expect(res.status).toBe(403);

        const db = await getDatabase();
        const row = await db.get(`SELECT id FROM submissions WHERE iscored_username = 'RoomBannedDrafter'`);
        expect(row).toBeUndefined();
    });

    it('does NOT 403 when the ban is scoped to a DIFFERENT room than the draft target', async () => {
        const app = await createApp();
        const targetRoom = await createTestRoom('draft-room-ban-2a');
        const otherRoom = await createTestRoom('draft-room-ban-2b');
        const tournamentId = await createTestTournament(targetRoom);
        await createTestGame(tournamentId, { name: 'Draft Control Game' });
        const discordId = 'discord-draft-room-control-1';
        await seedBan(discordId, { gameRoomId: otherRoom });

        const stateParam = 'draft-room-ban-state-2';
        await SubmissionDraftService.create(
            stateParam,
            { kind: 'tournament', roomId: targetRoom, gameName: 'Draft Control Game' },
            { playerName: 'RoomBanControlDrafter', score: 111 },
        );

        const res = await request(app)
            .post(`/api/submission-drafts/${stateParam}/commit`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({});
        expect(res.status).not.toBe(403);
    });
});

describe('AdminService.getRoomDiscordAdmins — name resolution (v2.49.0 Workstream 2)', () => {
    it('resolves display_name/username from an existing user_profiles row', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('admin-resolve-profile-room');
        const adminId = 'discord-admin-resolve-profile-1';
        await AdminService.addRoomDiscordAdmin(roomId, adminId, 'admin');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)`,
            adminId, 'Cool Admin', 'cooladmin',
        );

        const admins = await AdminService.getRoomDiscordAdmins(roomId);
        expect(admins).toHaveLength(1);
        expect(admins[0].display_name).toBe('Cool Admin');
        expect(admins[0].username).toBe('cooladmin');
    });

    it('falls back to null (no crash) for a never-logged-in admin with no DISCORD_BOT_TOKEN configured', async () => {
        await setupTestDb();
        const original = process.env.DISCORD_BOT_TOKEN;
        delete process.env.DISCORD_BOT_TOKEN;
        try {
            const roomId = await createTestRoom('admin-resolve-no-profile-room');
            const adminId = '111122223333444455'; // snowflake-shaped, no profile row
            await AdminService.addRoomDiscordAdmin(roomId, adminId, 'admin');

            const admins = await AdminService.getRoomDiscordAdmins(roomId);
            expect(admins).toHaveLength(1);
            expect(admins[0].display_name).toBeNull();
            expect(admins[0].username).toBeNull();
        } finally {
            if (original) process.env.DISCORD_BOT_TOKEN = original;
        }
    });

    it('a google:* admin with no profile row renders with null names (no Discord user to look up)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('admin-resolve-google-room');
        const adminId = 'google:no-profile-admin-1';
        await AdminService.addRoomDiscordAdmin(roomId, adminId, 'admin');

        const admins = await AdminService.getRoomDiscordAdmins(roomId);
        expect(admins).toHaveLength(1);
        expect(admins[0].display_name).toBeNull();
        expect(admins[0].username).toBeNull();
    });

    it('GET /:roomId/admins ships the resolved fields end to end', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('admin-resolve-route-room');
        const adminId = 'discord-admin-resolve-route-1';
        await AdminService.addRoomDiscordAdmin(roomId, adminId, 'admin');
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`, adminId, 'Route Admin');

        const res = await request(app)
            .get(`/api/rooms/${roomId}/admins`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`);
        expect(res.status).toBe(200);
        expect(res.body.discordAdmins).toHaveLength(1);
        expect(res.body.discordAdmins[0].display_name).toBe('Route Admin');
    });
});

describe('ScoreReportService.listBans — scope filter + enrichment (v2.49.0)', () => {
    it('omitted gameRoomId returns both global and room bans (Reports "Bans" tab shape)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('listbans-scope-room');
        await seedBan('discord-listbans-global-1');
        await seedBan('discord-listbans-room-1', { gameRoomId: roomId });

        const all = await ScoreReportService.listBans(false);
        expect(all).toHaveLength(2);
        const globalRow = all.find(b => b.discord_user_id === 'discord-listbans-global-1');
        const roomRow = all.find(b => b.discord_user_id === 'discord-listbans-room-1');
        expect(globalRow?.game_room_id).toBeNull();
        expect(roomRow?.game_room_id).toBe(roomId);
        expect(roomRow?.room_name).toBeTruthy();
    });

    it('a gameRoomId filter returns only that room\'s bans', async () => {
        await setupTestDb();
        const roomA = await createTestRoom('listbans-filter-a');
        const roomB = await createTestRoom('listbans-filter-b');
        await seedBan('discord-listbans-filter-a-1', { gameRoomId: roomA });
        await seedBan('discord-listbans-filter-b-1', { gameRoomId: roomB });
        await seedBan('discord-listbans-filter-global-1');

        const roomAOnly = await ScoreReportService.listBans(false, roomA);
        expect(roomAOnly).toHaveLength(1);
        expect(roomAOnly[0].discord_user_id).toBe('discord-listbans-filter-a-1');
    });
});

/**
 * Fix round (tmp/room-bans-fixes.md) — 12-item adversarial review pass on
 * top of the room-bans contract. Each `describe` below is keyed to the
 * fix-round item number(s) it covers.
 */

describe('requireNotBannedGlobal — moderation-escalation suppression guard (fix-round #1)', () => {
    it('a user banned FROM a room CAN still report that same room to super-admins', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('report-suppression-room-1');
        const discordId = 'discord-report-suppression-1';
        await seedBan(discordId, { gameRoomId: roomId });

        const res = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ reason: 'this room banned me for reporting it' });
        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
    });

    it('a GLOBALLY banned user CANNOT report a room', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('report-suppression-room-2');
        const discordId = 'discord-report-suppression-2';
        await seedBan(discordId); // global

        const res = await request(app)
            .post(`/api/global/rooms/${roomId}/report`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ reason: 'irrelevant' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('This account is banned.');
    });
});

describe('room-admin ban API — fix-round hardening (#2, #3, #4, #6, #8)', () => {
    it('#2: POST .../admin/bans writes an explicit audit_log row (action room.ban)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-audit-room-1');
        const adminId = 'discord-ban-audit-admin-1';
        const targetId = 'discord-ban-audit-target-1';

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: targetId, reason: 'audit test' });
        expect(res.status).toBe(201);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT * FROM audit_log WHERE action = 'room.ban' AND target_id = ? ORDER BY id DESC LIMIT 1`,
            targetId,
        );
        expect(row).toBeTruthy();
        expect(row.actor).toBe(adminId);
        expect(JSON.parse(row.details).roomId).toBe(roomId);
    });

    it('#2: POST .../admin/bans/:banId/lift writes an explicit audit_log row (action room.unban)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-audit-room-2');
        const adminId = 'discord-ban-audit-admin-2';
        const targetId = 'discord-ban-audit-target-2';
        const banId = await seedBan(targetId, { gameRoomId: roomId });

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans/${banId}/lift`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`);
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const row = await db.get(
            `SELECT * FROM audit_log WHERE action = 'room.unban' AND target_id = ? ORDER BY id DESC LIMIT 1`,
            targetId,
        );
        expect(row).toBeTruthy();
        expect(row.actor).toBe(adminId);
    });

    it('#3: 403s banning a snowflake whose linked google alias holds the room-admin row for THIS room', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-link-room-admin-room');
        const actingAdminId = 'discord-ban-link-room-admin-acting';
        const targetSnowflake = 'discord-ban-link-room-admin-snowflake';
        const targetGoogleAlias = 'google:ban-link-room-admin-alias';

        await AdminService.addRoomDiscordAdmin(roomId, targetGoogleAlias, 'admin');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            targetGoogleAlias, targetSnowflake,
        );

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(actingAdminId, [roomId])}`)
            .send({ discordUserId: targetSnowflake });
        expect(res.status).toBe(403);

        const banRow = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', targetSnowflake);
        expect(banRow).toBeUndefined();
    });

    it('#3: 403s banning a snowflake whose linked google alias holds the super_admins row', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-link-super-admin-room');
        const actingAdminId = 'discord-ban-link-super-admin-acting';
        const targetSnowflake = 'discord-ban-link-super-admin-snowflake';
        const targetGoogleAlias = 'google:ban-link-super-admin-alias';

        await AdminService.addSuperAdmin(targetGoogleAlias, 'GoogleSuper');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            targetGoogleAlias, targetSnowflake,
        );

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(actingAdminId, [roomId])}`)
            .send({ discordUserId: targetSnowflake });
        expect(res.status).toBe(403);

        const banRow = await db.get('SELECT * FROM user_bans WHERE discord_user_id = ?', targetSnowflake);
        expect(banRow).toBeUndefined();
    });

    it('#4: banning denies the target\'s pending join request in this room', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-denies-pending-jr-room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const adminId = 'discord-ban-denies-jr-admin';
        const targetId = 'discord-ban-denies-jr-target';

        const jrRes = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(targetId)}`)
            .send({});
        expect(jrRes.body.status).toBe('pending');

        const banRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: targetId });
        expect(banRes.status).toBe(201);

        const db = await getDatabase();
        const jrRow = await db.get(
            `SELECT status FROM join_requests WHERE game_room_id = ? AND user_id = ?`,
            roomId, targetId,
        );
        expect(jrRow.status).toBe('denied');
        expect(await RoomMembershipService.isMember(targetId, roomId)).toBe(false);
    });

    it('#4: JoinRequestService.approve defensively 403s a currently-banned requester (race case)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-approve-race-room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const targetId = 'discord-ban-approve-race-target';

        // Request filed while unbanned.
        const jrRes = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(targetId)}`)
            .send({});
        expect(jrRes.body.status).toBe('pending');
        const db = await getDatabase();
        const pending = await db.get(
            `SELECT id FROM join_requests WHERE game_room_id = ? AND user_id = ? AND status = 'pending'`,
            roomId, targetId,
        );

        // Ban placed through a path that doesn't sweep join_requests (direct
        // seed) — simulates the narrow race the defensive check exists for.
        // A real ban always goes through ScoreReportService.ban(), which
        // clears BanService's cache; seedBan bypasses the service layer, so
        // clear it explicitly here to avoid a stale "not banned" cache hit
        // from the join-request POST above (same 10s TTL that production
        // writers are responsible for busting).
        await seedBan(targetId, { gameRoomId: roomId });
        BanService.clearCacheForTests();

        const adminId = 'discord-ban-approve-race-admin';
        const approveRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/join-requests/${pending.id}/approve`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`);
        expect(approveRes.status).toBe(403);
        expect(await RoomMembershipService.isMember(targetId, roomId)).toBe(false);
    });

    it('#6: a second ban attempt on an already-actively-banned identity 409s; exactly one active row', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-dup-room');
        const adminId = 'discord-ban-dup-admin';
        const targetId = 'discord-ban-dup-target';

        const first = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: targetId });
        expect(first.status).toBe(201);

        const second = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(adminId, [roomId])}`)
            .send({ discordUserId: targetId });
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already banned from this room/i);

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT * FROM user_bans WHERE discord_user_id = ? AND game_room_id = ? AND lifted_at IS NULL`,
            targetId, roomId,
        );
        expect(rows).toHaveLength(1);
    });

    it('#8: a GLOBALLY-banned room admin cannot issue a room ban (requireNotBanned gates the route)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-banned-admin-room');
        const bannedAdminId = 'discord-ban-banned-admin-1';
        await seedBan(bannedAdminId); // global ban on the acting admin

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans`)
            .set('Authorization', `Bearer ${roomAdminToken(bannedAdminId, [roomId])}`)
            .send({ discordUserId: 'discord-ban-banned-admin-victim' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('This account is banned.');
    });

    it('#8: a GLOBALLY-banned room admin cannot lift a room ban (requireNotBanned gates the route)', async () => {
        const app = await createApp();
        const roomId = await createTestRoom('ban-banned-admin-lift-room');
        const bannedAdminId = 'discord-ban-banned-admin-lift-1';
        const banId = await seedBan('discord-ban-banned-admin-lift-target', { gameRoomId: roomId });
        await seedBan(bannedAdminId); // global ban on the acting admin

        const res = await request(app)
            .post(`/api/rooms/${roomId}/admin/bans/${banId}/lift`)
            .set('Authorization', `Bearer ${roomAdminToken(bannedAdminId, [roomId])}`);
        expect(res.status).toBe(403);

        const db = await getDatabase();
        const row = await db.get('SELECT lifted_at FROM user_bans WHERE id = ?', banId);
        expect(row.lifted_at).toBeNull();
    });
});

describe('RoomRosterService.getRoster — active bans excluded server-side (fix-round #7)', () => {
    async function insertScoreHistoryRow(opts: {
        gameRoomId: string;
        gameName: string;
        iscoredUsername: string;
        score: number;
        submittedByUserId: string;
    }) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, orphaned_at, created_at
             ) VALUES (?, ?, NULL, ?, ?, ?, 'community', ?, NULL, ?, NULL, ?)`,
            opts.gameName, opts.gameRoomId, opts.iscoredUsername, opts.submittedByUserId,
            opts.score, opts.gameRoomId, opts.submittedByUserId, new Date().toISOString(),
        );
    }

    it('open-policy room: an actively room-banned poster is absent from the roster', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('roster-open-ban-room');
        const bannedId = 'discord-roster-open-banned';
        const okId = 'discord-roster-open-ok';
        await insertScoreHistoryRow({ gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'Banned', score: 100, submittedByUserId: bannedId });
        await insertScoreHistoryRow({ gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'Ok', score: 200, submittedByUserId: okId });
        await seedBan(bannedId, { gameRoomId: roomId });

        const { members } = await RoomRosterService.getRoster(roomId);
        const ids = members.map(m => m.userId);
        expect(ids).toContain(okId);
        expect(ids).not.toContain(bannedId);
    });

    it('open-policy room: a GLOBALLY banned poster is also absent (global ban bites everywhere)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('roster-open-global-ban-room');
        const bannedId = 'discord-roster-open-global-banned';
        await insertScoreHistoryRow({ gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'GlobalBanned', score: 100, submittedByUserId: bannedId });
        await seedBan(bannedId); // global

        const { members } = await RoomRosterService.getRoster(roomId);
        expect(members.map(m => m.userId)).not.toContain(bannedId);
    });

    it('a lifted ban no longer excludes the user from the roster', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('roster-lifted-ban-room');
        const userId = 'discord-roster-lifted';
        await insertScoreHistoryRow({ gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'Lifted', score: 100, submittedByUserId: userId });
        await seedBan(userId, { gameRoomId: roomId, liftedAt: new Date().toISOString() });

        const { members } = await RoomRosterService.getRoster(roomId);
        expect(members.map(m => m.userId)).toContain(userId);
    });

    it('approval-policy room: an actively room-banned identity is excluded even if a room_members row lingers', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('roster-approval-ban-room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        const bannedId = 'discord-roster-approval-banned';
        const okId = 'discord-roster-approval-ok';
        await RoomMembershipService.addMember(okId, roomId, 'self_join');
        // A lingering room_members row for the banned identity (e.g. a race
        // that re-added it after the ban's membership strip) must still be
        // filtered out by the roster's own active-ban check, not rely solely
        // on the ban route having stripped it at ban-time.
        await RoomMembershipService.addMember(bannedId, roomId, 'self_join');
        await seedBan(bannedId, { gameRoomId: roomId });

        const { members } = await RoomRosterService.getRoster(roomId);
        const ids = members.map(m => m.userId);
        expect(ids).toContain(okId);
        expect(ids).not.toContain(bannedId);
    });
});

describe('GameRoomService.delete — cleans up room bans (fix-round #12)', () => {
    it('deletes user_bans rows scoped to the deleted room, leaves other rooms\' bans alone', async () => {
        await setupTestDb();
        const roomToDelete = await createTestRoom('delete-cleanup-ban-room-1');
        const otherRoom = await createTestRoom('delete-cleanup-ban-room-2');
        await seedBan('discord-delete-cleanup-1', { gameRoomId: roomToDelete });
        await seedBan('discord-delete-cleanup-2', { gameRoomId: otherRoom });
        await seedBan('discord-delete-cleanup-3'); // global, untouched by any room delete

        await GameRoomService.delete(roomToDelete);

        const db = await getDatabase();
        const remaining = await db.all('SELECT discord_user_id, game_room_id FROM user_bans ORDER BY discord_user_id');
        const ids = remaining.map((r: any) => r.discord_user_id);
        expect(ids).not.toContain('discord-delete-cleanup-1');
        expect(ids).toContain('discord-delete-cleanup-2');
        expect(ids).toContain('discord-delete-cleanup-3');
    });
});
