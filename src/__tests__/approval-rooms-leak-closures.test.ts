import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { discordExcludedRoomIds, buildEnabledRoomSqlFilter } from '../utils/discordRoomFilter.js';

// v2.39.0 — approval-rooms leak closures (tmp/approval-rooms-contract.md, D3).
//
// v2.41.0 (tmp/player-governs-global-contract.md) removed the room-level
// Global Scoreboard fan-out gate that the "approval-room early return" and
// "flip-to-approval scrub" describe blocks below used to assert — per-
// submission `excludeFromGlobal` now governs fan-out uniformly for open and
// approval-policy rooms alike. Those two blocks were updated in place to
// assert the new (non-)behavior rather than deleted, since the surrounding
// D3 leak-closure tests (Discord exclusion, canViewRoom, GET /api/rooms
// count-stripping) are unrelated and must stay intact.

async function seedGlobalGame(name: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, name, JSON.stringify(['real']),
    );
    return id;
}

describe('GlobalScoreService.fanOutFromRoomSubmission — approval-room fan-out (v2.41.0: no room-level gate)', () => {
    it('fans out normally even when the origin room is approval-policy (room-level gate removed)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('fanout-approval');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await seedGlobalGame('Fan Out Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId,
            gameName: 'Fan Out Game',
            playerId: 'discord-fanout-1',
            iscoredUsername: 'FanOutPlayer',
            score: 5000,
        });
        expect(result).not.toBeNull();
    });

    it('fans out normally for the same room/game when the policy is open (control)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('fanout-open');
        await seedGlobalGame('Fan Out Game Open');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId,
            gameName: 'Fan Out Game Open',
            playerId: 'discord-fanout-2',
            iscoredUsername: 'FanOutPlayer2',
            score: 5000,
        });
        expect(result).not.toBeNull();
    });
});

describe('flip-to-approval (v2.41.0: no longer scrubs the Global Scoreboard)', () => {
    it('leaves the room\'s global_scores rows untouched when JOIN_POLICY flips open -> approval', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('scrub-room');
        const globalGameId = await seedGlobalGame('Scrub Game');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-scrub-1', 'ScrubPlayer', 9000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        const before = await db.get(
            `SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?`, roomId,
        );
        expect(before.deleted_at).toBeNull();

        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');

        const after = await db.get(
            `SELECT deleted_at, deleted_by FROM global_scores WHERE origin_game_room_id = ?`, roomId,
        );
        expect(after.deleted_at).toBeNull();
        expect(after.deleted_by).toBeNull();
    });

    it('flipping back to open still leaves existing rows untouched (nothing to restore — nothing was scrubbed)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('scrub-room-2');
        const globalGameId = await seedGlobalGame('Scrub Game 2');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-scrub-2', 'ScrubPlayer2', 9000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'open');

        const row = await db.get(
            `SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?`, roomId,
        );
        expect(row.deleted_at).toBeNull();
    });

    it('is a no-op when the policy does not actually change direction', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('scrub-room-3');
        const globalGameId = await seedGlobalGame('Scrub Game 3');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-scrub-3', 'ScrubPlayer3', 9000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        // 'open' -> 'open' (absent -> explicit 'open') must not scrub.
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'open');
        const row = await db.get(
            `SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?`, roomId,
        );
        expect(row.deleted_at).toBeNull();
    });
});

describe('discordExcludedRoomIds / buildEnabledRoomSqlFilter', () => {
    it('excludes an approval-policy room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('discord-filter-approval');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');

        const excluded = await discordExcludedRoomIds();
        expect(excluded).toContain(roomId);
    });

    it('excludes a DISCORD_ENABLED=false room (existing behavior preserved)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('discord-filter-disabled');
        await GameRoomSettingsService.set(roomId, 'DISCORD_ENABLED', 'false');

        const excluded = await discordExcludedRoomIds();
        expect(excluded).toContain(roomId);
    });

    it('does not exclude an open, Discord-enabled room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('discord-filter-open');

        const excluded = await discordExcludedRoomIds();
        expect(excluded).not.toContain(roomId);
    });

    it('buildEnabledRoomSqlFilter produces a usable NOT IN fragment for an approval room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('discord-filter-sql');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');

        const { sql, params } = await buildEnabledRoomSqlFilter('t.game_room_id');
        expect(sql).toContain('NOT IN');
        expect(params).toContain(roomId);
    });
});

