import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import GlobalScoreboard from '../GlobalScoreboard';

/**
 * v2.57.0 (A5a) — hero card, Top 6 / My Score density toggle, live indicator
 * (tmp/global-scoreboard-a5a-contract.md).
 *
 * The page is exercised end-to-end rather than the components in isolation,
 * because the two things most likely to break are page-level: the toggle must
 * NOT refetch, and the hero must not be drawn twice (hero + its own grid row).
 */

// jsdom ships no matchMedia; ThemeProvider reads prefers-color-scheme.
if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/** Captured socket subscriptions, so a test can fire `score:new:global`. */
const { socketHandlers } = vi.hoisted(() => ({
    socketHandlers: {} as Record<string, Array<(data: unknown) => void>>,
}));

vi.mock('../../lib/websocket', () => ({
    getSocket: () => ({
        on: (event: string, fn: (data: unknown) => void) => {
            (socketHandlers[event] ||= []).push(fn);
        },
        off: (event: string, fn: (data: unknown) => void) => {
            socketHandlers[event] = (socketHandlers[event] || []).filter(h => h !== fn);
        },
        emit: vi.fn(),
    }),
}));

function entry(name: string, score: number, rank?: number) {
    return {
        iscored_username: name,
        display_name: null,
        score,
        avatar_hash: null,
        discord_user_id: `disc-${name}`,
        origin_room_slug: null,
        origin_room_logo_url: null,
        origin_room_short_tag: null,
        ...(rank != null ? { rank } : {}),
    };
}

type Row = Record<string, unknown>;

function game(over: Row = {}): Row {
    return {
        global_game_id: 'g-1',
        name: 'Medieval Madness',
        display_name: null,
        manufacturer: 'Williams',
        year: 1997,
        type: 'pinball',
        image_url: null,
        local_image_path: null,
        wheel_image_path: null,
        platforms: '["vpx"]',
        score_count: 9,
        top_score: 900,
        last_submitted_at: null,
        popularity: 1,
        avg_rating: 0,
        rating_count: 0,
        top_scores: [],
        ...over,
    };
}

function hero(over: Row = {}): Row {
    return game({
        global_game_id: 'hero-1',
        name: 'Attack from Mars',
        score_count: 42,
        top_scores: [entry('Champ', 9_000_000), entry('Runner', 6_000_000)],
        is_hot: true,
        weekly_score_count: 12,
        ...over,
    });
}

interface MockOpts {
    heroRow?: Row | null;
    prefs?: Record<string, string>;
}

/** Records every request so tests can assert on counts, not just outcomes. */
function mockFetch(games: Row[], opts: MockOpts = {}) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method || 'GET', body: init?.body as string | undefined });
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
        if (url.startsWith('/api/me/scoreboard-preferences')) return ok(opts.prefs ?? {});
        if (url.startsWith('/api/global/pins')) return ok({ pins: [] });
        if (url.startsWith('/api/global/scoreboard')) {
            return ok({
                data: games,
                total: games.length,
                hasMore: false,
                ...('heroRow' in opts ? { hero: opts.heroRow } : {}),
            });
        }
        if (url.startsWith('/api/rooms')) return ok([]);
        return ok({});
    });
    vi.stubGlobal('fetch', fn);
    return calls;
}

function renderPage(playerToken: string | null) {
    return render(
        <MemoryRouter initialEntries={['/scoreboard']}>
            <ThemeProvider>
                <ViewerAuthContext.Provider
                    value={{
                        token: null,
                        playerToken,
                        discordUser: playerToken
                            ? { discordId: 'disc-me', username: 'Me', avatar: null }
                            : null,
                        loginWithDiscord: vi.fn(),
                        loginWithGoogle: vi.fn(),
                        logoutPlayer: vi.fn(),
                    }}
                >
                    <GlobalScoreboard />
                </ViewerAuthContext.Provider>
            </ThemeProvider>
        </MemoryRouter>,
    );
}

/** Flip to My Score and wait for the cards to re-plan. */
async function selectMyScore() {
    fireEvent.click(await screen.findByText('My Score'));
    await waitFor(() => {
        expect(screen.getByText('My Score').closest('button')).toHaveAttribute('aria-pressed', 'true');
    });
}

beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    for (const key of Object.keys(socketHandlers)) delete socketHandlers[key];
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// ── Hero card ───────────────────────────────────────────────────────────────

describe('GlobalScoreboard — hero card', () => {
    it('renders the HOT badge and the weekly delta for a hot hero', async () => {
        mockFetch([game({ top_scores: [entry('P1', 900)] })], { heroRow: hero() });
        renderPage(null);

        expect(await screen.findByText('Attack from Mars')).toBeInTheDocument();
        expect(screen.getByText('Hot')).toBeInTheDocument();
        expect(screen.getByText('+12 scores this week')).toBeInTheDocument();
        // Champion block: name, score, and the gap to #2.
        expect(screen.getByText('Champion')).toBeInTheDocument();
        expect(screen.getByText('Champ')).toBeInTheDocument();
        expect(screen.getByText(/over #2/)).toBeInTheDocument();
    });

    it('renders a NEUTRAL hero with no HOT badge and no weekly claim below the threshold', async () => {
        // The server's below-threshold fallback: same card, `is_hot: false`.
        mockFetch([game({ top_scores: [entry('P1', 900)] })], {
            heroRow: hero({ is_hot: false, weekly_score_count: 1 }),
        });
        renderPage(null);

        expect(await screen.findByText('Attack from Mars')).toBeInTheDocument();
        expect(screen.queryByText('Hot')).not.toBeInTheDocument();
        expect(screen.queryByText(/scores this week/)).not.toBeInTheDocument();
        // Still a hero — the champion block is what the card is for.
        expect(screen.getByText('Champion')).toBeInTheDocument();
    });

    it('renders no hero at all when the payload carries none', async () => {
        mockFetch([game({ top_scores: [entry('P1', 900)] })], { heroRow: null });
        renderPage(null);

        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('Champion')).not.toBeInTheDocument();
        expect(screen.queryByText('Submit your score')).not.toBeInTheDocument();
    });

    it('does not draw the hero game a second time in the grid', async () => {
        const heroRow = hero({ global_game_id: 'g-1', name: 'Medieval Madness' });
        mockFetch([game({ top_scores: [entry('P1', 900)] })], { heroRow });
        renderPage(null);

        await screen.findByText('Champion');
        expect(screen.getAllByText('Medieval Madness')).toHaveLength(1);
    });

    /**
     * v2.70.0 — the champion marquee.
     *
     * The hero used to wear the grid's vocabulary: a fidelity-category chip
     * and up to two engine pills. Both are gone, and this is the assertion
     * that keeps them gone — re-adding either is exactly the regression that
     * would make the hero read as one more category board.
     */
    it('wears NO category chip and NO engine pills — gold is its only identity', async () => {
        mockFetch([game({ top_scores: [entry('P1', 900)] })], {
            heroRow: hero({ category: 'simulation', platforms: '["vpx","fx_classic"]' }),
        });
        renderPage(null);

        await screen.findByText('Attack from Mars');
        const heroCard = screen.getByTestId('global-hero-card');
        expect(within(heroCard).queryByTestId('category-chip')).not.toBeInTheDocument();
        // The engine pills rendered these exact labels pre-v2.70.
        expect(within(heroCard).queryByText('VPX')).not.toBeInTheDocument();
        expect(within(heroCard).queryByText(/Pinball FX/i)).not.toBeInTheDocument();
        // …but the board it ranks is unchanged: the detail link still carries
        // the category, so the card stopped NAMING the board, not scoping it.
        expect(within(heroCard).getByText('Attack from Mars').closest('a'))
            .toHaveAttribute('href', '/games/hero-1?category=simulation');
        // And the marquee is present. v2.72.0 swapped its four chase-light
        // strips for one travelling sweep: a masked ring over the frame plus
        // the rotating conic layer inside it. Gold-in-motion IS the identity
        // this test protects, so the mechanism is asserted, not just the node.
        const attract = within(heroCard).getByTestId('hero-attract');
        expect(attract).toBeInTheDocument();
        expect(attract.querySelector('.gg-hero__sweep')).not.toBeNull();
    });

    /**
     * v2.72.0 — the attract sweep's reduced-motion contract, asserted against
     * `index.css` itself.
     *
     * jsdom loads no stylesheet and evaluates no media query, so there is no
     * computed style to interrogate; the source is the only place the guard can
     * be checked, and it is worth checking because the failure mode is silent —
     * a rename of `.gg-hero__sweep` leaves a rule pointing at nothing and the
     * frame keeps spinning for users who asked it not to.
     *
     * Two halves, and the second is the one that actually encodes the doctrine:
     * the rotation stops AND the ring stays lit. `animation: none` alone would
     * park the segment on whatever edge the keyframe rested on; the flat
     * `background` override is what turns it into an even glow instead.
     */
    it('stops the attract sweep under prefers-reduced-motion but keeps the frame lit', () => {
        // Resolved from the vitest root (admin-ui/) — `import.meta.url` is a
        // transformed http:// URL under jsdom, not a file:// one. index.css is
        // CRLF-tracked on Windows; the block below is matched with bare \n.
        const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
            .replace(/\r\n/g, '\n');

        const start = css.indexOf('@media (prefers-reduced-motion: reduce) {');
        expect(start).toBeGreaterThan(-1);
        const block = css.slice(start, css.indexOf('\n}\n', start));

        const rule = block.slice(block.indexOf('.gg-hero__sweep {'));
        expect(rule).toContain('.gg-hero__sweep {');
        expect(rule).toContain('animation: none;');
        // Still gold, still the champion's frame — just not travelling.
        expect(rule).toContain('var(--sb-hero-sweep)');

        // And the strips this replaced are gone from the sheet entirely, so a
        // half-finished revert cannot leave both mechanisms running at once.
        expect(css).not.toContain('gg-hero__lamps');
    });

    /**
     * The ribbon is a CLAIM, so it obeys the same threshold the HOT badge and
     * the weekly count do. "Hottest board" above it, "Featured board" below —
     * the server's neutral fallback must not be dressed as a trend.
     */
    it('says HOTTEST BOARD only above the threshold, FEATURED BOARD below it', async () => {
        mockFetch([game({ top_scores: [entry('P1', 900)] })], { heroRow: hero() });
        const { unmount } = renderPage(null);
        expect(await screen.findByTestId('hero-ribbon')).toHaveTextContent('Hottest board');
        unmount();

        mockFetch([game({ top_scores: [entry('P1', 900)] })], {
            heroRow: hero({ is_hot: false, weekly_score_count: 1 }),
        });
        renderPage(null);
        expect(await screen.findByTestId('hero-ribbon')).toHaveTextContent('Featured board');
        expect(screen.queryByText('Hot')).not.toBeInTheDocument();
    });

    it('shows the hero Pin action only when logged in, and reflects pin state', async () => {
        mockFetch([game({ top_scores: [] })], { heroRow: hero({ is_pinned: true }) });
        const { unmount } = renderPage('tok');
        expect(await screen.findByLabelText('Unpin Attack from Mars')).toHaveAttribute('aria-pressed', 'true');
        unmount();

        mockFetch([game({ top_scores: [] })], { heroRow: hero() });
        renderPage(null);
        await screen.findByText('Attack from Mars');
        expect(screen.queryByLabelText(/^Pin /)).not.toBeInTheDocument();
    });
});

// ── Density toggle ──────────────────────────────────────────────────────────

describe('GlobalScoreboard — Top 6 / My Score toggle', () => {
    const nine = [
        entry('P1', 900), entry('P2', 800), entry('P3', 700), entry('P4', 600),
        entry('P5', 500), entry('P6', 400), entry('P7', 300), entry('P8', 200),
        entry('P9', 100),
    ];

    it('is hidden entirely for an anonymous viewer', async () => {
        mockFetch([game({ top_scores: nine })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('My Score')).not.toBeInTheDocument();
        expect(screen.queryByText('Top 6')).not.toBeInTheDocument();
    });

    it('defaults to Top 6 and shows ranks 1-6', async () => {
        mockFetch([game({ top_scores: nine, my_rank: 8, my_score: 200, neighbors: [] })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        expect(screen.getByText('Top 6').closest('button')).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('P6')).toBeInTheDocument();
        expect(screen.queryByText('P7')).not.toBeInTheDocument();
    });

    /**
     * The contract's headline requirement. `neighbors` shipped on the payload in
     * A4 precisely so the flip is instant; a round-trip per toggle makes the
     * control feel broken.
     *
     * "Zero additional requests" is asserted against the DATA endpoints. The
     * fire-and-forget preference write is not a refetch — it neither blocks nor
     * feeds the render — and is asserted separately below.
     */
    it('flips with ZERO additional data fetches', async () => {
        const calls = mockFetch([game({
            top_scores: nine,
            my_rank: 8,
            my_score: 200,
            neighbors: [entry('P7', 300, 7), entry('P8', 200, 8), entry('P9', 100, 9)],
        })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');

        const dataCalls = () => calls.filter(c =>
            c.url.startsWith('/api/global/scoreboard') || c.url.startsWith('/api/global/pins')).length;
        const before = dataCalls();

        await selectMyScore();
        // The rows genuinely changed — this is a re-plan, not a no-op.
        expect(screen.getByText('P7')).toBeInTheDocument();
        expect(screen.queryByText('P4')).not.toBeInTheDocument();
        expect(dataCalls()).toBe(before);

        // And back again, still with no fetch.
        fireEvent.click(screen.getByText('Top 6'));
        await waitFor(() => expect(screen.getByText('P4')).toBeInTheDocument());
        expect(dataCalls()).toBe(before);
    });

    it('persists the choice via the NAMESPACED scoreboard-preferences key', async () => {
        const calls = mockFetch([game({ top_scores: nine, my_rank: 8, neighbors: [] })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');

        await selectMyScore();

        await waitFor(() => {
            const write = calls.find(c => c.method === 'POST' && c.url.startsWith('/api/me/scoreboard-preferences'));
            expect(write).toBeTruthy();
            expect(JSON.parse(write?.body as string)).toEqual({ global_density: 'mine' });
        });
        // Never the theme-only, admin-scoped endpoint — it would 400.
        expect(calls.some(c => c.url.startsWith('/api/me/preferences'))).toBe(false);
        expect(localStorage.getItem('arcaid-scoreboard-density')).toBe('mine');
    });

    it('hydrates the stored preference from the server on mount', async () => {
        mockFetch([game({ top_scores: nine, my_rank: 8, neighbors: [] })], {
            prefs: { global_density: 'mine' },
        });
        renderPage('tok');
        await waitFor(() => {
            expect(screen.getByText('My Score').closest('button')).toHaveAttribute('aria-pressed', 'true');
        });
    });

    // ── the four edge cases from the design ─────────────────────────────────

    it('viewer ranked 1-3: ranks 1-5, no break line', async () => {
        mockFetch([game({
            top_scores: nine,
            my_rank: 2,
            my_score: 800,
            neighbors: [entry('P1', 900, 1), entry('P2', 800, 2), entry('P3', 700, 3)],
        })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        await selectMyScore();

        for (const n of ['P1', 'P2', 'P3', 'P4', 'P5']) {
            expect(screen.getByText(n)).toBeInTheDocument();
        }
        expect(screen.queryByText('P6')).not.toBeInTheDocument();
        expect(screen.queryByText('· · ·')).not.toBeInTheDocument();
        expect(screen.getByText('You')).toBeInTheDocument();
    });

    it('viewer ranked 4: contiguous 1-5, no break line', async () => {
        mockFetch([game({
            top_scores: nine,
            my_rank: 4,
            my_score: 600,
            neighbors: [entry('P3', 700, 3), entry('P4', 600, 4), entry('P5', 500, 5)],
        })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        await selectMyScore();

        expect(screen.getByText('P5')).toBeInTheDocument();
        expect(screen.queryByText('P6')).not.toBeInTheDocument();
        expect(screen.queryByText('· · ·')).not.toBeInTheDocument();
        // The player one rank above the viewer is the one to beat.
        expect(screen.getByText('Next')).toBeInTheDocument();
    });

    it('viewer ranked well below: podium, a break line, then their neighbourhood', async () => {
        mockFetch([game({
            top_scores: nine,
            my_rank: 8,
            my_score: 200,
            neighbors: [entry('P7', 300, 7), entry('P8', 200, 8), entry('P9', 100, 9)],
        })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        await selectMyScore();

        for (const n of ['P1', 'P2', 'P3', 'P7', 'P8', 'P9']) {
            expect(screen.getByText(n)).toBeInTheDocument();
        }
        expect(screen.queryByText('P4')).not.toBeInTheDocument();
        expect(screen.getByText('· · ·')).toBeInTheDocument();
        expect(screen.getByText('You')).toBeInTheDocument();
        expect(screen.getByText('Next')).toBeInTheDocument();
    });

    it('viewer has no score on the game: dashed prompt with the qualifying bar', async () => {
        mockFetch([game({ top_scores: nine, my_rank: null, my_score: null, neighbors: [] })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        await selectMyScore();

        expect(screen.getByText('P3')).toBeInTheDocument();
        expect(screen.queryByText('P4')).not.toBeInTheDocument();
        expect(screen.getByText('No score yet')).toBeInTheDocument();
        // Rank 6 is the lowest a Top 6 card shows — that is the bar to clear.
        expect(screen.getByText('#6 needs 400 to qualify')).toBeInTheDocument();
    });

    it('fewer than 6 scores: all of them, no break line, in either mode', async () => {
        // 'Solo', not 'Me': the header UserMenu also renders the viewer's username.
        const three = [entry('P1', 300), entry('P2', 200), entry('Solo', 100)];
        mockFetch([game({
            score_count: 3,
            top_scores: three,
            my_rank: 3,
            my_score: 100,
            neighbors: [entry('P2', 200, 2), entry('Solo', 100, 3)],
        })]);
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        expect(screen.getByText('Solo')).toBeInTheDocument();

        await selectMyScore();
        for (const n of ['P1', 'P2', 'Solo']) expect(screen.getByText(n)).toBeInTheDocument();
        expect(screen.queryByText('· · ·')).not.toBeInTheDocument();
        expect(screen.queryByText('No score yet')).not.toBeInTheDocument();
    });
});

// ── Live indicator ──────────────────────────────────────────────────────────

describe('GlobalScoreboard — live indicator', () => {
    it('carries the .pulse class on the dot (reduced motion is handled in index.css)', async () => {
        mockFetch([game({ top_scores: [entry('P1', 900)] })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');
        expect(screen.getByTestId('live-dot').getAttribute('class')).toContain('pulse');
    });

    it('counts up, and resets when a score:new:global event arrives', async () => {
        // Fake timers must predate the render: the page's 1s interval has to be
        // a fake one for `advanceTimersByTime` to drive it.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        mockFetch([game({ top_scores: [entry('P1', 900)] })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');

        act(() => { vi.advanceTimersByTime(5_000); });
        expect(screen.getByText(/LIVE · updated 5s ago/)).toBeInTheDocument();

        act(() => {
            for (const handler of socketHandlers['score:new:global'] || []) {
                handler({ globalGameId: 'g-1', gameName: 'Medieval Madness', playerName: 'P1', score: 1_000 });
            }
        });
        expect(screen.getByText(/LIVE · updated 0s ago/)).toBeInTheDocument();
    });

    it('sits BELOW the page description, as the last line of the header', async () => {
        // v2.63.0 — the status line used to sit between the title lockup and
        // the subtitle, pushing the page's own description down a row so that
        // telemetry was read before the sentence explaining what the page is.
        // The pack specifies lockup → subtitle adjacency; the live line is a
        // footer to that block, not a wedge inside it.
        mockFetch([game({ top_scores: [entry('P1', 900)] })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');

        const subtitle = screen.getByText(/High scores from every Arcaid room/);
        const status = screen.getByTestId('live-dot').closest('[role="status"]')!;
        expect(status).toBeInTheDocument();

        // DOCUMENT_POSITION_FOLLOWING === the status line comes after the
        // subtitle in document order, which is both the visual order and the
        // order a screen reader walks.
        expect(subtitle.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING)
            .toBeTruthy();

        // …and both still ride inside the lockup's body, indented to the
        // wordmark's left edge rather than escaping to the page.
        expect(status.parentElement).toBe(subtitle.parentElement);
    });
});
