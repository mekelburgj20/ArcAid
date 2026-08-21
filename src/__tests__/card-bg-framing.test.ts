import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { StyleCatalogueService } from '../services/StyleCatalogueService.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { normalizeFraming } from '../utils/bgFraming.js';
import { AssignStyleSchema, AssignFramingSchema } from '../api/schemas.js';

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

    // v2.119.0 (C2) — the floor moved 100 -> 50 so an admin can zoom OUT and
    // let the card show through around the art. v2.122.1 took it to 10, which
    // is what "fit the whole image" needs on a wide strip. Storage did not
    // change; only the bounds did, so the round-trip is the thing to pin.
    it('round-trips a zoomed-OUT value at the new 10 floor', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 10, bgPosX: 50, bgPosY: 50 });

        const row = await db.get('SELECT bg_zoom FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBe(10);
    });

    it('clamps below the floor rather than storing it', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, styleId, false, { bgZoom: 9, bgPosX: 50, bgPosY: 50 });

        const row = await db.get('SELECT bg_zoom FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBe(10);
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

/**
 * v2.119.0 (C2) — the zoom-out floor.
 *
 * Three clamp sites had to move together (`normalizeFraming`, the Zod bounds,
 * and `GameLibraryService`'s own clamp on the library-default path). A floor
 * left at 100 in any ONE of them turns a zoomed-out card into either a 400 at
 * the API boundary or a silent snap back to 100 on write, which is exactly the
 * class of drift a test is for.
 */
describe('zoom floor (v2.119.0, lowered v2.122.1)', () => {
    it('normalizeFraming accepts the floor and clamps below it (v2.122.1: 50 -> 10)', () => {
        expect(normalizeFraming({ bgZoom: 50, bgPosX: 10, bgPosY: 20 }).bgZoom).toBe(50);
        expect(normalizeFraming({ bgZoom: 9, bgPosX: 10, bgPosY: 20 }).bgZoom).toBe(10);
        expect(normalizeFraming({ bgZoom: 10, bgPosX: 10, bgPosY: 20 }).bgZoom).toBe(10);
        expect(normalizeFraming({ bgZoom: 49, bgPosX: 10, bgPosY: 20 }).bgZoom).toBe(49);
        expect(normalizeFraming({ bgZoom: 1, bgPosX: 10, bgPosY: 20 }).bgZoom).toBe(10);
    });

    it('leaves the pre-existing 100-300 behaviour alone', () => {
        expect(normalizeFraming({ bgZoom: 100 }).bgZoom).toBe(100);
        expect(normalizeFraming({ bgZoom: 300 }).bgZoom).toBe(300);
        expect(normalizeFraming({ bgZoom: 301 }).bgZoom).toBe(300);
        // An omitted framing object still CLEARS — unchanged, and load-bearing.
        expect(normalizeFraming()).toEqual({ bgZoom: null, bgPosX: null, bgPosY: null });
    });

    it('the write schema accepts the floor and rejects below it', () => {
        const base = { catalogueStyleId: 'style-1', headerDisabled: false, bgPosX: 50, bgPosY: 50 };
        expect(AssignStyleSchema.safeParse({ ...base, bgZoom: 10 }).success).toBe(true);
        expect(AssignStyleSchema.safeParse({ ...base, bgZoom: 9 }).success).toBe(false);
        // 50 was the v2.119 floor and is still perfectly valid data.
        expect(AssignStyleSchema.safeParse({ ...base, bgZoom: 50 }).success).toBe(true);
        expect(AssignStyleSchema.safeParse({ ...base, bgZoom: 300 }).success).toBe(true);
        expect(AssignStyleSchema.safeParse({ ...base, bgZoom: 301 }).success).toBe(false);
    });

    it('the library-default path stores a zoomed-OUT value too', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('zoomout_room', 'Zoom Out Room');
        await seedStyle('style-zo');
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`, roomId, 'Medieval Madness');

        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', 'style-zo', false, {
            bgZoom: 50, bgPosX: 50, bgPosY: 50,
        });
        expect((await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness'))?.bg_zoom).toBe(50);

        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', 'style-zo', false, {
            bgZoom: 9, bgPosX: 50, bgPosY: 50,
        });
        expect((await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness'))?.bg_zoom).toBe(10);
    });
});

/**
 * v2.119.0 (C2), build trap #5 — deleting a style used to null the style ids
 * and leave the framing columns behind, so the next background to land on that
 * card inherited a crop made for art that no longer exists. Live preview makes
 * that visible immediately, so it is fixed here: framing dies with the
 * background it was cropped for, exactly as `removeFromGame` already did.
 */
describe('style deletion clears the framing it described', () => {
    let roomId: string;
    let gameId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom('framing_room', 'Framing Room');
        const tournamentId = await createTestTournament(roomId);
        gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
        await seedStyle('style-a');
        await seedStyle('style-b');
    });

    it('clears the game framing when the deleted style WAS the background', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, 'style-a', false, { bgZoom: 200, bgPosX: 10, bgPosY: 90 });

        await StyleCatalogueService.delete('style-a');

        const row = await db.get('SELECT catalogue_style_id, bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.catalogue_style_id).toBeNull();
        expect(row.bg_zoom).toBeNull();
        expect(row.bg_pos_x).toBeNull();
        expect(row.bg_pos_y).toBeNull();
    });

    it('KEEPS the framing when a surviving bg override still supplies the art', async () => {
        const db = await getDatabase();
        await StyleCatalogueService.assignToGame(gameId, 'style-a', false, { bgZoom: 200, bgPosX: 10, bgPosY: 90 });
        // An independent background override outranks the catalogue style, so
        // deleting the catalogue style leaves the framed art in place.
        await db.run('UPDATE games SET bg_style_id = ? WHERE id = ?', 'style-b', gameId);

        await StyleCatalogueService.delete('style-a');

        const row = await db.get('SELECT bg_style_id, bg_zoom FROM games WHERE id = ?', gameId);
        expect(row.bg_style_id).toBe('style-b');
        expect(row.bg_zoom).toBe(200);
    });

    it('clears the library default framing the same way', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`, roomId, 'Medieval Madness');
        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', 'style-a', false, {
            bgZoom: 140, bgPosX: 33, bgPosY: 66,
        });

        await StyleCatalogueService.delete('style-a');

        const saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.bg_zoom).toBeNull();
        expect(saved?.bg_pos_x).toBeNull();
        expect(saved?.bg_pos_y).toBeNull();
    });
});


