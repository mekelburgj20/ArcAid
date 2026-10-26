import { describe, it, expect } from 'vitest';
import { deviceRoutesTo, targetMode } from '../utils/witnessRouting.js';
import { entryAllowed } from '../utils/tournamentEntry.js';

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
        const none = { roomId: null, tournamentId: null, globalOnly: true };
        expect(deviceRoutesTo(none, game({ isMember: true }))).toBe(false);
        expect(deviceRoutesTo(none, game({ isRound: true, isParticipant: true, isMember: true }))).toBe(false);
    });

    it('W37 "All my rooms" (the default): any room the player belongs to, or a tournament they were entered into', () => {
        const all = { roomId: null, tournamentId: null };
        expect(deviceRoutesTo(all, game({ isMember: true }))).toBe(true);
        expect(deviceRoutesTo(all, game({ roomId: OTHER, isMember: true }))).toBe(true);
        expect(deviceRoutesTo(all, game({ isMember: false }))).toBe(false);
        // An admin-added participant who is not a member is still in.
        expect(deviceRoutesTo(all, game({ isRound: true, isParticipant: true, isMember: false }))).toBe(true);
        expect(targetMode(all)).toBe('all');
        expect(targetMode({ ...all, globalOnly: true })).toBe('global');
        expect(targetMode({ roomId: ROOM, tournamentId: null })).toBe('room');
        expect(targetMode({ roomId: ROOM, tournamentId: 't-1' })).toBe('tournament');
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

describe('entryAllowed (W37, ADR 0033 §1-2; closes W36)', () => {
    const base = { format: 'rotation' as const, roomless: false, checkinRequired: false, isMember: false, isParticipant: false };
    it('room membership is entry for a rotation and an event without check-in', () => {
        expect(entryAllowed({ ...base, isMember: true })).toBe(true);
        expect(entryAllowed({ ...base, format: 'event', isMember: true })).toBe(true);
        expect(entryAllowed(base)).toBe(false);
    });
    it('an event that requires check-in admits only participants, members or not', () => {
        const ev = { ...base, format: 'event' as const, checkinRequired: true };
        expect(entryAllowed({ ...ev, isMember: true })).toBe(false);
        expect(entryAllowed({ ...ev, isMember: true, isParticipant: true })).toBe(true);
        expect(entryAllowed({ ...ev, isParticipant: true })).toBe(true);
    });
    it('a Throwdown admits only a player who joined it', () => {
        const td = { ...base, format: 'event' as const, roomless: true };
        expect(entryAllowed({ ...td, isMember: true })).toBe(false);
        expect(entryAllowed({ ...td, isParticipant: true })).toBe(true);
    });
});
