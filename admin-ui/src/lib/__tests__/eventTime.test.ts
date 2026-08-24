import { describe, it, expect } from 'vitest';
import {
  wallTimeToUtcIso,
  utcIsoToWallTime,
  durationMinutes,
  addMinutes,
  validateRoundDrafts,
  type RoundDraft,
} from '../eventTime';

/**
 * The round-window time math (v2.135.0, ADR 0017).
 *
 * This is the layer where a scheduling bug is silent and expensive: an admin
 * sets "8pm Central", the API stores an instant, and if the conversion is an
 * hour out the round simply opens at the wrong time with no error anywhere.
 * DST is the case that actually breaks hand-rolled conversions, so it gets the
 * most attention here.
 */

describe('wallTimeToUtcIso', () => {
  it('converts a standard-time wall clock', () => {
    // 2026-01-15 20:00 CST (UTC-6) -> 02:00 UTC the next day
    expect(wallTimeToUtcIso('2026-01-15T20:00', 'America/Chicago')).toBe('2026-01-16T02:00:00.000Z');
  });

  it('converts a daylight-time wall clock with the right (different) offset', () => {
    // 2026-07-15 20:00 CDT (UTC-5) -> 01:00 UTC the next day.
    // A one-pass implementation that reuses the winter offset lands an hour out.
    expect(wallTimeToUtcIso('2026-07-15T20:00', 'America/Chicago')).toBe('2026-07-16T01:00:00.000Z');
  });

  it('handles the hours either side of a spring-forward transition', () => {
    // US DST 2026 begins 2026-03-08 02:00 local.
    expect(wallTimeToUtcIso('2026-03-08T01:00', 'America/Chicago')).toBe('2026-03-08T07:00:00.000Z');
    expect(wallTimeToUtcIso('2026-03-08T03:00', 'America/Chicago')).toBe('2026-03-08T08:00:00.000Z');
  });

  it('handles zones east of Greenwich and UTC itself', () => {
    expect(wallTimeToUtcIso('2026-09-01T20:00', 'UTC')).toBe('2026-09-01T20:00:00.000Z');
    // Tokyo is UTC+9 year-round.
    expect(wallTimeToUtcIso('2026-09-01T20:00', 'Asia/Tokyo')).toBe('2026-09-01T11:00:00.000Z');
  });

  it('returns null for an incomplete value rather than inventing an instant', () => {
    expect(wallTimeToUtcIso('', 'UTC')).toBeNull();
    expect(wallTimeToUtcIso('2026-09-01', 'UTC')).toBeNull();
    expect(wallTimeToUtcIso('not-a-date-at-all', 'UTC')).toBeNull();
  });
});

describe('utcIsoToWallTime', () => {
  it('round-trips through both DST states', () => {
    for (const local of ['2026-01-15T20:00', '2026-07-15T20:00', '2026-11-02T23:30']) {
      const utc = wallTimeToUtcIso(local, 'America/Chicago')!;
      expect(utcIsoToWallTime(utc, 'America/Chicago')).toBe(local);
    }
  });

  it('is empty for a missing or unparseable instant', () => {
    expect(utcIsoToWallTime(null, 'UTC')).toBe('');
    expect(utcIsoToWallTime(undefined, 'UTC')).toBe('');
    expect(utcIsoToWallTime('nonsense', 'UTC')).toBe('');
  });
});

describe('durationMinutes / addMinutes', () => {
  it('measures and extends a window', () => {
    expect(durationMinutes('2026-09-01T20:00', '2026-09-01T20:25')).toBe(25);
    expect(addMinutes('2026-09-01T20:00', 25)).toBe('2026-09-01T20:25');
    expect(addMinutes('2026-09-01T23:50', 25)).toBe('2026-09-02T00:15');
  });

  it('is null-safe on partial input', () => {
    expect(durationMinutes('', '2026-09-01T20:25')).toBeNull();
    expect(addMinutes('', 25)).toBe('');
  });
});

describe('validateRoundDrafts', () => {
  const round = (roundNo: number, startLocal: string, durationMin = 25, gameName = 'Medieval Madness'): RoundDraft =>
    ({ roundNo, gameName, startLocal, durationMin });

  it('accepts a clean two-round schedule', () => {
    const errors = validateRoundDrafts(
      [round(1, '2026-09-01T20:00'), round(2, '2026-09-01T20:30')],
      '2026-09-01T19:30',
    );
    expect(errors).toEqual({});
  });

  it('flags a round that starts before the previous one ends', () => {
    const errors = validateRoundDrafts(
      [round(1, '2026-09-01T20:00', 30), round(2, '2026-09-01T20:10')],
      '',
    );
    expect(errors[2]).toContain('before round 1 ends');
    expect(errors[1]).toBeUndefined();
  });

  it('allows rounds that touch exactly', () => {
    const errors = validateRoundDrafts(
      [round(1, '2026-09-01T20:00', 30), round(2, '2026-09-01T20:30')],
      '',
    );
    expect(errors).toEqual({});
  });

  it('flags missing game, missing start and a non-positive duration', () => {
    const errors = validateRoundDrafts([
      round(1, '2026-09-01T20:00', 25, '   '),
      round(2, '', 25),
      round(3, '2026-09-01T22:00', 0),
    ], '');
    expect(errors[1]).toContain('game');
    expect(errors[2]).toContain('start time');
    expect(errors[3]).toContain('Duration');
  });

  it('flags check-in opening at or after round 1', () => {
    expect(validateRoundDrafts([round(1, '2026-09-01T20:00')], '2026-09-01T20:00')[1])
      .toContain('Check-in must open before');
    expect(validateRoundDrafts([round(1, '2026-09-01T20:00')], '2026-09-01T20:30')[1])
      .toContain('Check-in must open before');
    expect(validateRoundDrafts([round(1, '2026-09-01T20:00')], '2026-09-01T19:59')[1])
      .toBeUndefined();
  });

  it('sorts by round number before checking overlap, so out-of-order input still validates', () => {
    const errors = validateRoundDrafts(
      [round(2, '2026-09-01T20:10'), round(1, '2026-09-01T20:00', 30)],
      '',
    );
    expect(errors[2]).toContain('before round 1 ends');
  });
});
