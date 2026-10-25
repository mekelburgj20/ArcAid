import { describe, it, expect } from 'vitest';
import { deviceRoutesTo } from '../utils/witnessRouting.js';

/**
 * W26 (ADR 0032; owner rulings 2026-10-24 / 2026-10-25) — the ONE rule for
 * where a Witness device's score may land, shared by ingest and the lobby.
 */
const ROOM = 'room-1';
const OTHER = 'room-2';
const game = (over: Partial<Parameters<typeof deviceRoutesTo>[1]> = {}) => ({
    roomId: ROOM, tournamentId: 't-1', isRound: false, isParticipant: false, ...over,
});

describe('deviceRoutesTo', () => {
    it('"Global Scoreboard only" reaches no room game: rotation, joined room event, nothing', () => {
        const none = { roomId: null, tournamentId: null };
        expect(deviceRoutesTo(none, game())).toBe(false);
        expect(deviceRoutesTo(none, game({ isRound: true, isParticipant: true }))).toBe(false);
    });

    it('a room reaches that room\'s games only', () => {
        expect(deviceRoutesTo({ roomId: ROOM, tournamentId: null }, game())).toBe(true);
        expect(deviceRoutesTo({ roomId: OTHER, tournamentId: null }, game())).toBe(false);
    });

    it('a pinned tournament reaches that tournament only', () => {
        const pinned = { roomId: ROOM, tournamentId: 't-1' };
        expect(deviceRoutesTo(pinned, game())).toBe(true);
        expect(deviceRoutesTo(pinned, game({ tournamentId: 't-2' }))).toBe(false);
    });

    it('a JOINED Throwdown (room-less round) is reachable from any un-pinned device; never a pinned one', () => {
        const throwdown = game({ roomId: null, tournamentId: 'td', isRound: true, isParticipant: true });
        expect(deviceRoutesTo({ roomId: null, tournamentId: null }, throwdown)).toBe(true);
        expect(deviceRoutesTo({ roomId: ROOM, tournamentId: null }, throwdown)).toBe(true);
        expect(deviceRoutesTo({ roomId: ROOM, tournamentId: 't-1' }, throwdown)).toBe(false);
        // Not joined -> no.
        expect(deviceRoutesTo({ roomId: null, tournamentId: null }, { ...throwdown, isParticipant: false })).toBe(false);
    });
});
