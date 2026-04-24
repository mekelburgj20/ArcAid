import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import {
    backfillGlobalGameId,
    auditAndCreateGlobalGamesUniqueIndex,
    deleteLegacyOrphanGames,
} from '../database/migrations/catalogueUnification.js';

/**
 * v2.4.0 Phase A — catalogue backfill. Verifies the migration handlers do what
 * the plan says: resolve names to global_game_id via upsert, respect type
 * (pinball vs video_game), cascade correctly, and drop orphans cleanly.
 */
describe('catalogue backfill (migration 069) + orphan delete (070)', () => {
    beforeEach(async () => {
        await setupTestDb();
        // Test harness runs migrations automatically, so global_game_id columns
        // and the unique index are already in place.
    });

    it('backfills game_library with a new global_games row when no match exists', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_library (name, mode, platforms) VALUES (?, ?, ?)`,
            'Medieval Madness', 'pinball', '["VPX"]',
        );

        await backfillGlobalGameId(db);

        const row = await db.get(`SELECT global_game_id FROM game_library WHERE name = ?`, 'Medieval Madness');
        expect(row?.global_game_id).toBeTruthy();

        const global = await db.get(`SELECT type FROM global_games WHERE id = ?`, row!.global_game_id);
        expect(global?.type).toBe('pinball');
    });

    it('respects type when backfilling a games row via tournament.mode', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tournamentId = await createTestTournament(roomId, { mode: 'video_game' });
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date)
             VALUES (?, ?, ?, 'ACTIVE', datetime('now'))`,
            'g1', tournamentId, 'Tron',
        );

        await backfillGlobalGameId(db);

        const game = await db.get(`SELECT global_game_id FROM games WHERE id = 'g1'`);
        expect(game?.global_game_id).toBeTruthy();
        const global = await db.get(`SELECT type FROM global_games WHERE id = ?`, game!.global_game_id);
        expect(global?.type).toBe('video_game');
    });

    it('does not merge pinball Tron with video-game Tron (cross-type guard)', async () => {
        const db = await getDatabase();
        // Seed a pinball Tron in the catalogue.
        await db.run(
            `INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`,
            'pin-tron', 'Tron',
        );

        // Pre-existing unique index (migration 068) allows (LOWER(name), type) pair;
        // a video_game Tron should upsert as a NEW row, not merge with the pinball one.
        await db.run(
            `INSERT INTO game_library (name, mode, platforms) VALUES (?, ?, ?)`,
            'Tron', 'video_game', '[]',
        );

        await backfillGlobalGameId(db);

        const lib = await db.get(`SELECT global_game_id FROM game_library WHERE name = 'Tron'`);
        expect(lib?.global_game_id).toBeTruthy();
        expect(lib!.global_game_id).not.toBe('pin-tron');

        const globalRows = await db.all(
            `SELECT id, type FROM global_games WHERE LOWER(name) = 'tron'`,
        );
        expect(globalRows.length).toBe(2);
        const types = (globalRows as Array<{ type: string }>).map(r => r.type).sort();
        expect(types).toEqual(['pinball', 'video_game']);
    });

    it('is idempotent — re-running skips already-linked rows', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_library (name, mode) VALUES (?, ?)`,
            'Attack from Mars', 'pinball',
        );

        await backfillGlobalGameId(db);
        const first = await db.get(`SELECT global_game_id FROM game_library WHERE name = 'Attack from Mars'`);
        expect(first?.global_game_id).toBeTruthy();
        const firstId = first!.global_game_id;

        await backfillGlobalGameId(db);
        const second = await db.get(`SELECT global_game_id FROM game_library WHERE name = 'Attack from Mars'`);
        expect(second?.global_game_id).toBe(firstId);
    });

    it('audit migration 068 auto-merges pre-existing duplicate (name,type) pairs', async () => {
        const db = await getDatabase();
        // Bypass the unique indexes by dropping them — simulates a pre-index DB
        // where legacy imports created duplicates with the same (name, type)
        // AND the same (coalesced) identity. Both 068 and 080 indexes need to
        // be dropped so the raw INSERT of the duplicate pair is allowed.
        await db.exec(`DROP INDEX IF EXISTS idx_global_games_name_type`);
        await db.exec(`DROP INDEX IF EXISTS idx_global_games_identity`);
        await db.run(
            `INSERT INTO global_games (id, name, type, status, opdb_id, created_at)
             VALUES (?, ?, 'pinball', 'approved', ?, '2025-01-01')`,
            'dup-rich', 'The Addams Family', 'OPDB-123',
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, status, created_at)
             VALUES (?, ?, 'pinball', 'approved', '2025-06-01')`,
            'dup-poor', 'The Addams Family',
        );

        await auditAndCreateGlobalGamesUniqueIndex(db);

        // The row with richer external-id fingerprint survives as canonical.
        const rows = await db.all(`SELECT id FROM global_games WHERE LOWER(name) = ?`, 'the addams family');
        expect(rows.length).toBe(1);
        expect((rows[0] as any).id).toBe('dup-rich');
    });

    it('deletes orphan games and unlinks score history (migration 070)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, start_date)
             VALUES (?, NULL, ?, 'ACTIVE', datetime('now'))`,
            'orphan-1', 'Walking Dead',
        );
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, discord_user_id, score, timestamp)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            'sub-1', 'orphan-1', 'alice', 'SYSTEM', 100,
        );

        await deleteLegacyOrphanGames(db);

        const game = await db.get(`SELECT id FROM games WHERE id = 'orphan-1'`);
        expect(game).toBeUndefined();

        // Submission row preserved, but unlinked from the deleted game.
        const sub = await db.get(`SELECT game_id, iscored_username, score FROM submissions WHERE id = 'sub-1'`);
        expect(sub).toBeDefined();
        expect(sub!.game_id).toBeNull();
        expect(sub!.score).toBe(100);
    });
});
