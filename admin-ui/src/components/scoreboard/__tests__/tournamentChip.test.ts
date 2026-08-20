import { describe, it, expect } from 'vitest';
import { tournamentChipLabel } from '../tournamentChip';

/**
 * tournamentChipLabel — the one rule shared by every score-card style
 * (Arcade/Showcase/Banner/Minimal, plus the legacy GameCard): the chip
 * names the tournament's Tag exactly as configured on the Tournaments
 * page, falling back to the free-text tournament NAME only when the tag
 * is empty. See the four cards' own tests for the render-level assertion
 * that the chip actually shows the tag.
 */
describe('tournamentChipLabel', () => {
  it('prefers the tag when one is set', () => {
    expect(tournamentChipLabel({ tournamentType: 'WG-VPXS', tournamentName: 'Weekly Grind - VPXS' })).toBe('WG-VPXS');
  });

  it('falls back to the tournament name when the tag is empty', () => {
    expect(tournamentChipLabel({ tournamentType: '', tournamentName: 'Custom One-Off Event' })).toBe('Custom One-Off Event');
  });

  it('returns null when both the tag and the name are empty', () => {
    expect(tournamentChipLabel({ tournamentType: '', tournamentName: '' })).toBeNull();
  });
});
