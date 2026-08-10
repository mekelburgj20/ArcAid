import { describe, it, expect } from 'vitest';
import { presetToRange, weekInputToRange, dateToWeekInput } from '../statsWindow';

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

describe('statsWindow', () => {
  describe('presetToRange', () => {
    // A known Wednesday (2026-08-05T12:00:00Z). Its ISO week runs
    // Mon 2026-08-03T00:00:00Z (inclusive) .. Mon 2026-08-10T00:00:00Z (exclusive).
    const wednesday = new Date('2026-08-05T12:00:00.000Z');

    it('"all" returns no bounds', () => {
      expect(presetToRange('all', wednesday)).toEqual({});
    });

    it('"this_week" is [Monday 00:00 UTC, next Monday 00:00 UTC)', () => {
      const { from, to } = presetToRange('this_week', wednesday);
      expect(from).toBe('2026-08-03T00:00:00.000Z');
      expect(to).toBe('2026-08-10T00:00:00.000Z');
    });

    it('"last_week" ends exactly where "this_week" begins (no gap, no overlap)', () => {
      const thisWeek = presetToRange('this_week', wednesday);
      const lastWeek = presetToRange('last_week', wednesday);
      expect(lastWeek.to).toBe(thisWeek.from);
      expect(lastWeek.from).toBe('2026-07-27T00:00:00.000Z');
    });

    it('"last4" spans this week plus the 3 preceding it (28 days total)', () => {
      const { from, to } = presetToRange('last4', wednesday);
      expect(from).toBe('2026-07-13T00:00:00.000Z');
      expect(to).toBe('2026-08-10T00:00:00.000Z'); // same exclusive end as "this_week"
      expect(new Date(to!).getTime() - new Date(from!).getTime()).toBe(4 * WEEK_MS);
    });

    it('a Monday-exact instant belongs to the week it starts, not the prior one', () => {
      const mondayMidnight = new Date('2026-08-03T00:00:00.000Z');
      const { from } = presetToRange('this_week', mondayMidnight);
      expect(from).toBe('2026-08-03T00:00:00.000Z');
    });

    it('a Sunday 23:59:59.999 instant still belongs to the week it is inside', () => {
      const sundayEnd = new Date('2026-08-09T23:59:59.999Z');
      const { from, to } = presetToRange('this_week', sundayEnd);
      expect(from).toBe('2026-08-03T00:00:00.000Z');
      expect(to).toBe('2026-08-10T00:00:00.000Z');
    });
  });

  describe('weekInputToRange', () => {
    it('returns null for a malformed value', () => {
      expect(weekInputToRange('not-a-week')).toBeNull();
      expect(weekInputToRange('2026-13')).toBeNull();
      expect(weekInputToRange('2026-W99')).toBeNull();
    });

    it('produces an exact 7-day [from, to) window', () => {
      const range = weekInputToRange('2026-W32');
      expect(range).not.toBeNull();
      const from = new Date(range!.from!).getTime();
      const to = new Date(range!.to!).getTime();
      expect(to - from).toBe(WEEK_MS);
      // Both bounds land on a Monday 00:00:00.000 UTC.
      expect(new Date(range!.from!).getUTCDay()).toBe(1);
      expect(range!.from!.endsWith('T00:00:00.000Z')).toBe(true);
    });

    it('week 32 of 2026 matches the known Monday computed above', () => {
      // 2026-08-03 is the Monday of ISO week 32, 2026 (cross-checked against
      // the presetToRange "this_week" case above via a shared instant).
      const range = weekInputToRange('2026-W32');
      expect(range).toEqual({ from: '2026-08-03T00:00:00.000Z', to: '2026-08-10T00:00:00.000Z' });
    });

    it('round-trips through dateToWeekInput for a sample of weeks', () => {
      const samples = ['2026-W01', '2026-W10', '2026-W32', '2026-W52', '2027-W01'];
      for (const w of samples) {
        const range = weekInputToRange(w);
        expect(range).not.toBeNull();
        const mid = new Date(new Date(range!.from!).getTime() + DAY_MS); // Tuesday of that week
        expect(dateToWeekInput(mid)).toBe(w);
      }
    });
  });
});
