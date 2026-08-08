import { describe, it, expect } from 'vitest';
import {
    catalogueTypeMatchesTournamentMode,
    catalogueTypesForTournamentMode,
} from '../utils/tournamentMode.js';

/**
 * Pins the tournament-mode ↔ catalogue-type mapping (v2.87.0). Before this
 * helper, every eligibility site compared `tournaments.mode` ('pinball' |
 * 'videogame') against `global_games.type` ('pinball' | 'video_game' |
 * 'arcade') with a raw `===`/`!==`, so a 'videogame' tournament never
 * matched a 'video_game' or 'arcade' catalogue row — zero games, every time.
 */
describe('catalogueTypeMatchesTournamentMode', () => {
    it('videogame mode accepts video_game catalogue type', () => {
        expect(catalogueTypeMatchesTournamentMode('video_game', 'videogame')).toBe(true);
    });

    it('videogame mode accepts arcade catalogue type', () => {
        expect(catalogueTypeMatchesTournamentMode('arcade', 'videogame')).toBe(true);
    });

    it('videogame mode rejects pinball catalogue type', () => {
        expect(catalogueTypeMatchesTournamentMode('pinball', 'videogame')).toBe(false);
    });

    it('pinball mode keeps exact-match behavior', () => {
        expect(catalogueTypeMatchesTournamentMode('pinball', 'pinball')).toBe(true);
        expect(catalogueTypeMatchesTournamentMode('video_game', 'pinball')).toBe(false);
        expect(catalogueTypeMatchesTournamentMode('arcade', 'pinball')).toBe(false);
    });

    it('an unrecognized tournament mode falls back to exact-match', () => {
        expect(catalogueTypeMatchesTournamentMode('mystery', 'mystery')).toBe(true);
        expect(catalogueTypeMatchesTournamentMode('pinball', 'mystery')).toBe(false);
    });

    it('a falsy tournament mode matches everything (no mode filter applied)', () => {
        expect(catalogueTypeMatchesTournamentMode('pinball', null)).toBe(true);
        expect(catalogueTypeMatchesTournamentMode('video_game', undefined)).toBe(true);
        expect(catalogueTypeMatchesTournamentMode('arcade', '')).toBe(true);
    });

    it('a falsy catalogue type never matches a real tournament mode', () => {
        expect(catalogueTypeMatchesTournamentMode(null, 'pinball')).toBe(false);
        expect(catalogueTypeMatchesTournamentMode(undefined, 'videogame')).toBe(false);
    });
});

describe('catalogueTypesForTournamentMode', () => {
    it('videogame expands to video_game and arcade', () => {
        expect(catalogueTypesForTournamentMode('videogame')).toEqual(['video_game', 'arcade']);
    });

    it('pinball expands to itself only', () => {
        expect(catalogueTypesForTournamentMode('pinball')).toEqual(['pinball']);
    });

    it('an unrecognized mode expands to itself only', () => {
        expect(catalogueTypesForTournamentMode('mystery')).toEqual(['mystery']);
    });

    it('a falsy mode expands to an empty set', () => {
        expect(catalogueTypesForTournamentMode(null)).toEqual([]);
        expect(catalogueTypesForTournamentMode(undefined)).toEqual([]);
    });
});
