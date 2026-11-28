import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import CabinetFrame from '../CabinetFrame';
import { sampleFor, SAMPLE_SCREENS } from '../../lib/cabinetFrameSamples';
import type { CabinetFrameInput, CabinetFrameKind, CabinetScreenKey } from '../../lib/cabinetFrameTypes';

/**
 * W132.3 (ADR 0046): /cabinet-frame draws the injected frame, signals ready,
 * and (without an injected frame) shows a switchable sample so a person can
 * review the look in a browser.
 */

const win = window as unknown as Record<string, unknown>;
const inject = (i: CabinetFrameInput | undefined) => { if (i) win.__CABINET_FRAME__ = i; else delete win.__CABINET_FRAME__; };
const renderPage = () => render(<CabinetFrame settleMs={0} />);

beforeEach(() => { window.history.replaceState(null, '', '/cabinet-frame'); });
afterEach(() => { cleanup(); inject(undefined); delete win.__cabinetFrameReady; });

const KINDS: CabinetFrameKind[] = ['backglass', 'dmd'];

describe('CabinetFrame with an injected frame', () => {
    for (const kind of KINDS) {
        for (const s of SAMPLE_SCREENS) {
            it(`draws ${s} as the ${kind} and signals ready`, async () => {
                inject(sampleFor(s, kind));
                renderPage();
                const frame = screen.getByTestId('cabinet-frame');
                expect(frame).toHaveAttribute('data-screen', s);
                expect(frame).toHaveAttribute('data-kind', kind);
                expect(frame.style.width).toBe('1920px');
                expect(frame.style.height).toBe(kind === 'dmd' ? '1200px' : '1080px');
                // A picture, never the sample switcher.
                expect(screen.queryByTestId('cabinet-frame-sample')).toBeNull();
                await waitFor(() => expect(win.__cabinetFrameReady).toBe(true));
            });
        }
    }

    it('draws the dot window on the DMD screens that have dots, and not on pair', () => {
        const withDots: CabinetScreenKey[] = ['attract', 'card', 'global', 'standings', 'activity', 'event'];
        for (const s of withDots) {
            inject(sampleFor(s, 'dmd'));
            const { unmount } = renderPage();
            const dots = screen.getByTestId('cf-dots');
            expect(dots.style.left).toBe('64px');
            expect(dots.style.top).toBe('318px');
            expect(dots.style.width).toBe('1792px');
            expect(dots.style.height).toBe('448px');
            unmount();
        }
        inject(sampleFor('pair', 'dmd'));
        renderPage();
        expect(screen.queryByTestId('cf-dots')).toBeNull();
        expect(screen.getByText('K7Q4MX')).toBeInTheDocument();
    });

    it('draws the card from the data: titles whole, board rows, your row marked, PRACTICE loud', () => {
        const base = sampleFor('card', 'backglass');
        if (base.screen !== 'card') throw new Error('fixture');
        inject({
            ...base,
            data: {
                ...base.data, table: 'THE GETAWAY: HIGH SPEED II WITH A VERY LONG TABLE NAME', practice: true, attemptsText: 'PRACTICE',
                artUrl: '/api/catalogue-images/acdc.webp',
                rows: [...base.data.rows, { rank: '9', name: '', score: '10', me: false }],
            },
        });
        const { container } = renderPage();
        expect(screen.getByText('THE GETAWAY: HIGH SPEED II WITH A VERY LONG TABLE NAME')).toBeInTheDocument();
        expect(screen.getByText('PRACTICE')).toHaveClass('cf-chip--loud');
        expect(container.querySelectorAll('.aw-board-row--current')).toHaveLength(1);
        expect(container.querySelector('.aw-board-row--current')).toHaveTextContent('JUSTIN');
        expect(container.querySelector<HTMLElement>('.cf-art')?.style.backgroundImage).toBe('url("/api/catalogue-images/acdc.webp")');
        // A row with no resolvable name is never blank or an id.
        expect(screen.getByText('A PLAYER')).toBeInTheDocument();
    });

    it('renders no raw user ids (long digit runs) for any screen', () => {
        for (const s of SAMPLE_SCREENS) {
            inject(sampleFor(s, 'backglass'));
            const { container, unmount } = renderPage();
            expect(container.textContent).not.toMatch(/\d{15,}/);
            unmount();
        }
    });

    it('draws a real QR for the pair url', () => {
        inject(sampleFor('pair', 'backglass'));
        renderPage();
        const qr = screen.getByRole('img', { name: /qr code/i });
        expect(qr.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
        expect((qr.querySelector('path')?.getAttribute('d') ?? '').length).toBeGreaterThan(100);
    });

    it('says what is up when nobody is playing instead of a blank name', () => {
        const base = sampleFor('attract', 'backglass');
        if (base.screen !== 'attract') throw new Error('fixture');
        inject({ ...base, data: { ...base.data, player: null } });
        renderPage();
        expect(screen.getByText('WAITING FOR A PLAYER')).toBeInTheDocument();
        expect(screen.queryByText('PLAYING AS')).toBeNull();
    });
});

describe('CabinetFrame without an injected frame', () => {
    it('shows a sample with a switcher', async () => {
        renderPage();
        expect(screen.getByTestId('cabinet-frame-sample')).toBeInTheDocument();
        expect(screen.getByTestId('cabinet-frame')).toHaveAttribute('data-screen', 'card');
        fireEvent.click(screen.getByRole('button', { name: 'Standings' }));
        expect(screen.getByTestId('cabinet-frame')).toHaveAttribute('data-screen', 'standings');
        fireEvent.click(screen.getByRole('button', { name: 'DMD' }));
        expect(screen.getByTestId('cabinet-frame')).toHaveAttribute('data-kind', 'dmd');
        expect(window.location.search).toContain('screen=standings');
        expect(window.location.search).toContain('kind=dmd');
        await waitFor(() => expect(win.__cabinetFrameReady).toBe(true));
    });

    it('starts on the screen and kind named in the query', () => {
        window.history.replaceState(null, '', '/cabinet-frame?screen=event&kind=dmd');
        renderPage();
        expect(screen.getByTestId('cabinet-frame')).toHaveAttribute('data-screen', 'event');
        expect(screen.getByTestId('cabinet-frame')).toHaveAttribute('data-kind', 'dmd');
    });
});
