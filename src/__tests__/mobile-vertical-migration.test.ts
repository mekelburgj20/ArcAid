import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { clearMobileVerticalOptOut } from '../database/migrations/clearMobileVerticalOptOut.js';

/**
 * Migration 145 — clear stored `SCOREBOARD_MOBILE_VERTICAL = 'false'` so every
 * room falls back to the ON default (owner call, 2026-08-15).
 *
 * A data migration gets one chance to be right on a real deploy, so the three
 * things one can get wrong are covered: the transform, what it leaves alone,
 * and re-runnability.
 */

async function setSetting(roomId: string, key: string, value: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
        roomId, key, value,
    );
}

async function readSetting(roomId: string, key: string): Promise<string | undefined> {
    const db = await getDatabase();
    const row = await db.get(
        `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?`,
        roomId, key,
    );
    return row?.value;
}

describe('migration 145 — clear the Mobile Vertical Scroll opt-out', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('deletes the row for a room that opted out', async () => {
        const room = await createTestRoom('opted_out', 'Opted Out');
        await setSetting(room, 'SCOREBOARD_MOBILE_VERTICAL', 'false');

        const changed = await clearMobileVerticalOptOut(await getDatabase());

        expect(changed).toBe(1);
        // Deleted, NOT set to 'true' — absence is what tracks the product
        // default, so these rooms move with it if it ever changes again.
        expect(await readSetting(room, 'SCOREBOARD_MOBILE_VERTICAL')).toBeUndefined();
    });

    it('matches case-insensitively, since the value is written by more than one path', async () => {
        const room = await createTestRoom('shouty', 'Shouty');
        await setSetting(room, 'SCOREBOARD_MOBILE_VERTICAL', 'FALSE');

        await clearMobileVerticalOptOut(await getDatabase());

        expect(await readSetting(room, 'SCOREBOARD_MOBILE_VERTICAL')).toBeUndefined();
    });

    it('leaves an explicit opt-IN alone', async () => {
        const room = await createTestRoom('opted_in', 'Opted In');
        await setSetting(room, 'SCOREBOARD_MOBILE_VERTICAL', 'true');

        const changed = await clearMobileVerticalOptOut(await getDatabase());

        expect(changed).toBe(0);
        expect(await readSetting(room, 'SCOREBOARD_MOBILE_VERTICAL')).toBe('true');
    });

    it('touches no other setting, including other false-valued ones', async () => {
        const room = await createTestRoom('mixed', 'Mixed');
        await setSetting(room, 'SCOREBOARD_MOBILE_VERTICAL', 'false');
        await setSetting(room, 'SCOREBOARD_HIDE_EMPTY', 'false');
        await setSetting(room, 'SCOREBOARD_CARD_BG_FILL', 'false');
        await setSetting(room, 'SCOREBOARD_STYLE', 'arcade');

        await clearMobileVerticalOptOut(await getDatabase());

        expect(await readSetting(room, 'SCOREBOARD_MOBILE_VERTICAL')).toBeUndefined();
        // A room that deliberately turned OFF card background fill keeps that.
        expect(await readSetting(room, 'SCOREBOARD_CARD_BG_FILL')).toBe('false');
        expect(await readSetting(room, 'SCOREBOARD_HIDE_EMPTY')).toBe('false');
        expect(await readSetting(room, 'SCOREBOARD_STYLE')).toBe('arcade');
    });

    it('is a no-op on a re-run', async () => {
        const room = await createTestRoom('rerun', 'Rerun');
        await setSetting(room, 'SCOREBOARD_MOBILE_VERTICAL', 'false');

        await clearMobileVerticalOptOut(await getDatabase());
        const second = await clearMobileVerticalOptOut(await getDatabase());

        expect(second).toBe(0);
    });

    it('leaves a room that never stored the key untouched', async () => {
        const room = await createTestRoom('never_set', 'Never Set');

        const changed = await clearMobileVerticalOptOut(await getDatabase());

        expect(changed).toBe(0);
        expect(await readSetting(room, 'SCOREBOARD_MOBILE_VERTICAL')).toBeUndefined();
    });
});
