import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { silverballRoomsToGraphite } from '../database/migrations/silverballToGraphite.js';

/**
 * Migration 222 (v2.265.6) — rooms that were on Silverball go to Graphite.
 *
 * Migration 220 had already rewritten them to `dark`, so the migration learns
 * which rooms they were from the pre-deploy snapshots. These tests build such
 * snapshots in a temp folder: the right rooms move, a room that has picked
 * something else since is left alone, and nothing here can ever throw (a
 * handler migration that throws halts startup).
 */

let dir: string;

async function writeSnapshot(name: string, rows: Array<[roomId: string, theme: string]>) {
    const snap = await open({ filename: path.join(dir, name), driver: sqlite3.Database });
    await snap.exec('CREATE TABLE game_room_settings (game_room_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL)');
    for (const [roomId, theme] of rows) {
        await snap.run(`INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'UI_THEME', ?)`, roomId, theme);
    }
    await snap.close();
}

async function setRoomTheme(roomId: string, theme: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'UI_THEME', ?)
         ON CONFLICT(game_room_id, key) DO UPDATE SET value = excluded.value`,
        roomId, theme,
    );
}

async function roomTheme(roomId: string): Promise<string | undefined> {
    const db = await getDatabase();
    const row = await db.get(`SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'UI_THEME'`, roomId);
    return row?.value;
}

describe('migration 222 — Silverball rooms to Graphite', () => {
    beforeEach(async () => {
        await setupTestDb();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcaid-snap-'));
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('moves a room an older snapshot shows on Silverball, and only that room', async () => {
        const was = await createTestRoom('was-silverball', 'Was Silverball');
        const always = await createTestRoom('always-default', 'Always Default');
        const ember = await createTestRoom('was-ember', 'Was Ember');
        // What migration 220 left behind.
        await setRoomTheme(was, 'dark');
        await setRoomTheme(always, 'dark');
        await setRoomTheme(ember, 'backglass');
        await writeSnapshot('pre-deploy-20261123T010000Z.db', [[was, 'silverball'], [always, 'dark'], [ember, 'ember']]);
        // A newer snapshot, taken after 220 ran, no longer says so.
        await writeSnapshot('pre-deploy-20261124T060000Z.db', [[was, 'dark'], [always, 'dark'], [ember, 'backglass']]);

        const moved = await silverballRoomsToGraphite(await getDatabase(), dir);

        expect(moved).toBe(1);
        expect(await roomTheme(was)).toBe('graphite');
        expect(await roomTheme(always)).toBe('dark');
        expect(await roomTheme(ember)).toBe('backglass');
    });

    it('leaves a room whose admin has picked another theme since', async () => {
        const repicked = await createTestRoom('repicked', 'Repicked');
        await setRoomTheme(repicked, 'synthwave');
        await writeSnapshot('pre-deploy-20261123T010000Z.db', [[repicked, 'silverball']]);

        expect(await silverballRoomsToGraphite(await getDatabase(), dir)).toBe(0);
        expect(await roomTheme(repicked)).toBe('synthwave');
    });

    it('is safe to run twice', async () => {
        const was = await createTestRoom('was-silverball', 'Was Silverball');
        await setRoomTheme(was, 'dark');
        await writeSnapshot('pre-deploy-20261123T010000Z.db', [[was, 'silverball']]);
        const db = await getDatabase();

        expect(await silverballRoomsToGraphite(db, dir)).toBe(1);
        expect(await silverballRoomsToGraphite(db, dir)).toBe(0);
        expect(await roomTheme(was)).toBe('graphite');
    });

    it('does nothing, and does not throw, with no snapshot folder, an unreadable file or a room that is gone', async () => {
        const db = await getDatabase();
        expect(await silverballRoomsToGraphite(db, null)).toBe(0);
        expect(await silverballRoomsToGraphite(db, path.join(dir, 'missing'))).toBe(0);

        const was = await createTestRoom('was-silverball', 'Was Silverball');
        await setRoomTheme(was, 'dark');
        fs.writeFileSync(path.join(dir, 'pre-deploy-20261122T010000Z.db'), 'not a database');
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored: not a snapshot name');
        await writeSnapshot('pre-deploy-20261123T010000Z.db', [[was, 'silverball'], ['room-deleted-since', 'silverball']]);

        expect(await silverballRoomsToGraphite(db, dir)).toBe(1);
        expect(await roomTheme(was)).toBe('graphite');
    });
});
