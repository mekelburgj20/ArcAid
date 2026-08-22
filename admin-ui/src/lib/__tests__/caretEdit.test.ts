import { describe, it, expect } from 'vitest';
import { insertAtCaret, deleteAtCaret, readCaret } from '../caretEdit';

/**
 * v2.128.0 — caret-aware keypad edits (owner Android field report: "placing
 * the caret mid-score then typing jumps to the end").
 *
 * The pure half of the fix. The wiring into the score field is covered in
 * `components/__tests__/SubmissionSheet.keypad.test.tsx`.
 */
describe('insertAtCaret', () => {
    it('splices a digit at the caret and reports the caret AFTER it', () => {
        // Owner's exact repro: caret between "500" and "999", press 5.
        expect(insertAtCaret('500999', { start: 3, end: 3 }, '5')).toEqual({
            next: '5005999',
            caret: 4,
        });
    });

    it('replaces a selected range', () => {
        expect(insertAtCaret('500999', { start: 1, end: 3 }, '7')).toEqual({
            next: '57999',
            caret: 2,
        });
    });

    it('appends when the caret is at the end', () => {
        expect(insertAtCaret('123', { start: 3, end: 3 }, '4')).toEqual({ next: '1234', caret: 4 });
    });

    it('prepends when the caret is at the start', () => {
        expect(insertAtCaret('123', { start: 0, end: 0 }, '9')).toEqual({ next: '9123', caret: 1 });
    });

    it('falls back to appending with no selection info (null caret)', () => {
        expect(insertAtCaret('500999', null, '5')).toEqual({ next: '5009995', caret: null });
    });

    it('falls back to appending when the reported caret is out of range', () => {
        expect(insertAtCaret('12', { start: 9, end: 9 }, '3')).toEqual({ next: '123', caret: null });
    });
});

describe('deleteAtCaret', () => {
    it('deletes the character BEFORE the caret', () => {
        // "500999", caret at 3 → drops the '0' at index 2.
        expect(deleteAtCaret('500999', { start: 3, end: 3 })).toEqual({ next: '50999', caret: 2 });
    });

    it('deletes a selected range instead of one character', () => {
        expect(deleteAtCaret('500999', { start: 1, end: 3 })).toEqual({ next: '5999', caret: 1 });
    });

    it('is a no-op at the very start of the value', () => {
        expect(deleteAtCaret('500999', { start: 0, end: 0 })).toEqual({ next: '500999', caret: 0 });
    });

    it('falls back to trailing-delete with no selection info', () => {
        expect(deleteAtCaret('500999', null)).toEqual({ next: '50099', caret: null });
    });

    it('trailing-deletes an empty value without throwing', () => {
        expect(deleteAtCaret('', null)).toEqual({ next: '', caret: null });
    });
});

describe('readCaret', () => {
    it('returns null for a missing element', () => {
        expect(readCaret(null)).toBeNull();
    });

    it('reads a text input selection', () => {
        const el = document.createElement('input');
        el.type = 'text';
        el.value = '500999';
        document.body.appendChild(el);
        el.setSelectionRange(2, 4);
        expect(readCaret(el)).toEqual({ start: 2, end: 4 });
        el.remove();
    });

    it('returns null when the browser refuses to report a selection', () => {
        // Mirrors `input[type=number]`, where selectionStart throws in
        // Chrome/Safari and is null in Firefox.
        const throwing = {
            get selectionStart(): number | null {
                throw new DOMException('InvalidStateError');
            },
            get selectionEnd(): number | null {
                return null;
            },
        } as unknown as HTMLInputElement;
        expect(readCaret(throwing)).toBeNull();

        const nulled = { selectionStart: null, selectionEnd: null } as unknown as HTMLInputElement;
        expect(readCaret(nulled)).toBeNull();
    });

    it('normalizes a backwards selection', () => {
        const backwards = { selectionStart: 5, selectionEnd: 2 } as unknown as HTMLInputElement;
        expect(readCaret(backwards)).toEqual({ start: 2, end: 5 });
    });
});
