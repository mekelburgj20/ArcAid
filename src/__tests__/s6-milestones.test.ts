import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MilestoneService } from '../services/MilestoneService.js';
import { LobbyFeedService } from '../services/LobbyFeedService.js';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';

/**
 * S6 milestone crossed-threshold + at-most-once regression tests.
 *
 * Locks in: crossed-threshold (count >= threshold, not exact-equals) detection,
 * at-most-once via the player_milestones_fired UNIQUE constraint, monotonic-safe
 * behavior under score deletes, and display-name resolution.
 */

// Insert N community_scores rows for (room, player) on N distinct games so the
// scores_submitted COUNT goes up by N. Distinct game names keep the
// number_ones path from incidentally crossing its own thresholds.
async function seedCommunityScores(
    roomId: string,
    username: string,
    n: number,
    discordUserId = 'ANON',
    startIndex = 0,
): Promise<void> {
    const db = await getDatabase();
    for (let i = 0; i < n; i++) {
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score)
             VALUES (?, ?, ?, ?, ?)`,
            `Game ${startIndex + i}`, roomId, username, discordUserId, 1000 + startIndex + i,
        );
    }
}

function emitsForScope(spy: ReturnType<typeof vi.spyOn>, scope: string, threshold?: number) {
    return spy.mock.calls.filter((call) => {
        const arg = call[0] as { metadata?: { milestone?: string; count?: number } };
        if (arg?.metadata?.milestone !== scope) return false;
        if (threshold !== undefined && arg?.metadata?.count !== threshold) return false;
        return true;
    });
}

describe('MilestoneService S6 — crossed-threshold + at-most-once', () => {
    let emitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
        await setupTestDb();
        emitSpy = vi.spyOn(LobbyFeedService, 'emit').mockResolvedValue(0);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('TEST 1 — fires exactly once when the count JUMPS PAST a threshold (9 -> 11)', async () => {
        const roomId = await createTestRoom();
        const username = 'jumper';
        const discordUserId = 'discord-jumper-1';

        // Seed 9 scores, then add 2 more so the live COUNT goes 9 -> 11 in one
        // observed step before checkAndEmit reads it.
        await seedCommunityScores(roomId, username, 9, discordUserId, 0);
        await seedCommunityScores(roomId, username, 2, discordUserId, 9);

        await MilestoneService.checkAndEmit(roomId, username, discordUserId);

        // Exactly one scores_submitted emission, and it references the 10th
        // score (the THRESHOLD, 10) — not the raw count (11).
        const scoreEmits = emitsForScope(emitSpy, 'scores_submitted');
        expect(scoreEmits).toHaveLength(1);
        const title = (scoreEmits[0]![0] as { title: string }).title;
        expect(title).toContain('10th score');
        expect(title).not.toContain('11th');
        expect((scoreEmits[0]![0] as { metadata: { count: number } }).metadata.count).toBe(10);

        // Exactly one tracking row for (roomId, playerKey, 'scores_submitted', 10).
        const db = await getDatabase();
        const playerKey = discordUserId ?? ('iscored:' + username.toLowerCase());
        const rows = await db.all(
            `SELECT * FROM player_milestones_fired
             WHERE game_room_id = ? AND player_key = ? AND scope = 'scores_submitted' AND threshold = 10`,
            roomId, playerKey,
        );
        expect(rows).toHaveLength(1);
    });

    it('TEST 2 — idempotent: re-running does NOT re-fire', async () => {
        const roomId = await createTestRoom();
        const username = 'jumper';
        const discordUserId = 'discord-jumper-1';

        await seedCommunityScores(roomId, username, 11, discordUserId, 0);
        await MilestoneService.checkAndEmit(roomId, username, discordUserId);
        expect(emitsForScope(emitSpy, 'scores_submitted', 10)).toHaveLength(1);

        // Clear call history and re-run with the same args (count still 11).
        emitSpy.mockClear();
        await MilestoneService.checkAndEmit(roomId, username, discordUserId);

        // No new scores_submitted threshold=10 emission.
        expect(emitsForScope(emitSpy, 'scores_submitted', 10)).toHaveLength(0);

        // Still exactly one tracking row — no duplicate inserted.
        const db = await getDatabase();
        const playerKey = discordUserId ?? ('iscored:' + username.toLowerCase());
        const rows = await db.all(
            `SELECT * FROM player_milestones_fired
             WHERE game_room_id = ? AND player_key = ? AND scope = 'scores_submitted' AND threshold = 10`,
            roomId, playerKey,
        );
        expect(rows).toHaveLength(1);
    });

    it('TEST 3 — double-fire / oscillation guard: count revisits the threshold', async () => {
        const roomId = await createTestRoom();
        const username = 'jumper';
        const discordUserId = 'discord-jumper-1';
        const db = await getDatabase();

        // Reach count = 11 and fire the 10 milestone.
        await seedCommunityScores(roomId, username, 11, discordUserId, 0);
        await MilestoneService.checkAndEmit(roomId, username, discordUserId);
        expect(emitsForScope(emitSpy, 'scores_submitted', 10)).toHaveLength(1);

        // Delete scores so the live count drops to 9 (oscillate below 10).
        await db.run(
            `DELETE FROM community_scores
             WHERE id IN (
                SELECT id FROM community_scores
                WHERE game_room_id = ? AND LOWER(iscored_username) = ?
                ORDER BY id DESC LIMIT 2
             )`,
            roomId, username.toLowerCase(),
        );
        // Add one back to return to 10 (revisit the threshold from the far side).
        await seedCommunityScores(roomId, username, 1, discordUserId, 100);

        emitSpy.mockClear();
        await MilestoneService.checkAndEmit(roomId, username, discordUserId);

        // The tracking row already exists — no re-fire. Pre-S6 includes(10)
        // would have re-emitted here.
        expect(emitsForScope(emitSpy, 'scores_submitted', 10)).toHaveLength(0);

        const rows = await db.all(
            `SELECT * FROM player_milestones_fired
             WHERE game_room_id = ? AND scope = 'scores_submitted' AND threshold = 10`,
            roomId,
        );
        expect(rows).toHaveLength(1);
    });

    it('TEST 4 — display name: resolved name, not raw alias', async () => {
        const roomId = await createTestRoom();
        const username = 'ace_77';
        const discordUserId = 'discord-ace';
        const db = await getDatabase();

        // Give the Discord user a display name distinct from the iScored alias.
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
            discordUserId, 'Ace',
        );

        // Cross a fresh threshold (25) — seed 25 scores.
        await seedCommunityScores(roomId, username, 25, discordUserId, 0);
        await MilestoneService.checkAndEmit(roomId, username, discordUserId);

        const scoreEmits = emitsForScope(emitSpy, 'scores_submitted', 25);
        expect(scoreEmits).toHaveLength(1);
        const title = (scoreEmits[0]![0] as { title: string }).title;
        expect(title).toContain('Ace');
        expect(title).not.toContain('ace_77');
    });
});
