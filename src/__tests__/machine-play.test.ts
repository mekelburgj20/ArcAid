import { describe, it, expect } from 'vitest';
import { MACHINE_PLAY_SOURCES, isMachinePlay, machinePlaySql } from '../utils/machinePlay.js';

describe('machinePlay', () => {
    it('lists only vpx', () => {
        expect([...MACHINE_PLAY_SOURCES]).toEqual(['vpx']);
    });

    it('treats vpx as a game and nothing else', () => {
        for (const s of ['atgames', 'tournament', 'community', 'sync', '', null, undefined]) {
            expect(isMachinePlay(s as string | null | undefined)).toBe(false);
        }
        expect(isMachinePlay('vpx')).toBe(true);
    });

    it('builds the SQL from the constant', () => {
        expect(machinePlaySql()).toBe(`sh.source IN ('vpx')`);
        expect(machinePlaySql('s')).toBe(`s.source IN ('vpx')`);
    });
});
