import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';
import { AdminService } from '../services/AdminService.js';

/**
 * Room Members/Players page (v2.42.0, tmp/room-members-page-contract.md).
 *
 * GET /:roomId/members is registered AFTER `roomVisibilityGate` in rooms.ts,
 * so it inherits the gate for free: 'approval' rooms 403 a non-member,
 * 'open' rooms are public. These tests lock that in, plus the two disjoint
 * data sources (room_members roster vs. distinct identified score-posters).
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function makeApprovalRoom(slug = 'approval-members-room') {
    const roomId = await createTestRoom(slug, 'Approval Members Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
    return roomId;
}

/** Mirrors room-scores.test.ts's helper: direct score_history seeding for
 *  cases the submissions-flavored createTestSubmission() can't express. */
async function insertScoreHistoryRow(opts: {
    gameRoomId: string;
    gameName: string;
    iscoredUsername: string;
    score: number;
    discordUserId?: string | null;
    submittedByUserId?: string | null;
    source?: 'tournament' | 'community' | 'sync';
    orphanedAt?: string | null;
    createdAt?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, orphaned_at, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.iscoredUsername,
        opts.discordUserId ?? 'SYSTEM', opts.score, opts.source ?? 'community',
        opts.gameRoomId, opts.submittedByUserId ?? null, opts.orphanedAt ?? null,
        opts.createdAt ?? new Date().toISOString(),
    );
}

describe('GET /api/rooms/:roomId/members — gating (open vs. approval)', () => {
    it('open room: public, no auth required', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('members-open-1');
        const res = await request(app).get(`/api/rooms/${roomId}/members`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('approval room: 403s a guest', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('members-approval-guest');
        const res = await request(app).get(`/api/rooms/${roomId}/members`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');
    });

    it('approval room: 403s a logged-in non-member', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('members-approval-nonmember');
        const token = playerToken('discord-nonmember-1');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/members`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    it('approval room: allows a member through', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('members-approval-member');
        const discordId = 'discord-member-1';
        await RoomMembershipService.addMember(discordId, roomId, 'self_join');
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/members`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });
});

describe('GET /api/rooms/:roomId/members — open room roster (score_history posters)', () => {
    it('returns distinct identified posters with correct scoreCount, excludes guest/anon rows', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('members-open-roster');

        // Identified poster with two scores -> scoreCount 2.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'Alice',
            score: 1000, discordUserId: 'DALICE', submittedByUserId: 'discord-alice',
            createdAt: '2026-01-01T00:00:00.000Z',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game B', iscoredUsername: 'Alice',
            score: 2000, discordUserId: 'DALICE', submittedByUserId: 'discord-alice',
            createdAt: '2026-01-02T00:00:00.000Z',
        });
        // Guest/anon score — submitted_by_user_id NULL — must be excluded.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'GuestBob',
            score: 500, discordUserId: 'COMMUNITY', submittedByUserId: null,
        });
        // Orphaned identified score — must be excluded.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'Orphaned',
            score: 999, discordUserId: 'DORPH', submittedByUserId: 'discord-orphaned',
            orphanedAt: '2026-01-03T00:00:00.000Z',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/members`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        const alice = res.body[0];
        expect(alice.userId).toBe('discord-alice');
        expect(alice.scoreCount).toBe(2);
        expect(alice.iscoredUsername).toBe('Alice');
        expect(alice.firstSeenAt).toBeTruthy();
        expect(alice.lastSeenAt).toBeTruthy();
        // No profile row seeded -> falls back to iscoredUsername.
        expect(alice.displayName).toBe('Alice');
    });

    it('does NOT read room_members for open rooms (a bookmarker with no scores is absent)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('members-open-no-room-members');
        // Bookmarker joined via "My Game Rooms" but never posted a score.
        await RoomMembershipService.addMember('discord-bookmarker', roomId, 'self_join');

        const res = await request(app).get(`/api/rooms/${roomId}/members`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(0);
    });

    it('resolves displayName via user_profiles when present', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('members-open-profile');
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'CarolAlias',
            score: 1000, discordUserId: 'DCAROL', submittedByUserId: 'discord-carol',
        });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
            'discord-carol', 'Carol Display',
        );

        const res = await request(app).get(`/api/rooms/${roomId}/members`);
        expect(res.status).toBe(200);
        expect(res.body[0].displayName).toBe('Carol Display');
    });
});

describe('GET /api/rooms/:roomId/members — approval room roster (room_members)', () => {
    it('returns the room_members roster, not score_history posters', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('members-approval-roster');
        await RoomMembershipService.addMember('discord-member-a', roomId, 'self_join');
        await RoomMembershipService.addMember('discord-member-b', roomId, 'self_join');
        // A poster who is NOT a room_members row (shouldn't appear here).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Game A', iscoredUsername: 'NonMemberPoster',
            score: 100, discordUserId: 'DNM', submittedByUserId: 'discord-non-member-poster',
        });

        const token = playerToken('discord-member-a');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/members`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const ids = res.body.map((m: any) => m.userId).sort();
        expect(ids).toEqual(['discord-member-a', 'discord-member-b']);
        // joinedAt present (approval shape), scoreCount absent (open-only field).
        expect(res.body[0].joinedAt).toBeTruthy();
        expect(res.body[0].scoreCount).toBeUndefined();
    });

    it('flags owner and admin badges via game_room_admins', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('members-approval-badges');
        // Owner: GameRoomService.create's grant path — simulate directly.
        await RoomMembershipService.addMember('discord-owner', roomId, 'admin_invite');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'owner')`,
            roomId, 'discord-owner',
        );
        // Admin via AdminService's real grant path (also seeds room_members).
        await AdminService.addRoomDiscordAdmin(roomId, 'discord-admin');
        // Plain approved member, no admin role.
        await RoomMembershipService.addMember('discord-plain', roomId, 'self_join');

        const token = playerToken('discord-owner');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/members`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(res.body.map((m: any) => [m.userId, m]));
        expect(byId['discord-owner'].isOwner).toBe(true);
        expect(byId['discord-owner'].isAdmin).toBe(false);
        expect(byId['discord-admin'].isAdmin).toBe(true);
        expect(byId['discord-admin'].isOwner).toBe(false);
        expect(byId['discord-plain'].isOwner).toBe(false);
        expect(byId['discord-plain'].isAdmin).toBe(false);
    });
});
