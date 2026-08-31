import { describe, it, expect } from 'vitest';
import {
    caretAfterNthDigit,
    countDigits,
    digitsOnly,
    formatMagnitude,
    formatScoreInput,
    groupDigits,
    reformatScoreEdit,
    skipSeparatorBack,
} from '../scoreInput';

/**
 * Grouped score ENTRY (owner incident 2026-08-30: `66661589860` submitted for
 * `6666158980`). The component seam is covered in
 * `components/__tests__/SubmissionSheet.keypad.test.tsx`; these lock the pure
 * rules underneath it.
 */

describe('groupDigits', () => {
    it('groups in threes from the right', () => {
        expect(groupDigits('1')).toBe('1');
        expect(groupDigits('123')).toBe('123');
        expect(groupDigits('1234')).toBe('1,234');
        expect(groupDigits('6666158980')).toBe('6,666,158,980');
    });

    it('returns empty for an empty value so the placeholder still shows', () => {
        expect(groupDigits('')).toBe('');
        expect(digitsOnly('abc')).toBe('');
    });

    it('drops leading zeros rather than rendering "0,012,345"', () => {
        expect(groupDigits('0012345')).toBe('12,345');
        expect(groupDigits('007')).toBe('7');
    });

    it('keeps a lone zero — zero is a legal score', () => {
        expect(groupDigits('0')).toBe('0');
        expect(groupDigits('000')).toBe('0');
    });

    it('is exact past Number.MAX_SAFE_INTEGER (a fat-fingered paste must not go lossy)', () => {
        const huge = '99999999999999999999999';
        expect(digitsOnly(groupDigits(huge))).toBe(huge);
    });

    it('strips anything that is not a digit', () => {
        expect(formatScoreInput('1,2a3 4')).toBe('1,234');
        expect(formatScoreInput('-500')).toBe('500');
    });
});

describe('caretAfterNthDigit', () => {
    it('counts digits, not characters', () => {
        expect(caretAfterNthDigit('1,234', 0)).toBe(0);
        expect(caretAfterNthDigit('1,234', 1)).toBe(1);
        expect(caretAfterNthDigit('1,234', 2)).toBe(3);
        expect(caretAfterNthDigit('1,234', 4)).toBe(5);
    });

    it('clamps past the end', () => {
        expect(caretAfterNthDigit('1,234', 99)).toBe(5);
    });

    it('agrees with countDigits on its own output', () => {
        expect(countDigits('6,666,158,980')).toBe(10);
    });
});

describe('reformatScoreEdit', () => {
    it('re-derives the caret from the digit count when a separator appears ahead of it', () => {
        // "999,999" + a digit at the end becomes "9,999,999": one more comma
        // sits before the caret, so a character offset would drift by one.
        expect(reformatScoreEdit('999,9999', 8)).toEqual({ value: '9,999,999', caret: 9 });
    });

    it('keeps the caret mid-value across a re-group', () => {
        // Splice "5" into "500,999" at offset 3 → "5005,999" → "5,005,999".
        expect(reformatScoreEdit('5005,999', 4)).toEqual({ value: '5,005,999', caret: 5 });
    });

    it('passes a null caret straight through (the append path)', () => {
        expect(reformatScoreEdit('1234', null)).toEqual({ value: '1,234', caret: null });
    });

    it('clamps a caret that sat inside dropped leading zeros', () => {
        expect(reformatScoreEdit('0012', 2)).toEqual({ value: '12', caret: 0 });
    });
});

describe('skipSeparatorBack', () => {
    it('steps a collapsed caret back over a separator so backspace hits a digit', () => {
        expect(skipSeparatorBack('1,234', { start: 2, end: 2 })).toEqual({ start: 1, end: 1 });
    });

    it('leaves a caret that already follows a digit alone', () => {
        expect(skipSeparatorBack('1,234', { start: 3, end: 3 })).toEqual({ start: 3, end: 3 });
    });

    it('leaves a selected range alone — deleting a selection is unambiguous', () => {
        expect(skipSeparatorBack('1,234', { start: 0, end: 3 })).toEqual({ start: 0, end: 3 });
    });

    it('passes null through (no caret information available)', () => {
        expect(skipSeparatorBack('1,234', null)).toBeNull();
    });

    it('stops at the start rather than running off the front', () => {
        expect(skipSeparatorBack(',123', { start: 1, end: 1 })).toEqual({ start: 0, end: 0 });
    });
});

describe('formatMagnitude', () => {
    it('names the order of magnitude — the check commas cannot make', () => {
        expect(formatMagnitude('6666158980')).toBe('6.66 billion');
        // The incident value: one extra zero, an obviously different phrase.
        expect(formatMagnitude('66661589860')).toBe('66.66 billion');
    });

    it('covers million through quadrillion', () => {
        expect(formatMagnitude('1234567')).toBe('1.23 million');
        expect(formatMagnitude('4724100720')).toBe('4.72 billion');
        expect(formatMagnitude('1500000000000')).toBe('1.5 trillion');
        expect(formatMagnitude('2000000000000000')).toBe('2 quadrillion');
    });

    it('truncates rather than rounds — a rounded echo is a second number to reconcile', () => {
        expect(formatMagnitude('6999999999')).toBe('6.99 billion');
    });

    it('groups a large whole part', () => {
        expect(formatMagnitude('1234000000000000000')).toBe('1,234 quadrillion');
    });

    it('stays silent below a million, where the digits already read at a glance', () => {
        expect(formatMagnitude('999999')).toBeNull();
        expect(formatMagnitude('1234')).toBeNull();
        expect(formatMagnitude('')).toBeNull();
        expect(formatMagnitude('0')).toBeNull();
    });
});