describe('RoomAccessService.canViewRoom — unit', () => {
    it('denies a guest (null token)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-guest');
        expect(await RoomAccessService.canViewRoom(null, roomId)).toBe(false);
    });

    it('allows super_admin', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-super');
        expect(await RoomAccessService.canViewRoom({ role: 'super_admin', gameRoomIds: [] }, roomId)).toBe(true);
    });

    it('allows a token carrying this room in gameRoomIds', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-token-admin');
        expect(await RoomAccessService.canViewRoom({ role: 'room_admin', gameRoomIds: [roomId] }, roomId)).toBe(true);
    });

    it('denies a token for a different room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-wrong-room');
        const otherRoomId = await createTestRoom('cvr-other-room');
        expect(await RoomAccessService.canViewRoom({ role: 'room_admin', gameRoomIds: [otherRoomId] }, roomId)).toBe(false);
    });

    it('allows a member found only via the DB (not the token)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-db-member');
        const { RoomMembershipService } = await import('../services/RoomMembershipService.js');
        await RoomMembershipService.addMember('discord-cvr-1', roomId, 'self_join');
        expect(await RoomAccessService.canViewRoom(
            { role: 'player', gameRoomIds: [], discordId: 'discord-cvr-1' }, roomId,
        )).toBe(true);
    });

    it('denies a plain player with no membership row', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('cvr-plain-player');
        expect(await RoomAccessService.canViewRoom(
            { role: 'player', gameRoomIds: [], discordId: 'discord-cvr-2' }, roomId,
        )).toBe(false);
    });
});

// Security review fix (pre-merge, v2.39.0) — GET /api/rooms is fully public
// (no auth at all) and enriches every is_public room with activeGames/
// activePlayers/discordInviteUrl. An approval-policy room must still be
// discoverable there (join_policy carries through so the FE can render a
// "Request to join" card) but its aggregate activity counts and Discord
// invite link are exactly the "stats"/contact-info categories the contract
// bars for non-members — those must be stripped, not just left ungated.
describe('GET /api/rooms — approval rooms do not leak activity counts', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('strips activeGames/activePlayers/discordInviteUrl for an approval-policy room, even though join_policy is still exposed', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leak-approval-room', 'Approval Leak Room');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'DISCORD_INVITE_URL', 'https://discord.gg/example');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Hidden Game' });
        await createTestSubmission(gameId, { username: 'HiddenPlayer', score: 12345 });

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        const room = res.body.find((r: any) => r.id === roomId);
        expect(room).toBeDefined();
        // Still discoverable.
        expect(room.name).toBe('Approval Leak Room');
        expect(room.join_policy).toBe('approval');
        // But the leak categories are gone.
        expect(room.activeGames).toBe(0);
        expect(room.activePlayers).toBe(0);
        expect(room.discordInviteUrl).toBeNull();
    });

    it('an open room in the same response still carries real counts (control)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leak-open-room', 'Open Room');
        await GameRoomSettingsService.set(roomId, 'DISCORD_INVITE_URL', 'https://discord.gg/open-example');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Visible Game' });
        await createTestSubmission(gameId, { username: 'VisiblePlayer', score: 54321 });

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        const room = res.body.find((r: any) => r.id === roomId);
        expect(room).toBeDefined();
        expect(room.join_policy).toBe('open');
        expect(room.activeGames).toBe(1);
        expect(room.activePlayers).toBe(1);
        expect(room.discordInviteUrl).toBe('https://discord.gg/open-example');
    });
});
