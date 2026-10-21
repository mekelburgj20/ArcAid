import { describe, it, expect } from 'vitest';
import { integrityChipFor, type IntegrityVerdictMap } from '../integrityBadge';

/**
 * The board chip (v2.166.0, ADR 0027). Badge, never gate: the helper only ever
 * answers "what chip, if any" for a row the board already has.
 */

const VERDICTS: IntegrityVerdictMap = {
  '101': { verdict: 'pass', reasons: [] },
  '102': { verdict: 'flagged', reasons: ['tilt sensitivity 200 is below the minimum 300', 'the nudge filter is off'] },
  '103': { verdict: 'flagged', reasons: [] },
};

describe('integrityChipFor', () => {
  it('is null with no map, no history id, or no verdict for the row', () => {
    expect(integrityChipFor(null, 101, 'open')).toBeNull();
    expect(integrityChipFor(undefined, 101, 'open')).toBeNull();
    expect(integrityChipFor(VERDICTS, null, 'open')).toBeNull();
    expect(integrityChipFor(VERDICTS, undefined, 'open')).toBeNull();
    expect(integrityChipFor(VERDICTS, 999, 'open')).toBeNull();
  });

  it('a pass reads "Sanctioned" in Sanctioned play and "Conditions verified" in Open play', () => {
    expect(integrityChipFor(VERDICTS, 101, 'sanctioned')).toMatchObject({ tone: 'pass', label: 'Sanctioned' });
    expect(integrityChipFor(VERDICTS, 101, 'open')).toMatchObject({ tone: 'pass', label: 'Conditions verified' });
    // An unknown mode is Open.
    expect(integrityChipFor(VERDICTS, 101, null)).toMatchObject({ tone: 'pass', label: 'Conditions verified' });
    expect(integrityChipFor(VERDICTS, 101, 'sanctioned')!.title).toMatch(/every rule of this tournament passed/);
  });

  it('a flag carries the reasons in its title, joined', () => {
    expect(integrityChipFor(VERDICTS, 102, 'open')).toEqual({
      tone: 'flagged',
      label: 'Flagged',
      title: 'tilt sensitivity 200 is below the minimum 300; the nudge filter is off',
    });
    expect(integrityChipFor(VERDICTS, 103, 'sanctioned')!.title).toMatch(/^Flagged/);
  });

  it('accepts the history id as a number or a string', () => {
    expect(integrityChipFor(VERDICTS, '101', 'open')?.tone).toBe('pass');
    expect(integrityChipFor(VERDICTS, 102, 'open')?.tone).toBe('flagged');
  });
});
