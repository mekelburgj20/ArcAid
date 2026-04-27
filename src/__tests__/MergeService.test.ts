import { describe, it, expect, beforeEach } from 'vitest';
import { MergeService } from '../services/MergeService.js';
import { AnonymousIdentityService } from '../services/AnonymousIdentityService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';

/**
 * Coverage for the v2.x identity-merge contract:
 *   • forward attribution writes to user_mappings (Part A)
 *   • mapping conflict surfaces a typed error (Part A)
 *   • idempotent on same-user re-merge (Part A)
 *   • reverseMerge undoes the alias + re-anonymizes post-merge rows (Part A)
 *   • previewMerge tournament freeze gate still works after the v2.7.x fix
 */

async function seedAnonRow(opts: {
    roomId: string;
    nickname: string;
    score?: number;
    tournamentId?: string | null;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO community_scores
            (game_name, game_room_id, iscored_username, discord_user_id, score,
             submitted_from_room_id, submitted_during_tournament_id,
             submitted_by_user_id, submitted_by_anonymous_name)
         VALUES (?, ?, ?, 'ANON', ?, ?, ?, NULL, ?)`,
        'Test Game', opts.roomId, opts.nickname, opts.score ?? 1234,
        opts.roomId, opts.tournamentId ?? null, opts.nickname,
    );
}

async function preview(roomId: string, identityId: number, targetDiscordId: string) {
    return MergeService.previewMerge(roomId, identityId, targetDiscordId);
}

describe('MergeService.recordMerge — forward attribution', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('writes a user_mappings row linking the alias to the target Discord user', async () => {
        const roomId = await createTestRoom();
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'PBW2023' });
        await seedAnonRow({ roomId, nickname: 'PBW2023' });

        const p = await preview(roomId, identityId, 'discord-1');
        await MergeService.recordMerge({
            roomId,
            anonymousIdentityId: identityId,
            targetDiscordUserId: 'discord-1',
            adminDiscordUserId: 'admin-1',
            previewHash: p.previewHash,
        });

        const db = await getDatabase();
        const row = await db.get(
            `SELECT discord_user_id, iscored_username FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)`,
            'PBW2023',
        );
        expect(row).toBeTruthy();
        expect((row as any).discord_user_id).toBe('discord-1');
    });

    it('throws MAPPING_CONFLICT when the alias is already mapped to a different Discord user', async () => {
        const roomId = await createTestRoom();
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'taken' });
        await seedAnonRow({ roomId, nickname: 'taken' });

        // Pre-existing mapping to user A
        const db = await getDatabase();
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`, 'discord-A', 'taken');

        const p = await preview(roomId, identityId, 'discord-B');
        await expect(
            MergeService.recordMerge({
                roomId,
                anonymousIdentityId: identityId,
                targetDiscordUserId: 'discord-B',
                adminDiscordUserId: 'admin-1',
                previewHash: p.previewHash,
            }),
        ).rejects.toMatchObject({ message: expect.stringMatching(/MAPPING_CONFLICT/) });
    });

    it('is idempotent when the alias is already mapped to the same Discord user', async () => {
        const roomId = await createTestRoom();
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'me' });
        await seedAnonRow({ roomId, nickname: 'me' });

        const db = await getDatabase();
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`, 'discord-self', 'me');

        const p = await preview(roomId, identityId, 'discord-self');
        const result = await MergeService.recordMerge({
            roomId,
            anonymousIdentityId: identityId,
            targetDiscordUserId: 'discord-self',
            adminDiscordUserId: 'admin-1',
            previewHash: p.previewHash,
        });
        expect(result.movedRows).toBeGreaterThanOrEqual(1);

        const rows = await db.all(`SELECT * FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)`, 'me');
        expect(rows.length).toBe(1);
    });

    it('matches case-insensitively against existing mappings', async () => {
        const roomId = await createTestRoom();
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'pbw2023' });
        await seedAnonRow({ roomId, nickname: 'pbw2023' });

        const db = await getDatabase();
        // Existing mapping uses upper-case casing; the merge nickname is lower-case.
        await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`, 'discord-X', 'PBW2023');

        const p = await preview(roomId, identityId, 'discord-Y');
        await expect(
            MergeService.recordMerge({
                roomId,
                anonymousIdentityId: identityId,
                targetDiscordUserId: 'discord-Y',
                adminDiscordUserId: 'admin-1',
                previewHash: p.previewHash,
            }),
        ).rejects.toMatchObject({ message: expect.stringMatching(/MAPPING_CONFLICT/) });
    });
});

describe('MergeService.reverseMerge — undo forward attribution', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('drops the user_mappings row and re-anonymizes post-merge auto-attributed rows', async () => {
        const roomId = await createTestRoom();
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'reverseTest' });
        await seedAnonRow({ roomId, nickname: 'reverseTest', score: 100 });

        const p = await preview(roomId, identityId, 'discord-Z');
        const merge = await MergeService.recordMerge({
            roomId,
            anonymousIdentityId: identityId,
            targetDiscordUserId: 'discord-Z',
            adminDiscordUserId: 'admin-1',
            previewHash: p.previewHash,
        });

        const db = await getDatabase();
        // Simulate a post-merge sync: a fresh score lands attributed to the
        // Discord user via the new user_mappings row (no merged_from_anonymous_identity_id).
        await db.run(
            `INSERT INTO community_scores
                (game_name, game_room_id, iscored_username, discord_user_id, score,
                 submitted_from_room_id, submitted_during_tournament_id,
                 submitted_by_user_id, submitted_by_anonymous_name)
             VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
            'Test Game', roomId, 'reverseTest', 'discord-Z', 200, roomId, 'discord-Z',
        );

        await MergeService.reverseMerge({ mergeId: merge.mergeId, reversalAdminId: 'admin-1' });

        const stillMapped = await db.get(`SELECT 1 FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)`, 'reverseTest');
        expect(stillMapped).toBeUndefined();

        const postMergeRow = await db.get(
            `SELECT submitted_by_user_id, submitted_by_anonymous_name, discord_user_id
             FROM community_scores
             WHERE iscored_username = ? AND score = 200`,
            'reverseTest',
        );
        expect((postMergeRow as any).submitted_by_user_id).toBeNull();
        expect((postMergeRow as any).submitted_by_anonymous_name).toBe('reverseTest');
        expect((postMergeRow as any).discord_user_id).toBe('iscored:reverseTest');
    });
});

describe('MergeService.previewMerge — tournament freeze regression (v2.7.x)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('does not throw when score rows reference an inactive tournament', async () => {
        const roomId = await createTestRoom();
        const db = await getDatabase();
        const tournamentId = 't-1';
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
             VALUES (?, 'Daily Grind', 'DG', 'pinball', '{}', 0, ?)`,
            tournamentId, roomId,
        );
        const identityId = await AnonymousIdentityService.upsert({ roomId, guildId: null, serverNickname: 'frozen-name' });
        await seedAnonRow({ roomId, nickname: 'frozen-name', tournamentId });

        // Should resolve cleanly — pre-fix this threw "no such column: end_date".
        const p = await preview(roomId, identityId, 'discord-T');
        expect(p.frozenStay.length).toBeGreaterThanOrEqual(0);
    });
});
