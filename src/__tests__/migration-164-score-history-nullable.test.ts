import { describe, it, expect, beforeEach } from 'vitest';
import sqlite3 from 'sqlite3';
import { open, type Database } from 'sqlite';
import { scoreHistoryRoomNullable } from '../database/migrations/scoreHistoryRoomNullable.js';

/**
 * Migration 164 — the `score_history` rebuild (v2.136.0, ADR 0018).
 *
 * This is the one migration on the Throwdowns arc that can lose production
 * data, so it is tested against a hand-built table rather than through
 * `initDatabase`: the point is to prove it survives the shape a REAL, long-lived
 * `score_history` has — a table whose columns arrived by ALTER over many
 * releases, carrying indexes, a CHECK constraint and a foreign key.
 *
 * The properties under test, in order of how much they would hurt:
 *
 *   1. No row is lost, and every column's value survives.
 *   2. A short copy is caught BEFORE the original is dropped.
 *   3. Indexes come back — including one added after the migration was written.
 *   4. It is idempotent and safe to re-run.
 */

/** A `score_history` shaped like production: ALTER-grown, indexed, constrained. */
async function legacyTable(db: Database) {
    await db.exec(`
        CREATE TABLE game_rooms (id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE score_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_name TEXT NOT NULL,
            game_room_id TEXT NOT NULL,
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
    // Columns that arrived later, exactly as production got them.
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
                 submitted_by_user_id, platform, engine, device, verified_by)
             VALUES (?, 'room-1', ?, ?, ?, ?, 'community', ?, 'vpx', 'vpx', 'pc', ?)`,
            `Game ${i}`, `g-${i}`, `Player${i}`, `u-${i}`, 1000 + i, `u-${i}`, i === 0 ? 'admin-1' : null,
        );
    }
}

let db: Database;

beforeEach(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await legacyTable(db);
});

describe('migration 164', () => {
    it('drops NOT NULL while preserving every row, column value and index', async () => {
        await seedRows(db, 25);
        const before = await db.all(`SELECT * FROM score_history ORDER BY id`);

        await scoreHistoryRoomNullable(db);

        const after = await db.all(`SELECT * FROM score_history ORDER BY id`);
        expect(after).toEqual(before);

        const cols = await db.all<Array<{ name: string; notnull: number }>>(`PRAGMA table_info(score_history)`);
        expect(cols.find(c => c.name === 'game_room_id')!.notnull).toBe(0);
        // Every other column keeps its constraint — this must be a surgical change.
        expect(cols.find(c => c.name === 'game_name')!.notnull).toBe(1);
        expect(cols.find(c => c.name === 'score')!.notnull).toBe(1);
        expect(cols.length).toBe(21);

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

    it('accepts a NULL room afterwards — the whole point', async () => {
        await scoreHistoryRoomNullable(db);
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('Medieval Madness', NULL, 'Wyo', 5000, 'community')`,
        );
        const row = await db.get<{ game_room_id: string | null }>(
            `SELECT game_room_id FROM score_history WHERE iscored_username = 'Wyo'`,
        );
        expect(row!.game_room_id).toBeNull();
    });

    it('keeps the foreign key working for room-scoped rows', async () => {
        await seedRows(db, 3);
        await scoreHistoryRoomNullable(db);
        await db.exec('PRAGMA foreign_keys = ON');

        // A bogus room is still refused …
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('X', 'no-such-room', 'Ann', 1, 'community')`,
        )).rejects.toThrow();

        // … and the cascade still reaches the rows that do have a room.
        await db.run(`DELETE FROM game_rooms WHERE id = 'room-1'`);
        const left = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM score_history`);
        expect(left!.n).toBe(0);
    });

    it('keeps the CHECK constraint on source', async () => {
        await scoreHistoryRoomNullable(db);
        await expect(db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('X', NULL, 'Ann', 1, 'bogus')`,
        )).rejects.toThrow();
    });

    it('preserves AUTOINCREMENT so ids never collide with deleted ones', async () => {
        await seedRows(db, 3);
        await db.run(`DELETE FROM score_history WHERE id = 3`);
        await scoreHistoryRoomNullable(db);
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source)
             VALUES ('Y', NULL, 'Bob', 1, 'community')`,
        );
        const row = await db.get<{ id: number }>(`SELECT id FROM score_history WHERE iscored_username = 'Bob'`);
        // With AUTOINCREMENT the next id is 4, not the reused 3.
        expect(row!.id).toBe(4);
    });

    it('is idempotent and a no-op on a second run', async () => {
        await seedRows(db, 5);
        await scoreHistoryRoomNullable(db);
        const first = await db.all(`SELECT * FROM score_history ORDER BY id`);
        await scoreHistoryRoomNullable(db);
        expect(await db.all(`SELECT * FROM score_history ORDER BY id`)).toEqual(first);
    });

    it('does nothing when the table does not exist yet', async () => {
        const fresh = await open({ filename: ':memory:', driver: sqlite3.Database });
        await expect(scoreHistoryRoomNullable(fresh)).resolves.toBeUndefined();
    });

    it('replays an index that was added after this migration was written', async () => {
        await db.exec(`CREATE INDEX idx_added_later ON score_history(verified_at)`);
        await scoreHistoryRoomNullable(db);
        const idx = await db.get(
            `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_added_later'`,
        );
        // Hardcoding the index list would have silently dropped this one.
        expect(idx).toBeDefined();
    });

    it('refuses to rebuild a schema it does not recognise, leaving data intact', async () => {
        const odd = await open({ filename: ':memory:', driver: sqlite3.Database });
        await odd.exec(`
            CREATE TABLE score_history (
                a TEXT, game_room_id TEXT NOT NULL, b TEXT, game_room_id_2 TEXT NOT NULL
            );
        `);
        // Two NOT NULL matches (the second column is a deliberate decoy) — the
        // transform is textual, so ambiguity must abort rather than guess.
        await odd.exec(`DROP TABLE score_history`);
        await odd.exec(`CREATE TABLE score_history (
            game_room_id TEXT NOT NULL,
            other_room_id TEXT,
            note TEXT DEFAULT 'game_room_id TEXT NOT NULL'
        )`);
        await odd.run(`INSERT INTO score_history (game_room_id) VALUES ('r')`);
        await expect(scoreHistoryRoomNullable(odd)).rejects.toThrow(/found 2/);
        const rows = await odd.all(`SELECT * FROM score_history`);
        expect(rows).toHaveLength(1);
    });
});
