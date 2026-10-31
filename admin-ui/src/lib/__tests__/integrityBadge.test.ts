import { describe, it, expect } from 'vitest';
import {
  integrityChipFor, quitLabelFor, signedLabelFor, signedTitleFor,
  type IntegrityVerdictMap, type QuitMap, type SignedMap,
} from '../integrityBadge';

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

describe('signedLabelFor (W72)', () => {
  const SIGNED: SignedMap = { '301': { by: 'lu-scoreserver' }, '302': { by: 'some-other-signer' } };

  it('labels a launcher-signed row, with a tooltip that says what it does and does not prove', () => {
    const spec = signedLabelFor(SIGNED, 301)!;
    expect(spec.label).toBe('Launcher-signed');
    expect(spec.title).toMatch(/Legends Unchained launcher signed its own record/);
    expect(spec.title).toMatch(/says nothing about the table or its settings/);
    expect(signedLabelFor(SIGNED, '302')!.title).toMatch(/valid signature and matches this score/);
  });

  it('is null with no map, no history id, no entry, or no signer', () => {
    expect(signedLabelFor(null, 301)).toBeNull();
    expect(signedLabelFor(undefined, 301)).toBeNull();
    expect(signedLabelFor(SIGNED, null)).toBeNull();
    expect(signedLabelFor(SIGNED, 999)).toBeNull();
    expect(signedLabelFor({ '1': { by: '' } }, 1)).toBeNull();
  });

  it('is additive: a pass verdict on the same row is unchanged by it', () => {
    const verdicts: IntegrityVerdictMap = { '301': { verdict: 'pass', reasons: [] } };
    expect(integrityChipFor(verdicts, 301, 'sanctioned')!.label).toBe('Sanctioned');
    expect(signedLabelFor(SIGNED, 301)!.label).toBe('Launcher-signed');
    expect(signedTitleFor('lu-scoreserver')).toBe(signedLabelFor(SIGNED, 301)!.title);
  });
});
