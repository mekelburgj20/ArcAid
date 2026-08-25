import { describe, it, expect, beforeEach } from 'vitest';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import { scoreHistorySourceAtgames } from '../database/migrations/scoreHistorySourceAtgames.js';

/**
 * Migration 167 — widening `score_history.source` to accept `'atgames'` (P7).
 *
 * The second rebuild of the biggest table in the app, and the same hazard as
 * migration 164: a bad copy loses scores. Tested against a hand-built table
 * rather than through `initDatabase`, because the point is to prove it survives
 * the shape a REAL, long-lived `score_history` has — ALTER-grown columns,
 * indexes, a CHECK constraint, a foreign key and an AUTOINCREMENT counter.
 *
 * Properties, in order of how much the failure would hurt:
 *
 *   1. No row is lost and no column value changes.
 *   2. The new value is accepted and the old three still are.
 *   3. Nothing ELSE about the table is loosened — a rebuild is a chance to
 *      accidentally drop a NOT NULL or a foreign key.
 *   4. Indexes and the AUTOINCREMENT high-water mark come back.
 *   5. Re-running is a no-op.
 */

/** A `score_history` shaped like production, before the widening. */
async function legacyTable(db: Database) {
    await db.exec(`
        CREATE TABLE game_rooms (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE score_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            game_room_id TEXT,
            game_id TEXT,
            iscored_username TEXT NOT NULL,
            discord_user_id TEXT DEFAULT 'SYSTEM',
            score INTEGER NOT NULL,
            photo_url TEXT,
            source TEXT NOT NULL DEFAULT 'tournament' CHECK(source IN ('tournament', 'community', 'sync')),
            created_at TEXT DEFAULT (datetime('now')),
            FOREIGN KEY (game_room_id) REFERENCES game_rooms (id) ON DELETE CASCADE
        );
    `);
    for (const col of [
        'submitted_from_room_id TEXT', 'submitted_during_tournament_id TEXT',
        'submitted_by_user_id TEXT', 'submitted_by_anonymous_name TEXT',
        'merged_from_anonymous_identity_id INTEGER', 'orphaned_at TEXT',
        'platform TEXT', 'engine TEXT', 'device TEXT',
        'verified_by TEXT', 'verified_at TEXT',
    ]) {
        await db.exec(`ALTER TABLE score_history ADD COLUMN ${col}`);
    }
    await db.exec(`
        CREATE INDEX idx_score_history_room_tourney ON score_history(submitted_from_room_id, submitted_during_tournament_id);
        CREATE INDEX idx_score_history_by_user ON score_history(submitted_by_user_id);
        CREATE INDEX idx_score_history_orphaned ON score_history(orphaned_at);
        CREATE INDEX idx_score_history_game_platform ON score_history(game_id, platform);
    `);
    await db.run(`INSERT INTO game_rooms (id, name) VALUES ('room-1', 'RTX')`);
}

async function seedRows(db: Database, n: number) {
    for (let i = 0; i < n; i++) {
        await db.run(
            `INSERT INTO score_history
                (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                 submitted_by_user_id, platform, engine, device)
             VALUES (?, 'room-1', ?, ?, ?, ?, ?, ?, 'vpx', 'vpx', 'pc')`,
            `Game ${i}`, `g-${i}`, `Player${i}`, `u-${i}`, 1000 + i,
            ['tournament', 'community', 'sync'][i % 3], `u-${i}`,
        );
    }
}

let db: Database;

beforeEach(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await legacyTable(db);
});

describe('migration 167', () => {
    it('preserves every row and column value through the rebuild', async () => {
        await seedRows(db, 25);
        const before = await db.all(`SELECT * FROM score_history ORDER BY id`);

        await scoreHistorySourceAtgames(db);

        expect(await db.all(`SELECT * FROM score_history ORDER BY id`)).toEqual(before);
        expect((await db.all(`PRAGMA table_info(score_history)`)).length).toBe(21);
    });

    it('accepts the new source and still accepts the old three', async () => {
        await scoreHistorySourceAtgames(db);
        for (const source of ['tournament', 'community', 'sync', 'atgames']) {
            await expect(db.run(
                `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
                 VALUES ('X', 'room-1', ?, 1, ?)`,
                `p-${source}`, source,
            )).resolves.toBeTruthy();
        }
    });

    it('still refuses a source nobody defined', async () => {
        // The CHECK has to be widened, not removed — an open column would let a
        // typo'd source through and quietly break every source-filtered read.
        await scoreHistorySourceAtgames(db);
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('X', 'room-1', 'Ann', 1, 'atgamez')`,
        )).rejects.toThrow();
    });

    it('leaves every other constraint alone', async () => {
        await scoreHistorySourceAtgames(db);

        const cols = await db.all<Array<{ name: string; notnull: number }>>(`PRAGMA table_info(score_history)`);
        expect(cols.find(c => c.name === 'game_name')!.notnull).toBe(1);
        expect(cols.find(c => c.name === 'score')!.notnull).toBe(1);
        // Migration 164's work must survive this rebuild.
        expect(cols.find(c => c.name === 'game_room_id')!.notnull).toBe(0);

        await db.exec('PRAGMA foreign_keys = ON');
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('X', 'no-such-room', 'Ann', 1, 'atgames')`,
        )).rejects.toThrow();
    });

    it('replays the indexes', async () => {
        await scoreHistorySourceAtgames(db);
        const indexes = await db.all<Array<{ name: string }>>(
            `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='score_history' AND sql IS NOT NULL`,
        );
        expect(indexes.map(i => i.name).sort()).toEqual([
            'idx_score_history_by_user',
            'idx_score_history_game_platform',
            'idx_score_history_orphaned',
            'idx_score_history_room_tourney',
        ]);
    });

    it('preserves AUTOINCREMENT so ids never collide with deleted ones', async () => {
        // `score_history.id` addresses the per-row delete endpoint — a reused id
        // means a stale request deletes somebody else's score.
        await seedRows(db, 3);
        await db.run(`DELETE FROM score_history WHERE id = 3`);
        await scoreHistorySourceAtgames(db);
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('Y', 'room-1', 'Bob', 1, 'atgames')`,
        );
        const row = await db.get<{ id: number }>(`SELECT id FROM score_history WHERE iscored_username = 'Bob'`);
        expect(row!.id).toBe(4);
    });

    it('is idempotent and a no-op on a second run', async () => {
        await seedRows(db, 5);
        await scoreHistorySourceAtgames(db);
        const first = await db.all(`SELECT * FROM score_history ORDER BY id`);

        await scoreHistorySourceAtgames(db);

        expect(await db.all(`SELECT * FROM score_history ORDER BY id`)).toEqual(first);
    });

    it('does nothing when the table does not exist yet', async () => {
        const fresh = await open({ filename: ':memory:', driver: sqlite3.Database });
        await expect(scoreHistorySourceAtgames(fresh)).resolves.toBeUndefined();
    });
});
