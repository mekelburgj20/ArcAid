import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * GET /:roomId/admin/members — the label the member picker renders.
 *
 * BUG (owner, 2026-08-20). The "Pick on behalf of a player" picker showed raw
 * Discord snowflakes. The route selected `up.display_name` alone — the
 * USER-CHOSEN global name, which almost nobody sets — and the FE falls back to
 * `m.userId`. So the fallback was the normal case.
 *
 * The fix resolves the same way every other player-name surface does:
 * global display name -> provider username (stored on every login, so
 * effectively always present) -> the room's own claimed name. Ordering follows
 * the resolved label, not the raw column, or the list sorts by snowflake.
 *
 * Scope guard: this is the ADMIN endpoint only. `/members` (public) is
 * deliberately untouched.
 */

const ADMIN = '999999999999999999';

async function createTestApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) =>
    signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: ADMIN, username: 'RoomAdmin' } as never);

async function addMember(roomId: string, userId: string, opts: {
    display?: string | null;
    username?: string | null;
    roomName?: string | null;
} = {}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO room_members (user_id, room_id, source, display_name) VALUES (?, ?, 'claim', ?)`,
        userId, roomId, opts.roomName ?? null,
    );
    if (opts.display !== undefined || opts.username !== undefined) {
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)`,
            userId, opts.display ?? null, opts.username ?? null,
        );
    }
}

async function fetchMembers(roomId: string) {
    const app = await createTestApp();
    const res = await request(app)
        .get(`/api/rooms/${roomId}/admin/members`)
        .set('Authorization', `Bearer ${adminToken(roomId)}`);
    expect(res.status).toBe(200);
    return res.body as Array<{ userId: string; displayName: string | null; username?: string | null }>;
}

describe('GET /:roomId/admin/members — resolved member labels', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('falls back to the provider username when no global display name is set', async () => {
        // The common case, and the one that shipped snowflakes.
        const roomId = await createTestRoom('members-username', 'Members Room');
        await addMember(roomId, '111111111111111111', { display: null, username: 'brickshotbobes' });

        const [member] = await fetchMembers(roomId);
        expect(member!.displayName).toBe('brickshotbobes');
        expect(member!.username).toBe('brickshotbobes');
    });

    it('falls back to the room-claimed name when there is no profile name at all', async () => {
        const roomId = await createTestRoom('members-roomname', 'Members Room');
        await addMember(roomId, '222222222222222222', { display: null, username: null, roomName: 'DennisB' });

        const [member] = await fetchMembers(roomId);
        expect(member!.displayName).toBe('DennisB');
    });

    it('prefers the user-chosen global display name over both fallbacks', async () => {
        const roomId = await createTestRoom('members-global', 'Members Room');
        await addMember(roomId, '333333333333333333', {
            display: 'RetroTechX', username: 'raw_handle', roomName: 'RoomAlias',
        });

        const [member] = await fetchMembers(roomId);
        expect(member!.displayName).toBe('RetroTechX');
    });

    it('treats a blank-string name as absent rather than as a label', async () => {
        const roomId = await createTestRoom('members-blank', 'Members Room');
        await addMember(roomId, '444444444444444444', { display: '   ', username: 'realname' });

        const [member] = await fetchMembers(roomId);
        expect(member!.displayName).toBe('realname');
    });

    it('orders by the RESOLVED label, not by the raw display_name column', async () => {
        // Pre-fix these sorted by snowflake, so the picker's order looked random.
        const roomId = await createTestRoom('members-order', 'Members Room');
        await addMember(roomId, '999000000000000001', { username: 'zara' });
        await addMember(roomId, '111000000000000002', { username: 'alice' });
        await addMember(roomId, '555000000000000003', { display: 'Mallory', username: 'zzz_raw' });

        const labels = (await fetchMembers(roomId)).map((m) => m.displayName);
        expect(labels).toEqual(['alice', 'Mallory', 'zara']);
    });

    it('still returns a null label (FE keeps its userId fallback) when nothing is known', async () => {
        const roomId = await createTestRoom('members-nothing', 'Members Room');
        await addMember(roomId, '666666666666666666');

        const [member] = await fetchMembers(roomId);
        expect(member!.displayName).toBeNull();
        expect(member!.userId).toBe('666666666666666666');
    });
});