/**
 * v2.122.1 — the framing-ONLY endpoints.
 *
 * The style/image endpoints can only carry framing beside a style id, so a card
 * whose background is plain catalogue art could never be zoomed or dragged: the
 * editor had to grey Apply out. These two routes write the three framing
 * columns and nothing else, on any game the room owns.
 *
 * What is worth pinning here is the "and nothing else": a route that quietly
 * cleared `catalogue_style_id`, or that let a game from ANOTHER room be framed,
 * would be invisible in the UI and obvious in production.
 */
describe('PUT /:roomId/admin/games/:gameId/framing', () => {
    let app: express.Express;
    let roomId: string;
    let gameId: string;
    let token: string;

    beforeEach(async () => {
        await setupTestDb();
        app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);

        roomId = await createTestRoom('framing_api_room', 'Framing API Room');
        const tournamentId = await createTestTournament(roomId);
        gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
        token = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
    });

    const put = (body: unknown) =>
        request(app)
            .put(`/api/rooms/${roomId}/admin/games/${gameId}/framing`)
            .set('Authorization', `Bearer ${token}`)
            .send(body as object);

    it('writes ONLY the framing columns', async () => {
        const db = await getDatabase();
        await seedStyle('style-keep');
        await StyleCatalogueService.assignToGame(gameId, 'style-keep', true);

        const res = await put({ bgZoom: 65, bgPosX: 10, bgPosY: 90 });
        expect(res.status).toBe(200);

        const row = await db.get(
            `SELECT catalogue_style_id, style_header_disabled, logo_style_id, bg_style_id,
                    bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?`, gameId);
        expect(row.bg_zoom).toBe(65);
        expect(row.bg_pos_x).toBe(10);
        expect(row.bg_pos_y).toBe(90);
        // Untouched — this route knows nothing about art packs.
        expect(row.catalogue_style_id).toBe('style-keep');
        expect(row.style_header_disabled).toBe(1);
    });

    it('frames a card that has NO art pack at all — the whole point', async () => {
        const db = await getDatabase();
        const res = await put({ bgZoom: 50, bgPosX: 0, bgPosY: 100 });
        expect(res.status).toBe(200);
        const row = await db.get('SELECT catalogue_style_id, bg_zoom FROM games WHERE id = ?', gameId);
        expect(row.catalogue_style_id).toBeNull();
        expect(row.bg_zoom).toBe(50);
    });

    it('an omitted axis CLEARS — same doctrine as the style writes', async () => {
        const db = await getDatabase();
        await put({ bgZoom: 200, bgPosX: 20, bgPosY: 80 });
        const res = await put({});
        expect(res.status).toBe(200);
        const row = await db.get('SELECT bg_zoom, bg_pos_x, bg_pos_y FROM games WHERE id = ?', gameId);
        expect(row.bg_zoom).toBeNull();
        expect(row.bg_pos_x).toBeNull();
        expect(row.bg_pos_y).toBeNull();
    });

    it('rejects below the floor — out of range is a client bug, not a value to round', async () => {
        // v2.122.1: the floor is 10, so "fit the whole image" is reachable.
        expect((await put({ bgZoom: 10, bgPosX: 50, bgPosY: 50 })).status).toBe(200);
        expect((await put({ bgZoom: 9, bgPosX: 50, bgPosY: 50 })).status).toBe(400);
        expect((await put({ bgZoom: 301, bgPosX: 50, bgPosY: 50 })).status).toBe(400);
        expect((await put({ bgZoom: 100, bgPosX: 101, bgPosY: 50 })).status).toBe(400);
        expect(AssignFramingSchema.safeParse({ bgZoom: 9 }).success).toBe(false);
        expect(AssignFramingSchema.safeParse({ bgZoom: 10 }).success).toBe(true);
        expect(AssignFramingSchema.safeParse({}).success).toBe(true);
    });

    it('frames a PINNED game — LEFT JOIN, not the INNER JOIN its siblings use', async () => {
        const db = await getDatabase();
        // A pin is `tournament_id IS NULL` + an explicit game_room_id (ADR 0005).
        await db.run('UPDATE games SET tournament_id = NULL, game_room_id = ? WHERE id = ?', roomId, gameId);
        const res = await put({ bgZoom: 140, bgPosX: 30, bgPosY: 60 });
        expect(res.status).toBe(200);
        expect((await db.get('SELECT bg_zoom FROM games WHERE id = ?', gameId)).bg_zoom).toBe(140);
    });

    it('404s a game the room does not own, and 401s without a token', async () => {
        const otherRoom = await createTestRoom('other_room', 'Other Room');
        const otherTournament = await createTestTournament(otherRoom);
        const otherGame = await createTestGame(otherTournament, { name: 'Attack from Mars' });

        const cross = await request(app)
            .put(`/api/rooms/${roomId}/admin/games/${otherGame}/framing`)
            .set('Authorization', `Bearer ${token}`)
            .send({ bgZoom: 120, bgPosX: 50, bgPosY: 50 });
        expect(cross.status).toBe(404);

        const anon = await request(app)
            .put(`/api/rooms/${roomId}/admin/games/${gameId}/framing`)
            .send({ bgZoom: 120, bgPosX: 50, bgPosY: 50 });
        expect(anon.status).toBe(401);
    });
});

