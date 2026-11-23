import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { themeOverhaul, remapRetiredThemeIds } from '../database/migrations/themeOverhaul.js';
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
        await seedRoomTheme(kept, 'nordic');

        await themeOverhaul(await getDatabase());

        expect(await roomTheme(gone)).toBe('synthwave');
        expect(await roomTheme(kept)).toBe('nordic');
    });

    it('rewrites a personal theme, and leaves NULL (= use the room default) alone', async () => {
        await seedUser('u-legacy', 'ocean', undefined);
        await seedUser('u-null', null, undefined);
        await seedUser('u-live', 'backglass', undefined);

        await themeOverhaul(await getDatabase());

        expect((await userRow('u-legacy')).ui_theme).toBe('dark');
        expect((await userRow('u-null')).ui_theme).toBeNull();
        expect((await userRow('u-live')).ui_theme).toBe('backglass');
    });

    it('rewrites the roomThemes map inside scoreboard_prefs', async () => {
        await seedUser('u-map', null, {
            desktop: { SCOREBOARD_STYLE: 'minimal' },
            mobile: {},
            roomThemes: { 'room-a': 'coffee', 'room-b': 'graphite', 'room-c': 'playfield' },
        });

        await themeOverhaul(await getDatabase());

        const { prefs } = await userRow('u-map');
        expect(prefs.roomThemes).toEqual({
            'room-a': 'paper', 'room-b': 'graphite', 'room-c': 'forest',
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
        expect(prefs.desktop.UI_THEME).toBe('backglass');
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

        expect(await roomTheme(room)).toBe('synthwave');
        expect(first.ui_theme).toBe('dark');
        expect(first.prefs.roomThemes).toEqual({ r: 'forest' });
        expect(second).toEqual(first);
        expect((await db.get(
            'SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?', 'u-garbage',
        ))?.scoreboard_prefs).toBe('not json at all');
    });
});

/**
 * Migration 220 (v2.263.0, G29): the sweep from sixteen themes to eleven.
 * Five more ids are retired, and the same rewrite moves them.
 */
describe('migration 220 — theme sweep', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    /** The DB, counting the rows every UPDATE changes. */
    async function countingDb() {
        const db = await getDatabase();
        let written = 0;
        const wrapped = {
            run: async (sql: string, ...params: unknown[]) => {
                const result = await db.run(sql, ...params);
                if (/^\s*UPDATE/i.test(sql)) written += result.changes ?? 0;
                return result;
            },
            all: <T = unknown>(sql: string, ...params: unknown[]) => db.all(sql, ...params) as Promise<T[]>,
        };
        return { db: wrapped, written: () => written };
    }

    it('moves rooms, personal themes and room overrides off the five retired themes', async () => {
        const silverball = await createTestRoom('silverball-room', 'Silverball');
        const plasma = await createTestRoom('plasma-room', 'Plasma');
        const ember = await createTestRoom('ember-room', 'Ember');
        const survivor = await createTestRoom('survivor-room', 'Survivor');
        await seedRoomTheme(silverball, 'silverball');
        await seedRoomTheme(plasma, 'plasma');
        await seedRoomTheme(ember, 'ember');
        await seedRoomTheme(survivor, 'backglass');
        await seedUser('u-midnight', 'midnight', {
            desktop: {},
            mobile: {},
            roomThemes: { 'room-a': 'arctic', 'room-b': 'paper' },
        });
        await seedUser('u-survivor', 'nordic', { roomThemes: { 'room-a': 'forest' } });
        await seedUser('u-device', null, { desktop: { UI_THEME: 'ember' }, mobile: { UI_THEME: 'arctic' } });

        await remapRetiredThemeIds(await getDatabase(), 'migration 220');

        expect(await roomTheme(silverball)).toBe('dark');
        expect(await roomTheme(plasma)).toBe('synthwave');
        expect(await roomTheme(ember)).toBe('backglass');
        expect(await roomTheme(survivor)).toBe('backglass');
        const midnight = await userRow('u-midnight');
        expect(midnight.ui_theme).toBe('dark');
        expect(midnight.prefs.roomThemes).toEqual({ 'room-a': 'light', 'room-b': 'paper' });
        const kept = await userRow('u-survivor');
        expect(kept.ui_theme).toBe('nordic');
        expect(kept.prefs.roomThemes).toEqual({ 'room-a': 'forest' });
        const device = await userRow('u-device');
        expect(device.prefs.desktop.UI_THEME).toBe('backglass');
        expect(device.prefs.mobile.UI_THEME).toBe('light');
    });

    it('moves the three ids that used to point at a retired theme straight to a survivor', async () => {
        await seedUser('u-ocean', 'ocean', undefined);
        await seedUser('u-wizard', 'wizard', undefined);
        await seedUser('u-sunset', 'sunset', undefined);

        await remapRetiredThemeIds(await getDatabase(), 'migration 220');

        expect((await userRow('u-ocean')).ui_theme).toBe('dark');
        expect((await userRow('u-wizard')).ui_theme).toBe('synthwave');
        expect((await userRow('u-sunset')).ui_theme).toBe('backglass');
    });

    it('writes nothing on a second run', async () => {
        const room = await createTestRoom('sweep-idem', 'Sweep');
        await seedRoomTheme(room, 'plasma');
        await seedUser('u-sweep', 'midnight', { roomThemes: { r: 'arctic' }, desktop: { UI_THEME: 'silverball' }, mobile: {} });

        const first = await countingDb();
        await remapRetiredThemeIds(first.db, 'migration 220');
        expect(first.written()).toBe(3);
        const after = await userRow('u-sweep');

        const second = await countingDb();
        await remapRetiredThemeIds(second.db, 'migration 220');
        expect(second.written()).toBe(0);
        expect(await userRow('u-sweep')).toEqual(after);
        expect(await roomTheme(room)).toBe('synthwave');
    });
});
