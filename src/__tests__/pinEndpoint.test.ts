import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import { pinGameToScoreboard, unpinGameFromScoreboard } from '../engine/gameCreation.js';

/**
 * v2.4.0 Phase D/E — pin-to-scoreboard backend. iScored creation is skipped
 * in tests (createOnIScored: false) so these tests don't depend on Playwright.
 */
describe('pinGameToScoreboard / unpinGameFromScoreboard', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`,
            'mm-test', 'Medieval Madness',
        );
        await db.run(
            `INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`,
            roomId, 'Medieval Madness',
        );
    });

    it('creates a pinned games row with tournament_id NULL and game_room_id set', async () => {
        const result = await pinGameToScoreboard({
            roomId, gameName: 'Medieval Madness', createOnIScored: false,
        });
        expect(result.gameId).toBeTruthy();
        expect(result.iscoredStatus).toBe('skipped');

        const db = await getDatabase();
        const row = await db.get(`SELECT tournament_id, game_room_id, status, global_game_id FROM games WHERE id = ?`, result.gameId);
        expect(row?.tournament_id).toBeNull();
        expect(row?.game_room_id).toBe(roomId);
        expect(row?.status).toBe('ACTIVE');
        expect(row?.global_game_id).toBeTruthy();
    });

    it('rejects a duplicate pin in the same room (unique partial index)', async () => {
        await pinGameToScoreboard({ roomId, gameName: 'Medieval Madness', createOnIScored: false });
        await expect(
            pinGameToScoreboard({ roomId, gameName: 'Medieval Madness', createOnIScored: false }),
        ).rejects.toThrow(/UNIQUE constraint failed/i);
    });

    it('allows the same name pinned in different rooms', async () => {
        const otherRoom = await createTestRoom('other-room', 'Other Room');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`,
            otherRoom, 'Medieval Madness',
        );
        const a = await pinGameToScoreboard({ roomId, gameName: 'Medieval Madness', createOnIScored: false });
        const b = await pinGameToScoreboard({ roomId: otherRoom, gameName: 'Medieval Madness', createOnIScored: false });
        expect(a.gameId).not.toBe(b.gameId);
    });

    it('unpin unlinks submissions (game_id = NULL) and deletes the row', async () => {
        const pinned = await pinGameToScoreboard({ roomId, gameName: 'Medieval Madness', createOnIScored: false });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO submissions (id, game_id, iscored_username, discord_user_id, score, timestamp)
             VALUES (?, ?, ?, ?, ?, datetime('now'))`,
            'sub-1', pinned.gameId, 'alice', 'SYSTEM', 42,
        );

        const result = await unpinGameFromScoreboard({ roomId, gameId: pinned.gameId, deleteOnIScored: false });
        expect(result.deleted).toBe(true);

        const game = await db.get(`SELECT id FROM games WHERE id = ?`, pinned.gameId);
        expect(game).toBeUndefined();

        const sub = await db.get(`SELECT game_id, score FROM submissions WHERE id = 'sub-1'`);
        expect(sub).toBeDefined();
        expect(sub!.game_id).toBeNull();
        expect(sub!.score).toBe(42);
    });

    it('unpin for a game in a different room returns deleted=false', async () => {
        const pinned = await pinGameToScoreboard({ roomId, gameName: 'Medieval Madness', createOnIScored: false });
        const otherRoom = await createTestRoom('other-room', 'Other Room');
        const result = await unpinGameFromScoreboard({ roomId: otherRoom, gameId: pinned.gameId });
        expect(result.deleted).toBe(false);
    });
});
