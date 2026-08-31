/**
 * Grouped score ENTRY (the display side has always been grouped — see
 * `formatScore` in `lib/format.ts`).
 *
 * Owner incident, 2026-08-30: a player submitted `66661589860` for World Cup
 * Soccer when they meant `6666158980`. Eleven bare digits in a bare input, one
 * extra zero, nobody caught it — and because Arcaid has no score-edit path the
 * only remedies were a destructive delete or hand-written SQL. Grouping the
 * digits AS THEY ARE TYPED is the cheap half of the fix; `formatMagnitude`
 * below is the other half, because at eleven digits you still have to count
 * comma groups, while "6.67 billion" reads wrong at a glance.
 *
 * Design: the sheet's `score` state holds the FORMATTED string, not the raw
 * digits. That is deliberate — `lib/caretEdit`'s splice helpers and the
 * browser's own `selectionStart` both index the string the user can see, so
 * keeping state and display identical means neither has to be translated.
 * Every consumer that needs a number calls `digitsOnly` first.
 */

import type { CaretRange } from './caretEdit';

/** The grouping separator. Locale-fixed on purpose — see `groupDigits`. */
const SEPARATOR = ',';

export function digitsOnly(value: string): string {
    return value.replace(/\D/g, '');
}

export function countDigits(value: string): number {
    let n = 0;
    for (const ch of value) if (ch >= '0' && ch <= '9') n++;
    return n;
}

/**
 * Groups a bare digit string in threes.
 *
 * Deliberately NOT `Number(...).toLocaleString()`: scores routinely exceed
 * `Number.MAX_SAFE_INTEGER` once somebody fat-fingers a digit (the incident
 * value is fine, but `999999999999999999999` is one paste away), and a locale
 * whose group separator is `.` or a space would make the field disagree with
 * `formatScore`'s rendering of the same number elsewhere in the app. String
 * grouping is exact at any length and stable in every locale.
 *
 * Leading zeros are dropped (`"007"` → `"7"`) so the field can never render
 * `"0,012,345"`; an all-zero value collapses to a single `"0"`, which is a
 * legal score (`canSubmit` accepts 0).
 */
export function groupDigits(digits: string): string {
    const bare = digits.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
    if (bare === '') return '';
    let out = '';
    for (let i = 0; i < bare.length; i++) {
        if (i > 0 && (bare.length - i) % 3 === 0) out += SEPARATOR;
        out += bare[i];
    }
    return out;
}

/** Convenience: strip anything non-numeric out of a raw field value and group it. */
export function formatScoreInput(value: string): string {
    return groupDigits(digitsOnly(value));
}

/**
 * Character offset in `formatted` that sits immediately after its `n`th digit.
 * `n = 0` → 0 (before everything). Used to translate a digit-counted caret
 * back into a position in the grouped string.
 */
export function caretAfterNthDigit(formatted: string, n: number): number {
    if (n <= 0) return 0;
    let seen = 0;
    for (let i = 0; i < formatted.length; i++) {
        const ch = formatted[i]!;
        if (ch >= '0' && ch <= '9') {
            seen++;
            if (seen === n) return i + 1;
        }
    }
    return formatted.length;
}

/**
 * Re-groups the result of an edit and reports where the caret belongs.
 *
 * The caret is carried across as a DIGIT COUNT rather than a character offset,
 * which is what makes this correct when the edit changes how many separators
 * precede the caret — inserting a digit into `999,999` both adds a character
 * and shifts every comma one place right, so a character offset would drift by
 * one on exactly the edits players make most.
 *
 * A `null` caret means "the caller had no caret information" (the append path
 * in `caretEdit`); it stays null so the caller leaves the caret alone.
 */
export function reformatScoreEdit(next: string, caret: number | null): { value: string; caret: number | null } {
    const value = formatScoreInput(next);
    if (caret === null) return { value, caret: null };
    const digitsBefore = countDigits(next.slice(0, caret));
    // `groupDigits` drops leading zeros, and it is the only thing that removes
    // digits — so the shortfall IS the number of dropped zeros. Discount them,
    // or a caret that sat among the zeros lands at the END of the surviving
    // value instead of in front of it.
    const dropped = countDigits(next) - countDigits(value);
    const surviving = Math.max(0, digitsBefore - dropped);
    return { value, caret: caretAfterNthDigit(value, surviving) };
}

/**
 * Nudges a collapsed caret left past any separators directly behind it, so a
 * backspace deletes a DIGIT instead of a comma the field would immediately put
 * back. Without this, backspacing at `6,|666` removes the comma, the re-group
 * restores it, and the key appears dead.
 *
 * A selected range is returned untouched — deleting a selection is unambiguous.
 */
export function skipSeparatorBack(value: string, caret: CaretRange | null): CaretRange | null {
    if (!caret || caret.end > caret.start) return caret;
    let pos = Math.min(caret.start, value.length);
    while (pos > 0) {
        const ch = value[pos - 1]!;
        if (ch >= '0' && ch <= '9') break;
        pos--;
    }
    return { start: pos, end: pos };
}

/**
 * The plain-language echo shown under the score field: `6,666,158,980` →
 * `"6.66 billion"`.
 *
 * This is the part that actually catches an off-by-one-digit typo. Commas tell
 * you the grouping is well-formed, not that the magnitude is what you meant;
 * a word does, and it is the same check a human makes reading a score aloud.
 * Returns `null` below a million, where the digits already read at a glance
 * and an echo would just be clutter.
 */
export function formatMagnitude(digits: string): string | null {
    const bare = digitsOnly(digits).replace(/^0+(?=\d)/, '');
    if (bare === '') return null;
    const TIERS: Array<{ exp: number; label: string }> = [
        { exp: 15, label: 'quadrillion' },
        { exp: 12, label: 'trillion' },
        { exp: 9, label: 'billion' },
        { exp: 6, label: 'million' },
    ];
    for (const { exp, label } of TIERS) {
        if (bare.length <= exp) continue;
        // String maths, not Number: `bare` can exceed MAX_SAFE_INTEGER and a
        // lossy parse would echo a magnitude the player never typed. The
        // fraction is TRUNCATED, never rounded — an echo that rounds 6.666 up
        // to 6.67 is a second number to reconcile, which is the opposite of
        // what this line is for.
        const whole = bare.slice(0, bare.length - exp);
        const frac = bare.slice(bare.length - exp, bare.length - exp + 2).replace(/0+$/, '');
        return `${groupDigits(whole)}${frac ? `.${frac}` : ''} ${label}`;
    }
    return null;
}
