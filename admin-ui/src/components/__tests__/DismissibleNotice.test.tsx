import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DismissibleNotice from '../DismissibleNotice';

/**
 * W83 - the shared wrapper for room-page notices: an X always, plus a sideways
 * swipe on touch that commits past 40% of the width or on a quick flick, springs
 * back otherwise, yields to a vertical scroll, and ignores the mouse.
 */

let now = 0;
beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 300, height: 40, top: 0, left: 0, right: 300, bottom: 40, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
    const onDismiss = vi.fn();
    const onLinkClick = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(
        <DismissibleNotice noticeKey="k1" onDismiss={onDismiss}>
            <a href="/somewhere" onClick={onLinkClick}>Notice text</a>
        </DismissibleNotice>,
    );
    return { onDismiss, onLinkClick, el: screen.getByTestId('dismissible-notice') };
}

/** One drag: down at (0,0), move to (dx,dy), release there `ms` later. */
function drag(el: HTMLElement, dx: number, dy: number, ms: number, pointerType = 'touch') {
    fireEvent.pointerDown(el, { pointerId: 1, pointerType, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType, clientX: dx / 2, clientY: dy / 2 });
    fireEvent.pointerMove(el, { pointerId: 1, pointerType, clientX: dx, clientY: dy });
    now += ms;
    fireEvent.pointerUp(el, { pointerId: 1, pointerType, clientX: dx, clientY: dy });
}

describe('DismissibleNotice (W83)', () => {
    it('exposes its key and dismisses on the X', () => {
        const { onDismiss, el, onLinkClick } = setup();
        expect(el.getAttribute('data-notice-key')).toBe('k1');
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(onLinkClick).not.toHaveBeenCalled();
    });

    it('a touch swipe past 40% of the width dismisses (after the slide-out)', async () => {
        const { onDismiss, el } = setup();
        drag(el, 150, 0, 2000);
        await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    });

    it('a swipe to the left counts too', async () => {
        const { onDismiss, el } = setup();
        drag(el, -150, 0, 2000);
        await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    });

    it('a quick flick dismisses even when short', async () => {
        const { onDismiss, el } = setup();
        drag(el, 60, 0, 50); // 1.2 px/ms
        await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    });

    it('with reduced motion the dismiss is instant', () => {
        vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduced-motion'), addEventListener() {}, removeEventListener() {} }));
        const { onDismiss, el } = setup();
        drag(el, 150, 0, 2000);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('a short slow swipe springs back', async () => {
        const { onDismiss, el } = setup();
        fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
        fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 0 });
        expect(el.style.transform).toBe('translateX(50px)');
        now += 2000;
        fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 50, clientY: 0 });
        expect(el.style.transform).toBe('');
        await new Promise(r => setTimeout(r, 200));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('a mostly-vertical move is a scroll, never a dismiss', async () => {
        const { onDismiss, el } = setup();
        fireEvent.pointerDown(el, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
        fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 40 });
        fireEvent.pointerMove(el, { pointerId: 1, pointerType: 'touch', clientX: 250, clientY: 60 });
        expect(el.style.transform).toBe('');
        now += 50;
        fireEvent.pointerUp(el, { pointerId: 1, pointerType: 'touch', clientX: 250, clientY: 60 });
        await new Promise(r => setTimeout(r, 200));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('a mouse drag does nothing', async () => {
        const { onDismiss, el } = setup();
        drag(el, 250, 0, 50, 'mouse');
        expect(el.style.transform).toBe('');
        await new Promise(r => setTimeout(r, 200));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('swallows the click that follows a drag, but not a plain tap', () => {
        const { onLinkClick, el } = setup();
        drag(el, 50, 0, 2000); // springs back
        fireEvent.click(screen.getByText('Notice text'));
        expect(onLinkClick).not.toHaveBeenCalled();
        fireEvent.pointerDown(el, { pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
        fireEvent.pointerUp(el, { pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
        fireEvent.click(screen.getByText('Notice text'));
        expect(onLinkClick).toHaveBeenCalledTimes(1);
    });
});
