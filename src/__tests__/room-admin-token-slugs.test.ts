import { describe, it, expect, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { AdminService } from '../services/AdminService.js';
import { createSession, refreshAccessToken } from '../api/auth.js';

/**
 * RetroTechX lockout (2026-08-19): a room admin logging in from the generic
 * /login page (state=__super__) was routed to the SUPER-admin dashboard
 * because the FE reads `roomSlugs` off the JWT to find their room — and no
 * mint site ever included it. SuperAdminLayout then bounced the non-super
 * token back to /login. These tests pin the claim onto every server-side
 * mint the suite can reach without OAuth: the refresh re-mint (shared shape
 * with both OAuth callbacks) and the slug lookup itself.
 */
describe('room_admin tokens carry roomSlugs', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('getRoomSlugs preserves input order and skips missing rooms', async () => {
        const roomA = await createTestRoom('room_a', 'Room A');
        const roomB = await createTestRoom('room_b', 'Room B');
        const slugs = await AdminService.getRoomSlugs([roomB, 'no-such-room', roomA]);
        expect(slugs).toEqual(['room_b', 'room_a']);
        expect(await AdminService.getRoomSlugs([])).toEqual([]);
    });

    it('refreshAccessToken mints roomSlugs for a room admin', async () => {
        const roomId = await createTestRoom('rtx_pinball_test', 'RTX Test');
        const db = await getDatabase();
        const discordId = '488682482707857418';
        await db.run(
            'INSERT INTO game_room_admins (game_room_id, discord_user_id) VALUES (?, ?)',
            roomId, discordId,
        );
        const refreshToken = 'refresh-slug-test';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        const payload = jwt.decode(result.token) as Record<string, unknown>;
        expect(payload.role).toBe('room_admin');
        expect(payload.gameRoomIds).toEqual([roomId]);
        expect(payload.roomSlugs).toEqual(['rtx_pinball_test']);
    });

    it('refreshAccessToken omits roomSlugs for a plain player', async () => {
        const refreshToken = 'refresh-player-test';
        await createSession('999000999000999000', refreshToken, 'irrelevant-access-token');
        const result = await refreshAccessToken(refreshToken);
        const payload = jwt.decode(result.token) as Record<string, unknown>;
        expect(payload.role).toBe('player');
        expect(payload.roomSlugs).toBeUndefined();
    });
});
