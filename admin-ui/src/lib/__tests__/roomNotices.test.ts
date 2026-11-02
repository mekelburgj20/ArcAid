import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    ROOM_NOTICE_DISMISSED_EVENT, deviceNoticeKey, dismissNotice, eventNoticeKey, isNoticeDismissed, startsNoticeKey,
} from '../roomNotices';

/** W83 - the room-notice dismissal store. */

const STORE = 'arcaid_room_notices_dismissed:r1';
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('roomNotices (W83)', () => {
    it('dismisses per room and announces it', () => {
        const heard = vi.fn();
        window.addEventListener(ROOM_NOTICE_DISMISSED_EVENT, heard);
        dismissNotice('r1', 'event:e:live:round');
        window.removeEventListener(ROOM_NOTICE_DISMISSED_EVENT, heard);
        expect(isNoticeDismissed('r1', 'event:e:live:round')).toBe(true);
        expect(isNoticeDismissed('r2', 'event:e:live:round')).toBe(false);
        expect(isNoticeDismissed(null, 'event:e:live:round')).toBe(false);
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('ignores entries older than 7 days and prunes them on the next write', () => {
        const now = Date.now();
        localStorage.setItem(STORE, JSON.stringify({ old: now - 8 * DAY, recent: now - DAY }));
        expect(isNoticeDismissed('r1', 'old')).toBe(false);
        expect(isNoticeDismissed('r1', 'recent')).toBe(true);
        dismissNotice('r1', 'new');
        expect(Object.keys(JSON.parse(localStorage.getItem(STORE) as string)).sort()).toEqual(['new', 'recent']);
    });

    it('treats corrupt or unavailable storage as "nothing dismissed"', () => {
        localStorage.setItem(STORE, 'not json');
        expect(isNoticeDismissed('r1', 'x')).toBe(false);
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private mode'); });
        expect(() => dismissNotice('r1', 'x')).not.toThrow();
        expect(isNoticeDismissed('r1', 'x')).toBe(false);
    });

    it('builds content keys', () => {
        expect(eventNoticeKey('t1', false, true)).toBe('event:t1:upcoming:checkin');
        expect(eventNoticeKey('t1', true, false)).toBe('event:t1:live:round');
        expect(deviceNoticeKey({ deviceId: 'd', sendsHere: 'no', why: 'other_room', targetTournamentName: null })).toBe('device:d:no:other_room:');
        expect(startsNoticeKey(['Congo', 'Cactus Canyon'])).toBe('starts:Cactus Canyon|Congo');
    });
});
