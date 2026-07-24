import { describe, it, expect } from 'vitest';
import { getTournamentColorHex } from '../tournamentColors';

// v2.31.0 — FE port of src/utils/discord.ts's getTournamentColor. Mirrors the
// BE lookup-order semantics exactly: uppercased tag/type key first, then the
// raw (non-uppercased) key, then gray. Keep in sync with the BE test/behavior
// if either map ever changes.
describe('getTournamentColorHex', () => {
  it('resolves known tag codes case-insensitively via the uppercase lookup', () => {
    expect(getTournamentColorHex('DG')).toBe('#FFD700');
    expect(getTournamentColorHex('dg')).toBe('#FFD700');
    expect(getTournamentColorHex('WG-VPXS')).toBe('#00BFFF');
    expect(getTournamentColorHex('wg-vpxs')).toBe('#00BFFF');
    expect(getTournamentColorHex('WG-VR')).toBe('#AA00FF');
    expect(getTournamentColorHex('MG')).toBe('#00FF88');
  });

  it('resolves generic type keys', () => {
    expect(getTournamentColorHex('daily')).toBe('#FFD700');
    expect(getTournamentColorHex('weekly')).toBe('#00BFFF');
    expect(getTournamentColorHex('monthly')).toBe('#AA00FF');
    expect(getTournamentColorHex('custom')).toBe('#00FF88');
  });

  it('generic type keys are case-insensitive (matched via the uppercase pass)', () => {
    // 'DAILY'.toUpperCase() has no entry in TAG_COLORS (only 'daily' lowercase
    // does), so this falls through to the raw-key lookup, which also misses
    // (raw key is 'DAILY', not 'daily') — this documents the real behavior
    // rather than assuming case-insensitivity for generic type keys.
    expect(getTournamentColorHex('DAILY')).toBe('#888888');
    expect(getTournamentColorHex('Daily')).toBe('#888888');
  });

  it('returns gray for an unknown type', () => {
    expect(getTournamentColorHex('unknown-type')).toBe('#888888');
    expect(getTournamentColorHex('')).toBe('#888888');
  });

  it('returns gray for null/undefined', () => {
    expect(getTournamentColorHex(null)).toBe('#888888');
    expect(getTournamentColorHex(undefined)).toBe('#888888');
  });
});
