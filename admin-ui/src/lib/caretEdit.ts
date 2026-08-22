/**
 * Caret-aware text edits for the in-app on-screen keyboard (v2.128.0).
 *
 * Owner Android field report: on touch devices the score field is
 * `type=text inputMode=none` (the OS keypad is suppressed so it can't cover
 * the score photo — see SubmissionSheet), so the NATIVE caret still moves
 * when the player taps inside the value. The keypad, however, only ever
 * appended (`prev + key`) and trailing-deleted (`prev.slice(0, -1)`), so
 * placing the caret mid-score and typing appeared to "jump to the end".
 *
 * These two pure helpers do the splice, and report where the caret should
 * land afterwards so the caller can restore it once React has committed the
 * new value. They are deliberately free of DOM access: `readCaret` is the
 * only place that touches an element, and it degrades to `null` (→ the old
 * append / trailing-delete behaviour) whenever the browser refuses to report
 * a selection — notably `<input type="number">`, where `selectionStart`
 * throws in Chrome/Safari and is `null` in Firefox.
 */

export interface CaretRange {
    start: number;
    end: number;
}

export interface CaretEdit {
    /** New field value. */
    next: string;
    /** Where the caret should be placed after commit, or `null` for "leave it" (append case). */
    caret: number | null;
}

/**
 * Reads the current selection from an input, or `null` when the element is
 * missing or does not support selection (number inputs throw or report null).
 */
export function readCaret(el: HTMLInputElement | null | undefined): CaretRange | null {
    if (!el) return null;
    try {
        const start = el.selectionStart;
        if (start === null || start === undefined) return null;
        const rawEnd = el.selectionEnd;
        const end = rawEnd === null || rawEnd === undefined ? start : rawEnd;
        if (start > end) return { start: end, end: start };
        return { start, end };
    } catch {
        // `input[type=number]`.selectionStart throws InvalidStateError.
        return null;
    }
}

/**
 * Inserts `insert` at the caret, replacing any selected range.
 * With no caret info (or an out-of-range one) it appends, matching the
 * pre-v2.128.0 behaviour.
 */
export function insertAtCaret(value: string, caret: CaretRange | null, insert: string): CaretEdit {
    if (!caret || caret.start < 0 || caret.start > value.length) {
        return { next: value + insert, caret: null };
    }
    const end = Math.min(Math.max(caret.end, caret.start), value.length);
    return {
        next: value.slice(0, caret.start) + insert + value.slice(end),
        caret: caret.start + insert.length,
    };
}

/**
 * Backspace semantics: delete the selected range if there is one, otherwise
 * the single character BEFORE the caret. With no caret info it drops the last
 * character (pre-v2.128.0 behaviour); at the very start of the value it is a
 * no-op, exactly like a real keyboard.
 */
export function deleteAtCaret(value: string, caret: CaretRange | null): CaretEdit {
    if (!caret || caret.start < 0 || caret.start > value.length) {
        return { next: value.slice(0, -1), caret: null };
    }
    const end = Math.min(Math.max(caret.end, caret.start), value.length);
    if (end > caret.start) {
        return { next: value.slice(0, caret.start) + value.slice(end), caret: caret.start };
    }
    if (caret.start === 0) return { next: value, caret: 0 };
    return { next: value.slice(0, caret.start - 1) + value.slice(caret.start), caret: caret.start - 1 };
}
