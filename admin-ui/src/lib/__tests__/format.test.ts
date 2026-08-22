import { describe, it, expect } from 'vitest';
import { parseServerDate, relativeTimeFrom } from '../format';

// ---------------------------------------------------------------------------
// The backend serves many timestamps as bare SQLite `datetime('now')` strings
// ("YYYY-MM-DD HH:MM:SS") — UTC, but with no `T`/`Z`. Browsers parse that as
// LOCAL time, so for a US viewer the instant lands hours in the future and
// every relative-time formatter built on `Date.now() - parsed` goes negative
// and prints "just now" no matter how old the row actually is. These tests
// pin the fix: bare strings are parsed as UTC regardless of host TZ, proper
// ISO strings (with `Z` or an offset) are untouched.
// ---------------------------------------------------------------------------

describe('parseServerDate', () => {
  it('returns null for null/undefined/empty', () => {
    expect(parseServerDate(null)).toBeNull();
    expect(parseServerDate(undefined)).toBeNull();
    expect(parseServerDate('')).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseServerDate('not a date')).toBeNull();
  });

  it('parses a bare SQLite "YYYY-MM-DD HH:MM:SS" string as UTC', () => {
    const parsed = parseServerDate('2026-08-22 05:33:10');
    expect(parsed).not.toBeNull();
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10));
  });

  it('parses a bare "YYYY-MM-DDTHH:MM:SS" (T separator, no zone) as UTC', () => {
    const parsed = parseServerDate('2026-08-22T05:33:10');
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10));
  });

  it('parses a bare string with no seconds as UTC', () => {
    const parsed = parseServerDate('2026-08-22 05:33');
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 0));
  });

  it('parses a bare string with fractional seconds as UTC', () => {
    const parsed = parseServerDate('2026-08-22 05:33:10.123');
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10, 123));
  });

  it('leaves a proper ISO string with Z to the native parser', () => {
    const parsed = parseServerDate('2026-08-22T05:33:10.123Z');
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10, 123));
  });

  it('leaves a string with an explicit offset to the native parser', () => {
    const parsed = parseServerDate('2026-08-22T05:33:10-04:00');
    expect(parsed!.getTime()).toBe(Date.UTC(2026, 7, 22, 9, 33, 10));
  });

  it('parses the bare form independent of the host TZ', () => {
    const originalTz = process.env.TZ;
    try {
      // Host west of UTC — if the bug regressed, this would parse hours later
      // than it should.
      process.env.TZ = 'America/New_York';
      const parsedWest = parseServerDate('2026-08-22 05:33:10');
      expect(parsedWest!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10));

      // Host east of UTC.
      process.env.TZ = 'Asia/Tokyo';
      const parsedEast = parseServerDate('2026-08-22 05:33:10');
      expect(parsedEast!.getTime()).toBe(Date.UTC(2026, 7, 22, 5, 33, 10));
    } finally {
      process.env.TZ = originalTz;
    }
  });
});

describe('relativeTimeFrom', () => {
  it('returns empty string for null/undefined/unparseable', () => {
    expect(relativeTimeFrom(null)).toBe('');
    expect(relativeTimeFrom(undefined)).toBe('');
    expect(relativeTimeFrom('garbage')).toBe('');
  });

  it('a bare SQLite string 3 hours before now reads "3h ago" regardless of host TZ', () => {
    // now fixed at 2026-08-22 08:33:10 UTC; the bare-form timestamp is
    // 2026-08-22 05:33:10 — exactly 3 hours earlier. Computed via Date.UTC so
    // the expectation doesn't depend on the runner's local TZ either.
    const now = Date.UTC(2026, 7, 22, 8, 33, 10);
    const originalTz = process.env.TZ;
    try {
      delete process.env.TZ;
      expect(relativeTimeFrom('2026-08-22 05:33:10', now)).toBe('3h ago');

      process.env.TZ = 'America/New_York';
      expect(relativeTimeFrom('2026-08-22 05:33:10', now)).toBe('3h ago');

      process.env.TZ = 'Asia/Tokyo';
      expect(relativeTimeFrom('2026-08-22 05:33:10', now)).toBe('3h ago');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('still works for a proper ISO-with-Z string', () => {
    const now = Date.UTC(2026, 7, 22, 8, 33, 10);
    expect(relativeTimeFrom('2026-08-22T05:33:10.000Z', now)).toBe('3h ago');
  });

  it('a future timestamp reads "just now" rather than a negative duration', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    expect(relativeTimeFrom('2026-08-22T06:00:00.000Z', now)).toBe('just now');
  });

  it('small negative clock skew still reads "just now"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    // 5 seconds "in the future" relative to now — clock skew, not real future.
    expect(relativeTimeFrom('2026-08-22T05:00:05.000Z', now)).toBe('just now');
  });

  it('boundary: 59s ago is "just now"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 1, 0);
    expect(relativeTimeFrom('2026-08-22T05:00:01.000Z', now)).toBe('just now');
  });

  it('boundary: 60s ago rolls to "1m ago"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 1, 0);
    expect(relativeTimeFrom('2026-08-22T05:00:00.000Z', now)).toBe('1m ago');
  });

  it('boundary: 59m ago is "59m ago"', () => {
    const now = Date.UTC(2026, 7, 22, 6, 0, 0);
    expect(relativeTimeFrom('2026-08-22T05:01:00.000Z', now)).toBe('59m ago');
  });

  it('boundary: exactly 24h ago rolls to "1d ago"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    expect(relativeTimeFrom('2026-08-21T05:00:00.000Z', now)).toBe('1d ago');
  });

  it('boundary: just under 24h ago is "23h ago"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    expect(relativeTimeFrom('2026-08-21T06:00:00.000Z', now)).toBe('23h ago');
  });

  it('boundary: just under 7d ago is "6d ago"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    expect(relativeTimeFrom('2026-08-15T06:00:00.000Z', now)).toBe('6d ago');
  });

  it('boundary: exactly 7d ago renders a short date, not "7d ago"', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    const result = relativeTimeFrom('2026-08-15T05:00:00.000Z', now);
    expect(result).not.toMatch(/ago/);
    expect(result).toMatch(/Aug/);
  });

  it('includes the year when the date is not in the current year', () => {
    const now = Date.UTC(2026, 7, 22, 5, 0, 0);
    const result = relativeTimeFrom('2025-01-01T05:00:00.000Z', now);
    expect(result).toContain('2025');
  });
});
