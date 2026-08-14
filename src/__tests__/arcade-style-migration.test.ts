import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { seedArcadeStyleForLegacyRooms } from '../database/migrations/seedArcadeStyle.js';

/**
 * Migration 144 — legacy rooms adopt the Arcade card style (style-system
 * revamp Phase 1).
 *
 * A data migration gets exactly one chance to be right on a real deploy, so the
 * three things one can get wrong are covered here: the transform, what it
 * leaves alone, and re-runnability.
 *
 * Note the fixture shape. `setupTestDb()` runs the whole migration list, so any
 * room created by a helper AFTERWARDS is a legacy-shaped room (no settings rows
 * at all) — which is precisely the population this migration exists for. Rooms
 * that carry an explicit choice are seeded by hand below.
 */

async function styleOf(roomId: string): Promise<string | undefined> {
    const db = await getDatabase();
    const row = await db.get(
        `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'SCOREBOARD_STYLE'`,
        roomId,
    );
    return row?.value;
}

async function setStyle(roomId: string, value: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'SCOREBOARD_STYLE', ?)`,
        roomId, value,
    );
}

describe('migration 144 — seed Arcade for rooms with no card style', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('gives a room with no SCOREBOARD_STYLE row the arcade style', async () => {
        const legacy = await createTestRoom('legacy_room', 'Legacy Room');

        expect(await styleOf(legacy)).toBeUndefined();
        const changed = await seedArcadeStyleForLegacyRooms(await getDatabase());

        expect(changed).toBe(1);
        expect(await styleOf(legacy)).toBe('arcade');
    });

    it('leaves an explicitly chosen style alone — including the interim banner seed', async () => {
        // 'banner' is BOTH a deliberate admin choice and the value P0 seeded
        // between P0 and P1. Neither is convertible: an explicit row means the
        // room is already on the modern card path, so there is nothing here
        // that this migration is for.
        const banner = await createTestRoom('banner_room', 'Banner Room');
        const showcase = await createTestRoom('showcase_room', 'Showcase Room');
        const minimal = await createTestRoom('minimal_room', 'Minimal Room');
        await setStyle(banner, 'banner');
        await setStyle(showcase, 'showcase');
        await setStyle(minimal, 'minimal');

        const changed = await seedArcadeStyleForLegacyRooms(await getDatabase());

        expect(changed).toBe(0);
        expect(await styleOf(banner)).toBe('banner');
        expect(await styleOf(showcase)).toBe('showcase');
        expect(await styleOf(minimal)).toBe('minimal');
    });

    it('converts only the styleless rooms in a mixed population', async () => {
        const legacyA = await createTestRoom('mixed_legacy_a', 'A');
        const legacyB = await createTestRoom('mixed_legacy_b', 'B');
        const chosen = await createTestRoom('mixed_chosen', 'C');
        await setStyle(chosen, 'showcase');

        const changed = await seedArcadeStyleForLegacyRooms(await getDatabase());

        expect(changed).toBe(2);
        expect(await styleOf(legacyA)).toBe('arcade');
        expect(await styleOf(legacyB)).toBe('arcade');
        expect(await styleOf(chosen)).toBe('showcase');
    });

    it('is idempotent — a second run changes nothing', async () => {
        const legacy = await createTestRoom('rerun_room', 'Rerun Room');
        await seedArcadeStyleForLegacyRooms(await getDatabase());

        const changed = await seedArcadeStyleForLegacyRooms(await getDatabase());

        expect(changed).toBe(0);
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'SCOREBOARD_STYLE'`,
            legacy,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].value).toBe('arcade');
    });

    it('touches no other setting on the rooms it converts', async () => {
        const db = await getDatabase();
        const legacy = await createTestRoom('other_settings_room', 'Other Settings');
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'SCOREBOARD_THEME', 'neon-circuit')`,
            legacy,
        );

        await seedArcadeStyleForLegacyRooms(db);

        const rows = await db.all(
            `SELECT key, value FROM game_room_settings WHERE game_room_id = ? ORDER BY key`,
            legacy,
        );
        expect(rows.map((r: { key: string; value: string }) => [r.key, r.value])).toEqual([
            ['SCOREBOARD_STYLE', 'arcade'],
            ['SCOREBOARD_THEME', 'neon-circuit'],
        ]);
    });
});