describe('PUT /:roomId/game_library/:name/framing', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        await setupTestDb();
        app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        roomId = await createTestRoom('framing_lib_room', 'Framing Library Room');
        token = signToken({ role: 'room_admin', gameRoomIds: [roomId] });
    });

    const put = (name: string, body: unknown) =>
        request(app)
            .put(`/api/rooms/${roomId}/game_library/${encodeURIComponent(name)}/framing`)
            .set('Authorization', `Bearer ${token}`)
            .send(body as object);

    it('UPSERTs — a game that never had a style assignment has no overlay row yet', async () => {
        const res = await put('Medieval Madness', { bgZoom: 75, bgPosX: 20, bgPosY: 40 });
        expect(res.status).toBe(200);
        const saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.bg_zoom).toBe(75);
        expect(saved?.bg_pos_x).toBe(20);
        expect(saved?.bg_pos_y).toBe(40);
        expect(saved?.catalogue_style_id).toBeNull();
    });

    it('leaves an existing row’s style alone and clears on omitted', async () => {
        await seedStyle('style-lib');
        await seedLibraryRow(roomId, 'Medieval Madness');
        await GameLibraryService.setRoomGameStyle(roomId, 'Medieval Madness', 'style-lib', true, {
            bgZoom: 150, bgPosX: 10, bgPosY: 10,
        });

        expect((await put('Medieval Madness', { bgZoom: 80, bgPosX: 60, bgPosY: 30 })).status).toBe(200);
        let saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.bg_zoom).toBe(80);
        expect(saved?.catalogue_style_id).toBe('style-lib');
        expect(saved?.style_header_disabled).toBe(1);

        expect((await put('Medieval Madness', {})).status).toBe(200);
        saved = await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness');
        expect(saved?.bg_zoom).toBeNull();
        expect(saved?.catalogue_style_id).toBe('style-lib');
    });

    it('rejects below the floor here too, and stores a 10', async () => {
        expect((await put('Medieval Madness', { bgZoom: 9, bgPosX: 50, bgPosY: 50 })).status).toBe(400);
        expect((await put('Medieval Madness', { bgZoom: 10, bgPosX: 50, bgPosY: 50 })).status).toBe(200);
        expect((await GameLibraryService.getRoomGameStyle(roomId, 'Medieval Madness'))?.bg_zoom).toBe(10);
    });
});
