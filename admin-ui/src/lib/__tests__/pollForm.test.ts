import { describe, it, expect } from 'vitest';
import {
  defaultPollState, describePollTimes, getPollErrors, pollPayload, pollStateFromRow, TIE_RULE_LABEL,
} from '../pollForm';

/** Pick by poll — a Game Rotation method (ADR 0026). */

describe('getPollErrors', () => {
  const on = { ...defaultPollState, enabled: true };

  it('is empty for the defaults and for a poll that is off', () => {
    expect(getPollErrors(on, '0 0 * * 5')).toEqual([]);
    expect(getPollErrors({ ...on, enabled: false, closesBeforeH: 0 }, '')).toEqual([]);
  });

  it('mirrors the server rules', () => {
    expect(getPollErrors({ ...on, closesBeforeH: 0, opensBeforeH: 5 }, '0 0 * * 5')).toHaveLength(1);
    expect(getPollErrors({ ...on, opensBeforeH: 3, closesBeforeH: 3 }, '0 0 * * 5')[0]).toMatch(/open earlier/);
    expect(getPollErrors({ ...on, opensBeforeH: 800 }, '0 0 * * 5')[0]).toMatch(/at most 768/);
    expect(getPollErrors(on, '')[0]).toMatch(/Pick by poll needs a rotation schedule/);
  });
});

describe('describePollTimes', () => {
  it('describes the worked example (Friday midnight ET, 96 h / 3 h)', () => {
    const text = describePollTimes('0 0 * * 5', 'America/New_York', 96, 3)!;
    expect(text).toMatch(/^Opens Monday 12:00 AM \S+ · closes Thursday 9:00 PM \S+ · table starts Friday 12:00 AM \S+$/);
  });

  it('wraps across the week boundary', () => {
    expect(describePollTimes('30 18 * * 1', 'UTC', 48, 1)).toMatch(/^Opens Saturday 6:30 PM .* closes Monday 5:30 PM .* table starts Monday 6:30 PM/);
  });

  it('treats cron day 7 as Sunday', () => {
    expect(describePollTimes('0 12 * * 7', 'UTC', 24, 2)).toMatch(/table starts Sunday 12:00 PM/);
  });

  it('notes an offset longer than a week', () => {
    expect(describePollTimes('0 0 * * 5', 'UTC', 200, 3)).toMatch(/\(1 week earlier\)/);
  });

  it('returns null for cadences it cannot describe', () => {
    expect(describePollTimes('0 0 * * *', 'UTC', 96, 3)).toBeNull();
    expect(describePollTimes('0 0 1 * *', 'UTC', 96, 3)).toBeNull();
    expect(describePollTimes('0 0 * * 1-5', 'UTC', 96, 3)).toBeNull();
    expect(describePollTimes(undefined, 'UTC', 96, 3)).toBeNull();
  });
});

describe('pollPayload / pollStateFromRow', () => {
  it('sends poll_picks:false when off, the four poll keys when on — no fallback', () => {
    expect(pollPayload(defaultPollState)).toEqual({ poll_picks: false });
    expect(pollPayload({ enabled: true, opensBeforeH: 72, closesBeforeH: 6, tieRule: 'random' })).toEqual({
      poll_picks: true, poll_opens_before_h: 72, poll_closes_before_h: 6, poll_tie_rule: 'random',
    });
  });

  it('reads the poll columns, defaulting an unknown tie rule to admin', () => {
    expect(pollStateFromRow({ poll_picks: 1, poll_opens_before_h: 72, poll_closes_before_h: 6, poll_tie_rule: 'first_nominated' }))
      .toEqual({ enabled: true, opensBeforeH: 72, closesBeforeH: 6, tieRule: 'first_nominated' });
    expect(pollStateFromRow({ poll_picks: 0, poll_tie_rule: 'bogus' })).toEqual(defaultPollState);
  });

  it('offers exactly three tie-breakers; "admin" is a hold', () => {
    expect(Object.keys(TIE_RULE_LABEL)).toEqual(['admin', 'random', 'first_nominated']);
    expect(TIE_RULE_LABEL.admin).toBe('Admin decides — no table is queued until an admin chooses');
  });
});
