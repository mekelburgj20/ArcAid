import { describe, it, expect } from 'vitest';
import { lobbyCopyFor, LOBBY_STATUS_META } from '../lobbyStatus';

describe('lobbyCopyFor (W19)', () => {
    it('words no_checkin per device type', () => {
        expect(lobbyCopyFor('no_checkin', 'atgames').label).toBe('Open the Witness tile');
        expect(lobbyCopyFor('no_checkin', 'desktop').label).toBe('Close VPX to check in');
        expect(lobbyCopyFor('no_checkin', 'desktop').hint).toContain('within 2 minutes');
    });
    it('words table_open per device type', () => {
        expect(lobbyCopyFor('table_open', 'atgames').hint).toContain('tile');
        expect(lobbyCopyFor('table_open', 'desktop').hint).toContain('Castcade checks in again by itself');
    });
    it('words offline per device type', () => {
        expect(lobbyCopyFor('offline', 'atgames').label).toBe('Witness not responding');
        expect(lobbyCopyFor('offline', 'desktop').label).toBe('Castcade not responding');
    });
    it('falls back to the neutral meta for null/undefined type and device-neutral statuses', () => {
        expect(lobbyCopyFor('no_checkin', null)).toEqual({ label: LOBBY_STATUS_META.no_checkin.label, hint: LOBBY_STATUS_META.no_checkin.hint });
        expect(lobbyCopyFor('offline', undefined).label).toBe(LOBBY_STATUS_META.offline.label);
        for (const s of ['ready', 'not_routed', 'no_cabinet'] as const) {
            expect(lobbyCopyFor(s, 'desktop').label).toBe(LOBBY_STATUS_META[s].label);
        }
    });
});
