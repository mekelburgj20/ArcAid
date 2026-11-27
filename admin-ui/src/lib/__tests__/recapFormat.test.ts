import { describe, it, expect } from 'vitest';
import { formatRecapScore, formatRecapDay, formatRecapTime, formatDuration } from '../recapFormat';

// The same table as the server's abbrevScore test (src/__tests__/run-recap-compute.test.ts).
const CASES: Array<[number, string]> = [
  [0, '0'],
  [950, '950'],
  [31_411, '31.4K'],
  [31_411_440, '31.4M'],
  [92_000_000, '92.0M'],
  [116_170_221, '116.2M'],
  [492_315_750, '492.3M'],
  [8_600_000_000, '8.6B'],
  [1_200_000_000_000, '1.2T'],
  [999_960, '1.0M'],
];

describe('formatRecapScore', () => {
  it.each(CASES)('%i -> %s', (n, out) => {
    expect(formatRecapScore(n)).toBe(out);
  });
});

describe('formatRecapDay', () => {
  it('labels a local day key, zone-free', () => {
    expect(formatRecapDay('2026-11-20')).toBe('Fri 11/20');
    expect(formatRecapDay('2026-11-01')).toBe('Sun 11/1');
  });
});

describe('formatRecapTime', () => {
  it('formats in the run zone', () => {
    expect(formatRecapTime('2026-11-20T14:04:59Z', 'America/Chicago')).toBe('Fri 8:04 am');
    expect(formatRecapTime('2026-11-26T22:06:01Z', 'America/Chicago')).toBe('Thu 4:06 pm');
  });
});

describe('formatDuration', () => {
  it('uses minutes, about-hours and days', () => {
    expect(formatDuration(12 * 60_000)).toBe('12 minutes');
    expect(formatDuration(60_000)).toBe('1 minute');
    expect(formatDuration(7 * 3_600_000)).toBe('about 7 hours');
    expect(formatDuration(3 * 86_400_000)).toBe('3 days');
  });
});
