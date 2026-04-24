import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb, createTestRoom } from './helpers.js';
import { GameLibraryService } from '../services/GameLibraryService.js';
import { mergeEffectivePlatforms } from '../utils/platformRules.js';

/**
 * v2.4.0 Phase B — per-room overlay (custom_platforms + display_name) on
 * game_room_game_library. Tournament platform rules use the effective set
 * (library ∪ per-room).
 */
describe('per-room library overlay', () => {
    let roomId: string;

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_library (name, mode, platforms) VALUES (?, ?, ?)`,
            'Gorgar', 'pinball', '["IRL"]',
        );
        await db.run(
            `INSERT INTO game_room_game_library (game_room_id, game_name) VALUES (?, ?)`,
            roomId, 'Gorgar',
        );
    });

    it('mergeEffectivePlatforms unions library + per-room custom, case-insensitive dedup', () => {
        const merged = mergeEffectivePlatforms('["VPX"]', '["WMS","vpx"]');
        expect(merged).toEqual(['VPX', 'WMS']);
    });

    it('setRoomCustomPlatforms persists and is reflected by getEffectivePlatformsForGame', async () => {
        await GameLibraryService.setRoomCustomPlatforms(roomId, 'Gorgar', ['WMS']);
        const effective = await GameLibraryService.getEffectivePlatformsForGame(roomId, 'Gorgar');
        expect(effective.sort()).toEqual(['IRL', 'WMS']);
    });

    it('setRoomDisplayName persists nullable override', async () => {
        await GameLibraryService.setRoomDisplayName(roomId, 'Gorgar', 'GORGAR!');
        const db = await getDatabase();
        const row = await db.get(
            `SELECT display_name FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?`,
            roomId, 'Gorgar',
        );
        expect(row?.display_name).toBe('GORGAR!');

        await GameLibraryService.setRoomDisplayName(roomId, 'Gorgar', null);
        const cleared = await db.get(
            `SELECT display_name FROM game_room_game_library WHERE game_room_id = ? AND game_name = ?`,
            roomId, 'Gorgar',
        );
        expect(cleared?.display_name).toBeNull();
    });

    it('clearing custom_platforms removes the per-room tags but leaves library platforms', async () => {
        await GameLibraryService.setRoomCustomPlatforms(roomId, 'Gorgar', ['WMS']);
        await GameLibraryService.setRoomCustomPlatforms(roomId, 'Gorgar', []);
        const effective = await GameLibraryService.getEffectivePlatformsForGame(roomId, 'Gorgar');
        expect(effective).toEqual(['IRL']);
    });
});
