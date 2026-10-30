import { describe, it, expect } from 'vitest';
import { integrityChipFor, quitLabelFor, type IntegrityVerdictMap, type QuitMap } from '../integrityBadge';

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

describe('quitLabelFor (W49)', () => {
  const QUITS: QuitMap = { '201': { ball: 2 }, '202': { ball: null } };

  it('names the ball when the machine reported one, plain "Quit" when not', () => {
    expect(quitLabelFor(QUITS, 201)!.label).toBe('Quit on ball 2');
    expect(quitLabelFor(QUITS, '202')!.label).toBe('Quit');
  });

  it('says it still counts and still used its attempt', () => {
    expect(quitLabelFor(QUITS, 201)!.title).toBe(
      'The player quit this game before game over (reported by the Witness: a desktop quit, or a cabinet game abandoned by a hold-Start restart). It still counts and, in Limited attempts, still used its attempt.',
    );
  });

  it('is null with no map, no history id, or no entry for the row', () => {
    expect(quitLabelFor(null, 201)).toBeNull();
    expect(quitLabelFor(undefined, 201)).toBeNull();
    expect(quitLabelFor(QUITS, null)).toBeNull();
    expect(quitLabelFor(QUITS, undefined)).toBeNull();
    expect(quitLabelFor(QUITS, 999)).toBeNull();
  });

  it('a nonsense ball never prints (0, fractional, a string)', () => {
    const bad = { '1': { ball: 0 }, '2': { ball: 2.5 }, '3': { ball: 'x' as unknown as number } } as QuitMap;
    for (const id of [1, 2, 3]) expect(quitLabelFor(bad, id)!.label).toBe('Quit');
  });
});
