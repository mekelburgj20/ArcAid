import fs from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { logInfo, logWarn } from '../../utils/logger.js';

/**
 * Migration 222 — v2.265.6. Rooms that were on Silverball go to Graphite.
 *
 * Migration 220 (v2.263.0, G29) folded the retired `silverball` room theme
 * onto the default (`dark`). The owner then ruled (2026-11-24) that Graphite,
 * the neutral grey, is the closer survivor, and `LEGACY_THEME_MAP` now says
 * so. That fixes every id still to be read, but not the rooms 220 already
 * rewrote: their stored value is a plain `dark`, the same as a room that
 * chose the default.
 *
 * The only record of which rooms those were is the pre-deploy snapshots
 * (`data/pre-deploy/pre-deploy-<UTC>.db`, newest 20, written before every
 * deploy by `tools/pre-deploy-snapshot.cjs`): the ones taken before v2.263.0
 * still hold `UI_THEME = 'silverball'`. This reads each snapshot read-only,
 * collects those room ids, and moves a room to `graphite` only while it still
 * holds the `dark` that 220 wrote (a room whose admin has picked another
 * theme since is left alone).
 *
 * Room defaults only. A viewer's personal theme is not touched: the owner's
 * ruling was about rooms.
 *
 * It NEVER throws: a handler migration that throws halts startup, and a
 * missing folder, an unreadable snapshot or an old schema is no reason to
 * keep the site down over a colour. Where there are no snapshots (a fresh
 * install, a dev machine, the test database) it does nothing.
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
};

const SNAPSHOT_NAME = /^pre-deploy-\d{8}T\d{6}Z\.db$/;

/** Room ids that one snapshot holds on Silverball; empty when it cannot be read. */
async function silverballRoomsIn(file: string): Promise<string[]> {
    let snapshot: Awaited<ReturnType<typeof open>> | null = null;
    try {
        snapshot = await open({ filename: file, driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
        const rows = await snapshot.all<{ game_room_id: string }[]>(
            `SELECT game_room_id FROM game_room_settings WHERE key = 'UI_THEME' AND value = 'silverball'`,
        );
        return rows.map(r => r.game_room_id);
    } catch (err) {
        logWarn(`[migration 222] snapshot ${path.basename(file)} not read: ${err instanceof Error ? err.message : err}`);
        return [];
    } finally {
        try { await snapshot?.close(); } catch { /* nothing to do */ }
    }
}

/**
 * @param snapshotDir the folder holding the pre-deploy snapshots, or null when
 *                    the database is not a file (tests).
 * @returns how many rooms were moved.
 */
export async function silverballRoomsToGraphite(db: Db, snapshotDir: string | null): Promise<number> {
    try {
        if (!snapshotDir || !fs.existsSync(snapshotDir)) {
            logInfo('[migration 222] no pre-deploy snapshots here; no room moved from Silverball to Graphite');
            return 0;
        }
        const files = fs.readdirSync(snapshotDir).filter(f => SNAPSHOT_NAME.test(f)).sort();
        const roomIds = new Set<string>();
        for (const f of files) {
            for (const id of await silverballRoomsIn(path.join(snapshotDir, f))) roomIds.add(id);
        }

        let moved = 0;
        for (const id of roomIds) {
            const res = await db.run(
                `UPDATE game_room_settings SET value = 'graphite'
                  WHERE key = 'UI_THEME' AND game_room_id = ? AND value = 'dark'`,
                id,
            );
            moved += res.changes ?? 0;
        }
        logInfo(
            `[migration 222] ${files.length} snapshot(s) read, ${roomIds.size} room(s) were on Silverball, ` +
            `${moved} moved to Graphite`,
        );
        return moved;
    } catch (err) {
        logWarn(`[migration 222] skipped: ${err instanceof Error ? err.message : err}`);
        return 0;
    }
}
