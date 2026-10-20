import { describe, it, expect } from 'vitest';
import { DEFAULT_TIMEZONE, formatInZone, resolveRoomTimezone, zoneLabel } from '../timezone';

describe('resolveRoomTimezone', () => {
  it('defaults to Chicago when unset', () => {
    expect(resolveRoomTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
    expect(resolveRoomTimezone(null)).toBe('America/Chicago');
    expect(resolveRoomTimezone({})).toBe('America/Chicago');
  });

  it('returns an explicit zone, trimmed', () => {
    expect(resolveRoomTimezone({ ROOM_TIMEZONE: 'America/Los_Angeles' })).toBe('America/Los_Angeles');
    expect(resolveRoomTimezone({ ROOM_TIMEZONE: '  Pacific/Honolulu ' })).toBe('Pacific/Honolulu');
  });

  it('treats a blank value as unset', () => {
    expect(resolveRoomTimezone({ ROOM_TIMEZONE: '   ' })).toBe('America/Chicago');
  });
});

describe('formatInZone', () => {
  // 2026-10-20 03:00 UTC = Oct 19, 8 PM PDT = Oct 19, 11 PM EDT.
  const SQLITE = '2026-10-20 03:00:00';
  const ISO = '2026-10-20T03:00:00.000Z';

  it('renders the same instant at different hours per zone, labelled', () => {
    const la = formatInZone(SQLITE, 'America/Los_Angeles');
    const ny = formatInZone(SQLITE, 'America/New_York');
    expect(la).not.toBe(ny);
    expect(la).toMatch(/08/);
    expect(ny).toMatch(/11/);
    expect(la).toMatch(/PDT|GMT-7/);
    expect(ny).toMatch(/EDT|GMT-4/);
  });

  it('reads a SQLite UTC timestamp and an ISO Z string as the same instant', () => {
    expect(formatInZone(SQLITE, 'America/Chicago')).toBe(formatInZone(ISO, 'America/Chicago'));
  });

  it('honours an explicit offset', () => {
    expect(formatInZone('2026-10-19T22:00:00-05:00', 'America/Chicago')).toBe(formatInZone(ISO, 'America/Chicago'));
  });

  it("returns '--' for null/empty", () => {
    expect(formatInZone(null, 'America/Chicago')).toBe('--');
    expect(formatInZone(undefined, 'America/Chicago')).toBe('--');
    expect(formatInZone('', 'America/Chicago')).toBe('--');
  });

  it('returns the raw string when unparseable', () => {
    expect(formatInZone('not a date', 'America/Chicago')).toBe('not a date');
  });

  it('does not throw on an invalid zone', () => {
    expect(() => formatInZone(ISO, 'Not/AZone')).not.toThrow();
    expect(formatInZone(ISO, 'Not/AZone')).not.toBe('--');
  });
});

describe('zoneLabel re-export', () => {
  it('gives a short label', () => {
    expect(zoneLabel('America/Los_Angeles')).toBe('PT');
  });
});
