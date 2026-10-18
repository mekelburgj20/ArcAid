import { describe, it, expect } from 'vitest';
import { defaultSeasonState, describeSeasonPollTimes, getSeasonErrors, seasonPayload } from '../seasonForm';

describe('getSeasonErrors', () => {
  const on = { ...defaultSeasonState, enabled: true };

  it('is empty for the defaults and for a season that is off', () => {
    expect(getSeasonErrors(on, '0 0 * * 5')).toEqual([]);
    expect(getSeasonErrors({ ...on, enabled: false, tableCount: 0 }, '')).toEqual([]);
  });

  it('mirrors the server rules', () => {
    expect(getSeasonErrors({ ...on, tableCount: 0 }, '0 0 * * 5')).toHaveLength(1);
    expect(getSeasonErrors({ ...on, tableCount: 201 }, '0 0 * * 5')).toHaveLength(1);
    expect(getSeasonErrors({ ...on, closesBeforeH: 0, opensBeforeH: 5 }, '0 0 * * 5')).toHaveLength(1);
    expect(getSeasonErrors({ ...on, opensBeforeH: 3, closesBeforeH: 3 }, '0 0 * * 5')[0]).toMatch(/open earlier/);
    expect(getSeasonErrors({ ...on, opensBeforeH: 800 }, '0 0 * * 5')[0]).toMatch(/at most 768/);
    expect(getSeasonErrors(on, '')[0]).toMatch(/rotation schedule/);
  });
});

describe('describeSeasonPollTimes', () => {
  it('describes the worked example (Friday midnight ET, 96 h / 3 h)', () => {
    const text = describeSeasonPollTimes('0 0 * * 5', 'America/New_York', 96, 3)!;
    expect(text).toMatch(/^Opens Monday 12:00 AM \S+ · closes Thursday 9:00 PM \S+ · table starts Friday 12:00 AM \S+$/);
  });

  it('wraps across the week boundary', () => {
    expect(describeSeasonPollTimes('30 18 * * 1', 'UTC', 48, 1)).toMatch(/^Opens Saturday 6:30 PM .* closes Monday 5:30 PM .* table starts Monday 6:30 PM/);
  });

  it('treats cron day 7 as Sunday', () => {
    expect(describeSeasonPollTimes('0 12 * * 7', 'UTC', 24, 2)).toMatch(/table starts Sunday 12:00 PM/);
  });

  it('notes an offset longer than a week', () => {
    expect(describeSeasonPollTimes('0 0 * * 5', 'UTC', 200, 3)).toMatch(/\(1 week earlier\)/);
  });

  it('returns null for cadences it cannot describe', () => {
    expect(describeSeasonPollTimes('0 0 * * *', 'UTC', 96, 3)).toBeNull();
    expect(describeSeasonPollTimes('0 0 1 * *', 'UTC', 96, 3)).toBeNull();
    expect(describeSeasonPollTimes('0 0 * * 1-5', 'UTC', 96, 3)).toBeNull();
    expect(describeSeasonPollTimes(undefined, 'UTC', 96, 3)).toBeNull();
  });
});

describe('seasonPayload', () => {
  it('sends null to switch a season off', () => {
    expect(seasonPayload(defaultSeasonState)).toEqual({ season_table_count: null });
  });
});
