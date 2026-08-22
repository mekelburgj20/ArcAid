import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import OnScreenKeyboard from '../OnScreenKeyboard';

/**
 * v2.128.0 (owner Android field report: "Done submits before I can check
 * anything").
 *
 * The invariant this file locks: **Done acts on pointer UP; every other key
 * acts on pointer DOWN.** Pressing Done unmounts the keyboard, so a
 * pointerdown-driven Done let the same touch's pointerup/click land on the
 * "Submit Score" button that had just slid under the finger. Digits must keep
 * their pointerdown immediacy (v2.101.1) — a thumb that slides between press
 * and release still has to deliver its digit.
 *
 * jsdom has no PointerEvent constructor, so `fireEvent.pointerDown/Up` build a
 * plain Event with the right type; that is enough for React's synthetic
 * handlers, which is all we assert on here.
 */
function renderKeyboard(mode: 'alpha' | 'numeric' = 'numeric') {
    const onKeyPress = vi.fn();
    const onBackspace = vi.fn();
    const onDone = vi.fn();
    render(
        <OnScreenKeyboard
            mode={mode}
            onKeyPress={onKeyPress}
            onBackspace={onBackspace}
            onDone={onDone}
        />,
    );
    return { onKeyPress, onBackspace, onDone };
}

describe.each(['numeric', 'alpha'] as const)('OnScreenKeyboard (%s) — Done key timing', mode => {
    it('pointerdown on Done does NOT fire onDone', () => {
        const { onDone } = renderKeyboard(mode);
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Done' }));
        expect(onDone).not.toHaveBeenCalled();
    });

    it('pointerup on Done fires onDone exactly once', () => {
        const { onDone } = renderKeyboard(mode);
        const done = screen.getByRole('button', { name: 'Done' });
        fireEvent.pointerDown(done);
        fireEvent.pointerUp(done);
        expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("a follow-up click does not fire onDone again (no onClick handler on any key)", () => {
        const { onDone } = renderKeyboard(mode);
        const done = screen.getByRole('button', { name: 'Done' });
        fireEvent.pointerDown(done);
        fireEvent.pointerUp(done);
        fireEvent.click(done);
        expect(onDone).toHaveBeenCalledTimes(1);
    });

    it("Done's pointerdown is default-prevented so no compatibility click is synthesized", () => {
        renderKeyboard(mode);
        const done = screen.getByRole('button', { name: 'Done' });
        const evt = new Event('pointerdown', { bubbles: true, cancelable: true });
        fireEvent(done, evt);
        expect(evt.defaultPrevented).toBe(true);
    });
});

describe('OnScreenKeyboard — every other key still acts on pointerdown', () => {
    it('a digit fires on pointerdown, before the finger lifts', () => {
        const { onKeyPress } = renderKeyboard('numeric');
        fireEvent.pointerDown(screen.getByRole('button', { name: '7' }));
        expect(onKeyPress).toHaveBeenCalledWith('7');
    });

    it('a digit does not double-fire on the pointerup/click that follows', () => {
        const { onKeyPress } = renderKeyboard('numeric');
        const seven = screen.getByRole('button', { name: '7' });
        fireEvent.pointerDown(seven);
        fireEvent.pointerUp(seven);
        fireEvent.click(seven);
        expect(onKeyPress).toHaveBeenCalledTimes(1);
    });

    it('backspace fires on pointerdown', () => {
        const { onBackspace } = renderKeyboard('numeric');
        fireEvent.pointerDown(screen.getByRole('button', { name: 'Backspace' }));
        expect(onBackspace).toHaveBeenCalledTimes(1);
    });
});
