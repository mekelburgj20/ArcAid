import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { discordExcludedRoomIds, buildEnabledRoomSqlFilter } from '../utils/discordRoomFilter.js';

// v2.39.0 — approval-rooms leak closures (tmp/approval-rooms-contract.md, D3).

async function seedGlobalGame(name: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, name, JSON.stringify(['real']),
    );
    return id;
}

describe('GlobalScoreService.fanOutFromRoomSubmission — approval-room early return', () => {
    it('returns null (does not fan out) when the origin room is approval-policy', async () => {
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
        expect(result).toBeNull();
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

describe('flip-to-approval scrub', () => {
    it('soft-deletes the room\'s global_scores rows when JOIN_POLICY flips open -> approval', async () => {
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
        expect(after.deleted_at).not.toBeNull();
        expect(after.deleted_by).toBe('system:join_policy_flip');
    });

    it('does not retroactively restore scrubbed rows when flipping back to open', async () => {
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
        expect(row.deleted_at).not.toBeNull();
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
