import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { StyleCatalogueService } from '../services/StyleCatalogueService.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';

/**
 * Per-game background framing (v2.115.0, migration 154).
 *
 * Three numbers on two overlay tables, resolved per FIELD on read. The things
 * worth pinning are the ones a screenshot can't show: that the columns exist at
 * all, that both write paths round-trip, that clearing means NULL (not 100/50/
 * 50 written out as data), and that a game's own framing outranks the room's
 * library default — the precedence that decides which of two saved values the
 * scoreboard actually renders.
 */

const FRAMING_COLUMNS = ['bg_zoom', 'bg_pos_x', 'bg_pos_y'];

async function columnsOf(table: string): Promise<Set<string>> {
    const db = await getDatabase();
    const rows = await db.all(`PRAGMA table_info(${table})`) as Array<{ name: string }>;
    return new Set(rows.map(r => r.name));
}

async function seedStyle(id = 'style-1'): Promise<string> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO style_catalogue (id, name, author, has_background, has_header, source)
         VALUES (?, 'Test Style', 'tester', 1, 1, 'upload')`,
        id,
    );
    return id;
}

async function seedLibraryRow(roomId: string, gameName: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`,
        roomId, gameName,
    );
}

describe('migration 154 — card background framing columns', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('adds the three framing columns to both overlay tables', async () => {
        for (const table of ['games', 'game_room_game_library']) {
            const cols = await columnsOf(table);
            for (const col of FRAMING_COLUMNS) {
                expect(cols.has(col), `${table}.${col}`).toBe(true);
            }
        }
    });

    it('defaults every existing row to NULL — unframed, not 100/50/50', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('framing_room', 'Framing Room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });

        const row = await db.get('SELECT bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBeNull();
        expect(row.bg_pos_x).toBeNull();
        expect(row.bg_pos_y).toBeNull();
    });
});

describe('framing write paths', () => {
    let roomId: string;
    let gameId: string;
    let styleId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('framing_room', 'Framing Room');
        const tournamentId = await createTestTournament(roomId);
        gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
        styleId = await seedStyle();
    });

    it('assignToGame round-trips the framing', async () => {
        const db = await getDatabase();
        const ok = await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 180, bgPosX: 25, bgPosY: 70 });
        expect(ok).toBe(true);

        const row = await db.get('SELECT bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBe(180);
        expect(row.bg_pos_x).toBe(25);
        expect(row.bg_pos_y).toBe(70);
    });

    it('assigning with no framing CLEARS it — new art starts unframed', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 200, bgPosX: 10, bgPosY: 90 });
        await StyleCatalogueService.assignToGame(gameId, styleId, false);

        const row = await db.get('SELECT bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBeNull();
        expect(row.bg_pos_x).toBeNull();
        expect(row.bg_pos_y).toBeNull();
    });

    it('removeFromGame clears the framing along with the style', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 150, bgPosX: 40, bgPosY: 60 });
        await StyleCatalogueService.removeFromGame(gameId);

        const row = await db.get('SELECT catalogue_style_id, bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.catalogue_style_id).toBeNull();
        expect(row.bg_zoom).toBeNull();
    });

    it('clamps out-of-range values rather than storing them', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 9999, bgPosX: -40, bgPosY: 400 });

        const row = await db.get('SELECT bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBe(300);
        expect(row.bg_pos_x).toBe(0);
        expect(row.bg_pos_y).toBe(100);
    });

    it('setRoomGameStyle round-trips the library default framing', async () => {
        await seedLibraryRow(roomId, 'Medieval Madness');
        const ok = await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', styleId, false, {
            bgZoom: 140, bgPosX: 33, bgPosY: 66,
        });
        expect(ok).toBe(true);

        const saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.bg_zoom).toBe(140);
        expect(saved?.bg_pos_x).toBe(33);
        expect(saved?.bg_pos_y).toBe(66);
    });

    it('clearing the library style clears its framing too', async () => {
        await seedLibraryRow(roomId, 'Medieval Madness');
        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', styleId, false, { bgZoom: 140, bgPosX: 33, bgPosY: 66 });
        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', null, false);

        const saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.catalogue_style_id).toBeNull();
        expect(saved?.bg_zoom).toBeNull();
    });
});

describe('framing read path — getActiveLeaderboards', () => {
    let roomId: string;
    let gameId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('framing_room', 'Framing Room');
        const tournamentId = await createTestTournament(roomId);
        gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
        // `games.game_room_id` is denormalized and the library join keys off it.
        const db = await getDatabase();
        await db.run('UPDATE games SET game_room_id = ? WHERE id = ?', roomId, gameId);
    });

    it('ships nulls when nothing is framed', async () => {
        const [card] = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(card.bgZoom).toBeNull();
        expect(card.bgPosX).toBeNull();
        expect(card.bgPosY).toBeNull();
    });

    it('falls back to the room library default', async () => {
        await seedLibraryRow(roomId, 'Medieval Madness');
        const db = await getDatabase();
        await db.run(
            `UPDATE game_room_game_library SET bg_zoom = 130, bg_pos_x = 20, bg_pos_y = 80
             WHERE game_room_id = ? AND game_name = ?`,
            roomId, 'Medieval Madness',
        );

        const [card] = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(card.bgZoom).toBe(130);
        expect(card.bgPosX).toBe(20);
        expect(card.bgPosY).toBe(80);
    });

    it('lets the game row outrank the library default, per field', async () => {
        await seedLibraryRow(roomId, 'Medieval Madness');
        const db = await getDatabase();
        await db.run(
            `UPDATE game_room_game_library SET bg_zoom = 130, bg_pos_x = 20, bg_pos_y = 80
             WHERE game_room_id = ? AND game_name = ?`,
            roomId, 'Medieval Madness',
        );
        // Only the zoom is set on the game itself — the two positions must
        // still come from the library rather than snapping back to default.
        await db.run('UPDATE games SET bg_zoom = 260 WHERE id = ?', gameId);

        const [card] = await LeaderboardService.getActiveLeaderboards(roomId);
        expect(card.bgZoom).toBe(260);
        expect(card.bgPosX).toBe(20);
        expect(card.bgPosY).toBe(80);
    });
});
