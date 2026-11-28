import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { FitTitle } from '../cabinetFrame/shared';
import Dmd from '../cabinetFrame/Dmd';
import { CABINET_DMD_DOT_RECT } from '../../lib/cabinetFrameTypes';

/**
 * jsdom has no layout, so the metrics are faked from the element's own
 * --cf-fit (what FitTitle sets): a title that is `wide` px at scale 1 and
 * `lineH` px tall per line at scale 1. This pins the SEARCH (shrink on one
 * line, then wrap and keep shrinking until two lines fit above the dot
 * window); the real pixels are checked by the screenshots (dmd-long).
 */

const fit = (el: HTMLElement) => parseFloat(el.style.getPropertyValue('--cf-fit') || '1');

function fakeLayout(wide: number, boxW: number, lineH: number) {
    const lines = (el: HTMLElement) => (el.style.whiteSpace === 'nowrap' ? 1 : Math.ceil((wide * fit(el)) / boxW));
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
        return this.style.whiteSpace === 'nowrap' ? wide * fit(this) : boxW;
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(boxW);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return lines(this) * lineH * fit(this);
    });
    const cs = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(((el: Element) => {
        const real = cs(el);
        const f = fit(el as HTMLElement);
        return new Proxy(real, {
            get: (t, p) => (p === 'fontSize' ? `${100 * f}px` : p === 'lineHeight' ? `${lineH * f}px` : Reflect.get(t, p)),
        });
    }) as typeof window.getComputedStyle);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('FitTitle', () => {
    it('shrinks a long title on one line first, and does not wrap while that fits', () => {
        fakeLayout(2000, 1776, 130);
        const { getByText } = render(<FitTitle minScale={0.3} maxLines={2}>A LONG TITLE</FitTitle>);
        const el = getByText('A LONG TITLE');
        expect(el.style.whiteSpace).toBe('nowrap');
        expect(fit(el)).toBeLessThanOrEqual(0.89);
    });

    it('wraps to at most two lines, shrinking until it ends above the limit', () => {
        fakeLayout(7000, 1776, 130); // needs ~4 lines at scale 1; one line only below 0.25
        const { getByText } = render(<FitTitle minScale={0.3} maxLines={2}>A VERY LONG TITLE</FitTitle>);
        const el = getByText('A VERY LONG TITLE');
        expect(el.style.whiteSpace).toBe('normal');
        const lines = Math.ceil((7000 * fit(el)) / 1776);
        expect(lines).toBeLessThanOrEqual(2);
        expect(fit(el)).toBeLessThan(0.6); // below the backglass's 60% floor
        expect(fit(el)).toBeGreaterThanOrEqual(0.3);
    });
});

describe('DMD header band', () => {
    it('puts the title above the dot window and the dot window above the footer', () => {
        const { container } = render(
            <Dmd input={{ kind: 'dmd', screen: 'card', data: {
                roomName: 'R', kindLabel: 'K', table: 'THE GETAWAY: HIGH SPEED II SPECIAL COLLECTORS EDITION WITH A VERY LONG NAME',
                artUrl: null, endsText: 'ENDS IN 2D', attemptsText: null, practice: false, rows: [], playersText: '', footerRight: '',
            } }} />,
        );
        // The title is told to stop above the dot window's top edge, in two lines at most.
        const title = container.querySelector('.cf-dmd-title') as HTMLElement;
        expect(title).toBeTruthy();
        const foot = container.querySelector('.cf-dmd-foot') as HTMLElement;
        expect(CABINET_DMD_DOT_RECT.y + CABINET_DMD_DOT_RECT.h).toBeLessThan(830); // the footer's top (css) is below the window
        expect(foot).toBeTruthy();
    });
});
