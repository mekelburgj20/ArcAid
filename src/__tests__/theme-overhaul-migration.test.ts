import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { themeOverhaul } from '../database/migrations/themeOverhaul.js';
import { LEGACY_THEME_MAP } from '../utils/themeIds.js';

/**
 * Migration 162 (v2.133.0) — every stored theme id folds forward.
 *
 * The migration itself runs at startup on the real DB, which means these tests
 * are re-running an ALREADY-APPLIED migration against seeded rows. That is
 * exactly the point: it has to be idempotent, and it has to reach all three
 * storage sites, because a retired id left behind is a `.theme-<gone>` class
 * that paints nothing and loses the owner's choice with no error anywhere.
 */

async function seedRoomTheme(roomId: string, theme: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'UI_THEME', ?)
         ON CONFLICT(game_room_id, key) DO UPDATE SET value = excluded.value`,
        roomId, theme,
    );
}

async function roomTheme(roomId: string): Promise<string | undefined> {
    const db = await getDatabase();
    const row = await db.get(
        `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'UI_THEME'`,
        roomId,
    );
    return row?.value;
}

async function seedUser(id: string, uiTheme: string | null, prefs: unknown) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_preferences (discord_user_id, ui_theme, scoreboard_prefs) VALUES (?, ?, ?)
         ON CONFLICT(discord_user_id) DO UPDATE SET ui_theme = excluded.ui_theme,
                                                   scoreboard_prefs = excluded.scoreboard_prefs`,
        id, uiTheme, prefs === undefined ? null : JSON.stringify(prefs),
    );
}

async function userRow(id: string) {
    const db = await getDatabase();
    const row = await db.get(
        'SELECT ui_theme, scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?', id,
    );
    return {
        ui_theme: row?.ui_theme ?? null,
        prefs: row?.scoreboard_prefs ? JSON.parse(row.scoreboard_prefs) : null,
    };
}

describe('migration 162 — theme overhaul', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('rewrites a room default that names a retired theme', async () => {
        const gone = await createTestRoom('gone-room', 'Gone');
        const kept = await createTestRoom('kept-room', 'Kept');
        await seedRoomTheme(gone, 'cyberpunk');
        await seedRoomTheme(kept, 'plasma');

        await themeOverhaul(await getDatabase());

        expect(await roomTheme(gone)).toBe('synthwave');
        expect(await roomTheme(kept)).toBe('plasma');
    });

    it('rewrites a personal theme, and leaves NULL (= use the room default) alone', async () => {
        await seedUser('u-legacy', 'ocean', undefined);
        await seedUser('u-null', null, undefined);
        await seedUser('u-live', 'backglass', undefined);

        await themeOverhaul(await getDatabase());

        expect((await userRow('u-legacy')).ui_theme).toBe('midnight');
        expect((await userRow('u-null')).ui_theme).toBeNull();
        expect((await userRow('u-live')).ui_theme).toBe('backglass');
    });

    it('rewrites the roomThemes map inside scoreboard_prefs', async () => {
        await seedUser('u-map', null, {
            desktop: { SCOREBOARD_STYLE: 'minimal' },
            mobile: {},
            roomThemes: { 'room-a': 'coffee', 'room-b': 'silverball', 'room-c': 'playfield' },
        });

        await themeOverhaul(await getDatabase());

        const { prefs } = await userRow('u-map');
        expect(prefs.roomThemes).toEqual({
            'room-a': 'paper', 'room-b': 'silverball', 'room-c': 'forest',
        });
        // SCOREBOARD_STYLE 'minimal' is a CARD STYLE, not a theme — the
        // migration must not confuse the two namespaces.
        expect(prefs.desktop.SCOREBOARD_STYLE).toBe('minimal');
    });

    it('rewrites the pre-v2.132 per-device UI_THEME residue', async () => {
        await seedUser('u-device', null, {
            desktop: { UI_THEME: 'sunset' },
            mobile: { UI_THEME: 'crt-green' },
            roomThemes: {},
        });

        await themeOverhaul(await getDatabase());

        const { prefs } = await userRow('u-device');
        expect(prefs.desktop.UI_THEME).toBe('ember');
        expect(prefs.mobile.UI_THEME).toBe('retro');
    });

    it('covers every entry in LEGACY_THEME_MAP', async () => {
        const legacies = Object.keys(LEGACY_THEME_MAP);
        for (const legacy of legacies) await seedUser(`u-${legacy}`, legacy, undefined);

        await themeOverhaul(await getDatabase());

        for (const legacy of legacies) {
            expect((await userRow(`u-${legacy}`)).ui_theme, legacy).toBe(LEGACY_THEME_MAP[legacy]);
        }
    });

    it('is idempotent and leaves unparseable / unrelated blobs untouched', async () => {
        const room = await createTestRoom('idem-room', 'Idem');
        await seedRoomTheme(room, 'wizard');
        await seedUser('u-idem', 'marquee', { roomThemes: { r: 'invaders' } });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)`,
            'u-garbage', 'not json at all',
        );

        await themeOverhaul(db);
        const first = await userRow('u-idem');
        await themeOverhaul(db);
        const second = await userRow('u-idem');

        expect(await roomTheme(room)).toBe('plasma');
        expect(first.ui_theme).toBe('dark');
        expect(first.prefs.roomThemes).toEqual({ r: 'forest' });
        expect(second).toEqual(first);
        expect((await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?', 'u-garbage',
        ))?.scoreboard_prefs).toBe('not json at all');
    });
});
