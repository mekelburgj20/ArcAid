import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { backfillHistoryForDedupVictims } from '../database/migrations/backfillHistoryForDedupVictims.js';

/**
 * Migration 176 — backfilling the `score_history` row a pre-v2.155.3 dedup
 * silently swallowed for a score submitted to a SECOND tournament running
 * the same table.
 *
 * Production shape (2026-09-06 19:17 UTC): `submissions` landed correctly on
 * tournament B's game (the resolver-correct half, v2.155.1/v2.155.2), but
 * `score_history` has ONLY the tournament-A row — the dedup swallowed B's.
 */
describe('migration 176 — backfillHistoryForDedupVictims', () => {
    async function seedFixture(roomSlug: string) {
        const db = await getDatabase();
        const roomId = await createTestRoom(roomSlug, roomSlug);
        const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
        const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameName = 'Black Rose';
        const gameA = await createTestGame(tournamentA, { name: gameName, status: 'ACTIVE' });
        const gameB = await createTestGame(tournamentB, { name: gameName, status: 'ACTIVE' });
        const username = 'Owner';
        const score = 945436670;

        // The sibling: the FIRST submit, correctly stamped A.
        const siblingCreatedAt = '2026-09-06 19:17:25';
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                platform, engine, device, photo_url, created_at
             ) VALUES (?, ?, ?, 'disc-owner', ?, 'community', ?, ?, 'disc-owner', 'real', 'real', 'real_cabinet', '/photos/p.jpg', ?)`,
            gameName, roomId, username, score, roomId, tournamentA, siblingCreatedAt,
        );

        // The victim: submissions landed on B (resolver-correct), 26s later,
        // but no matching score_history row for B exists — the bug.
        const submissionTimestamp = '2026-09-06T19:17:51.000Z';
        const submissionId = `${gameB}-${username.toLowerCase()}`;
        await db.run(
            `INSERT INTO submissions (
                id, game_id, discord_user_id, iscored_username, score, timestamp,
                submitted_from_room_id, submitted_during_tournament_id
             ) VALUES (?, ?, 'disc-owner', ?, ?, ?, ?, ?)`,
            submissionId, gameB, username, score, submissionTimestamp, roomId, tournamentB,
        );

        // A stale cache row for B's game — the card the incident showed as
        // never updating.
        await db.run(
            `INSERT INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, '{"v":1,"rows":[]}', ?)`,
            gameB, new Date().toISOString(),
        );

        return { db, roomId, tournamentA, tournamentB, gameName, gameA, gameB, username, score, submissionId };
    }

    it('inserts a score_history row cloned from the sibling, stamped with the victim tournament, game_id NULL', async () => {
        await setupTestDb();
        const fx = await seedFixture('backfill-victim');

        const result = await backfillHistoryForDedupVictims(fx.db as any);
        expect(result.inserted).toBe(1);

        const rows = await fx.db.all(
            `SELECT game_id, submitted_during_tournament_id, score, photo_url, platform, engine, device, submitted_by_user_id
             FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND submitted_during_tournament_id = ?`,
            fx.roomId, fx.gameName, fx.tournamentB,
        );
        expect(rows.length).toBe(1);
        const row = rows[0];
        expect(row.game_id).toBeNull();
        expect(row.score).toBe(fx.score);
        expect(row.photo_url).toBe('/photos/p.jpg');
        expect(row.platform).toBe('real');
        expect(row.engine).toBe('real');
        expect(row.device).toBe('real_cabinet');
        expect(row.submitted_by_user_id).toBe('disc-owner');

        const cacheB = await fx.db.get(`SELECT game_id FROM leaderboard_cache WHERE game_id = ?`, fx.gameB);
        expect(cacheB).toBeUndefined();

        const second = await backfillHistoryForDedupVictims(fx.db as any);
        expect(second.inserted).toBe(0);
    });

    it('inserts nothing when no sibling exists within 24 hours', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom('backfill-no-sibling', 'Backfill No Sibling');
        const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
        const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameName = 'Black Rose';
        await createTestGame(tournamentA, { name: gameName, status: 'ACTIVE' });
        const gameB = await createTestGame(tournamentB, { name: gameName, status: 'ACTIVE' });
        const username = 'Owner';
        const score = 12345;

        // The "sibling" is 3 days away — too old to be the same event.
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, created_at
             ) VALUES (?, ?, ?, 'disc-owner', ?, 'community', ?, ?, ?)`,
            gameName, roomId, username, score, roomId, tournamentA, '2026-09-03 19:17:25',
        );
        const submissionId = `${gameB}-${username.toLowerCase()}`;
        await db.run(
            `INSERT INTO submissions (
                id, game_id, discord_user_id, iscored_username, score, timestamp,
                submitted_from_room_id, submitted_during_tournament_id
             ) VALUES (?, ?, 'disc-owner', ?, ?, ?, ?, ?)`,
            submissionId, gameB, username, score, '2026-09-06T19:17:51.000Z', roomId, tournamentB,
        );

        const result = await backfillHistoryForDedupVictims(db as any);
        expect(result.inserted).toBe(0);

        const rows = await db.all(
            `SELECT id FROM score_history WHERE game_room_id = ? AND submitted_during_tournament_id = ?`,
            roomId, tournamentB,
        );
        expect(rows.length).toBe(0);
    });
});
