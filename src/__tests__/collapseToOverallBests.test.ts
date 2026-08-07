import { describe, it, expect } from 'vitest';
import { collapseToOverallBests, type MyStatsRoomBestRaw, type MyStatsGlobalBestRaw } from '../api/routes/global.js';

/**
 * v2.83.0 — owner semantics revision unit tests for the pure cross-board
 * collapse function. No DB involved: these exercise `collapseToOverallBests`
 * directly against hand-built SQL-leg-shaped rows (the same shape
 * `StatsService.getPersonalBestsForIdentities` / `GlobalLeaderboardService
 * .getDirectBestsForIdentities` return).
 */

function roomRow(overrides: Partial<MyStatsRoomBestRaw>): MyStatsRoomBestRaw {
    return {
        game_name: 'Medieval Madness',
        best_score: 100,
        room_rank: 1,
        total_players: 1,
        achieved_at: '2026-01-01 00:00:00',
        room_id: 'room-1',
        room_slug: 'room-1-slug',
        room_name: 'Room One',
        room_logo_url: null,
        ...overrides,
    };
}

function globalRow(overrides: Partial<MyStatsGlobalBestRaw>): MyStatsGlobalBestRaw {
    return {
        game_name: 'Medieval Madness',
        best_score: 100,
        rank: 1,
        total_players: 1,
        achieved_at: '2026-01-01 00:00:00',
        global_game_id: 'gg-1',
        ...overrides,
    };
}

describe('collapseToOverallBests', () => {
    it('All scope: same game in two rooms collapses to ONE row on the higher board', () => {
        const rooms = [
            roomRow({ room_id: 'room-lo', room_name: 'Low Room', best_score: 500, achieved_at: '2026-01-01 00:00:00' }),
            roomRow({ room_id: 'room-hi', room_name: 'High Room', best_score: 900, achieved_at: '2026-01-02 00:00:00' }),
        ];
        const result = collapseToOverallBests(rooms, [], 'all');
        expect(result).toHaveLength(1);
        expect(result[0].room_id).toBe('room-hi');
        expect(result[0].best_score).toBe(900);
    });

    it('All scope: a tie across boards goes to the earliest achieved_at', () => {
        const rooms = [
            roomRow({ room_id: 'room-a', room_name: 'Room A', best_score: 700, achieved_at: '2026-03-05 00:00:00' }),
            roomRow({ room_id: 'room-b', room_name: 'Room B', best_score: 700, achieved_at: '2026-01-10 00:00:00' }),
        ];
        const result = collapseToOverallBests(rooms, [], 'all');
        expect(result).toHaveLength(1);
        expect(result[0].room_id).toBe('room-b');
        expect(result[0].achieved_at).toBe('2026-01-10 00:00:00');
    });

    it('Room scope: excludes a game whose overall best lives on another board', () => {
        const rooms = [
            roomRow({ room_id: 'room-lo', room_name: 'Low Room', best_score: 500 }),
            roomRow({ room_id: 'room-hi', room_name: 'High Room', best_score: 900 }),
        ];
        const lowScope = collapseToOverallBests(rooms, [], 'room-lo');
        expect(lowScope).toHaveLength(0);

        const hiScope = collapseToOverallBests(rooms, [], 'room-hi');
        expect(hiScope).toHaveLength(1);
        expect(hiScope[0].room_id).toBe('room-hi');
    });

    it('Room scope: a tie across two rooms counts as a match in BOTH room scopes', () => {
        const rooms = [
            roomRow({ room_id: 'room-a', room_name: 'Room A', best_score: 700, achieved_at: '2026-01-01 00:00:00' }),
            roomRow({ room_id: 'room-b', room_name: 'Room B', best_score: 700, achieved_at: '2026-02-01 00:00:00' }),
        ];
        const scopeA = collapseToOverallBests(rooms, [], 'room-a');
        const scopeB = collapseToOverallBests(rooms, [], 'room-b');
        expect(scopeA).toHaveLength(1);
        expect(scopeA[0].room_id).toBe('room-a');
        expect(scopeB).toHaveLength(1);
        expect(scopeB[0].room_id).toBe('room-b');
    });

    it('a direct-Global best beats a room best: All shows the GLOBAL row, every room scope excludes the game', () => {
        const rooms = [roomRow({ room_id: 'room-1', room_name: 'Room One', best_score: 400 })];
        const globals = [globalRow({ best_score: 900, global_game_id: 'gg-mm' })];

        const all = collapseToOverallBests(rooms, globals, 'all');
        expect(all).toHaveLength(1);
        expect(all[0].source).toBe('global');
        expect(all[0].global_game_id).toBe('gg-mm');

        const roomScope = collapseToOverallBests(rooms, globals, 'room-1');
        expect(roomScope).toHaveLength(0);
    });

    it('non-overlapping games each get their own row unaffected by other games in the map', () => {
        const rooms = [
            roomRow({ game_name: 'Fire!', room_id: 'room-1', best_score: 100 }),
        ];
        const globals = [
            globalRow({ game_name: 'Cosmic Cart Racing', best_score: 42, global_game_id: 'gg-cc' }),
        ];
        const all = collapseToOverallBests(rooms, globals, 'all');
        expect(all).toHaveLength(2);
        const names = all.map(r => r.game_name).sort();
        expect(names).toEqual(['Cosmic Cart Racing', 'Fire!']);
    });

    it('game-key matching is case-insensitive (LOWER(game_name) doctrine)', () => {
        const rooms = [
            roomRow({ game_name: 'medieval madness', room_id: 'room-lo', best_score: 500 }),
            roomRow({ game_name: 'Medieval Madness', room_id: 'room-hi', best_score: 900 }),
        ];
        const all = collapseToOverallBests(rooms, [], 'all');
        expect(all).toHaveLength(1);
        expect(all[0].room_id).toBe('room-hi');
    });

    it('empty input returns an empty list for both scopes', () => {
        expect(collapseToOverallBests([], [], 'all')).toEqual([]);
        expect(collapseToOverallBests([], [], 'room-1')).toEqual([]);
    });
});
