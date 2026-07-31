import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import GlobalScoreboard from '../GlobalScoreboard';

// jsdom ships no matchMedia; ThemeProvider reads prefers-color-scheme.
if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => {}, removeListener: () => {},
        addEventListener: () => {}, removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

/**
 * v2.52.0 (A4) — the pin hotspot and the "YOU" row on /scoreboard.
 *
 * The page is exercised for real (not a extracted sub-component) because the
 * behaviour under test — optimistic toggle with revert — lives in the page's
 * state, not in the card.
 *
 * `getSocket` is mocked: the page subscribes to `score:new:global` on mount and
 * the real client would open a network connection under jsdom.
 */
vi.mock('../../lib/websocket', () => ({
    getSocket: () => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }),
}));

type ScoreEntry = ReturnType<typeof entry>;

interface MockGame {
    global_game_id: string;
    name: string;
    top_scores: ScoreEntry[];
    is_pinned?: boolean;
    my_rank?: number | null;
    my_score?: number | null;
    neighbors?: ScoreEntry[];
}

/** The page's full row shape is wider than MockGame; the rest is boilerplate. */
type MockRow = MockGame & Record<string, unknown>;

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

function game(over: Partial<MockGame> = {}): MockRow {
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
        score_count: 8,
        top_score: 800,
        last_submitted_at: null,
        popularity: 1,
        avg_rating: 0,
        rating_count: 0,
        top_scores: [],
        ...over,
    };
}

/**
 * One row of `GET /api/global/pins`, v2.55.0 shape: the rail renders the grid's
 * card, so the payload carries `top_scores` (ranks 1-6) — not the old
 * champion-only `top_player`.
 */
function pinRow(over: Record<string, unknown> = {}) {
    return {
        global_game_id: 'g-9',
        name: 'Twilight Zone',
        display_name: null,
        manufacturer: 'Bally',
        year: 1993,
        image_url: null,
        local_image_path: null,
        wheel_image_path: null,
        platforms: '["vpx"]',
        score_count: 0,
        top_score: null,
        top_scores: [],
        neighbors: [],
        my_rank: null,
        my_score: null,
        rank_delta: null,
        pinned_at: '2026-07-28T12:00:00.000Z',
        ...over,
    };
}

/** Registers a fetch stub. `pinResponse` controls the pin write's outcome. */
function mockFetch(games: MockRow[], opts: { pins?: Record<string, unknown>[]; pinOk?: boolean } = {}) {
    const calls: Array<{ url: string; method: string }> = [];
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method || 'GET';
        calls.push({ url, method });
        const ok = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;
        // Order matters: '/api/global/pins' also contains '/pin'.
        if (url.startsWith('/api/global/pins')) return ok({ pins: opts.pins ?? [] });
        if (url.endsWith('/pin')) {
            if (opts.pinOk === false) return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
            return ok({ pinned: method === 'POST', pin_count: 1 });
        }
        if (url.startsWith('/api/global/scoreboard')) return ok({ data: games, total: games.length, hasMore: false });
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

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('GlobalScoreboard — pin hotspot', () => {
    it('renders no pin control for an anonymous viewer', async () => {
        mockFetch([game({ top_scores: [entry('Champ', 800)] })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');
        expect(screen.queryByLabelText(/^Pin /)).not.toBeInTheDocument();
        expect(screen.queryByLabelText(/^Unpin /)).not.toBeInTheDocument();
    });

    it('flips optimistically on click and keeps the new state when the request succeeds', async () => {
        mockFetch([game({ top_scores: [entry('Champ', 800)], is_pinned: false })]);
        renderPage('tok');

        const btn = await screen.findByLabelText('Pin Medieval Madness');
        expect(btn).toHaveAttribute('aria-pressed', 'false');

        fireEvent.click(btn);
        // Optimistic: pressed before any await resolves.
        expect(screen.getByLabelText('Unpin Medieval Madness')).toHaveAttribute('aria-pressed', 'true');

        await waitFor(() => {
            expect(screen.getByLabelText('Unpin Medieval Madness')).toHaveAttribute('aria-pressed', 'true');
        });
    });

    it('reverts and toasts when the pin request fails', async () => {
        mockFetch([game({ top_scores: [entry('Champ', 800)], is_pinned: false })], { pinOk: false });
        renderPage('tok');

        const btn = await screen.findByLabelText('Pin Medieval Madness');
        fireEvent.click(btn);
        expect(screen.getByLabelText('Unpin Medieval Madness')).toHaveAttribute('aria-pressed', 'true');

        await waitFor(() => {
            expect(screen.getByLabelText('Pin Medieval Madness')).toHaveAttribute('aria-pressed', 'false');
        });
        expect(await screen.findByText('Could not pin that game.')).toBeInTheDocument();
    });

    it('sends the player token on the scoreboard request', async () => {
        const fn = vi.fn((url: string, init?: RequestInit) => {
            void url; void init; // captured via fn.mock.calls, not used here
            return Promise.resolve({ ok: true, json: async () => ({ data: [], total: 0, hasMore: false }) } as unknown as Response);
        });
        vi.stubGlobal('fetch', fn);
        renderPage('tok');
        await waitFor(() => {
            const call = fn.mock.calls.find(c => String(c[0]).startsWith('/api/global/scoreboard'));
            expect(call).toBeTruthy();
            expect(call?.[1]?.headers).toEqual({ Authorization: 'Bearer tok' });
        });
    });
});

describe('GlobalScoreboard — YOU row', () => {
    const eight = [
        entry('P1', 800), entry('P2', 700), entry('P3', 600), entry('P4', 500),
        entry('P5', 400), entry('P6', 300), entry('P7', 200), entry('P8', 100),
    ];

    it('appends the viewer row when their rank is outside the rendered top 6', async () => {
        mockFetch([game({
            top_scores: eight,
            my_rank: 8,
            my_score: 100,
            neighbors: [entry('P7', 200, 7), entry('MyRow', 100, 8)],
        })]);
        renderPage('tok');

        expect(await screen.findByText('You')).toBeInTheDocument();
        // The card shows 6 rows + the appended YOU row — never the 7th.
        expect(screen.queryByText('P7')).not.toBeInTheDocument();
        expect(screen.getByText('MyRow')).toBeInTheDocument();
    });

    it('does NOT append a YOU row when the viewer is already inside the top 6', async () => {
        mockFetch([game({
            top_scores: eight,
            my_rank: 3,
            my_score: 600,
            neighbors: [entry('P2', 700, 2), entry('P3', 600, 3), entry('P4', 500, 4)],
        })]);
        renderPage('tok');

        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('You')).not.toBeInTheDocument();
    });

    it('does NOT append a YOU row when the viewer has no rank on the game', async () => {
        mockFetch([game({ top_scores: eight, my_rank: null, my_score: null, neighbors: [] })]);
        renderPage('tok');

        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('You')).not.toBeInTheDocument();
    });

    it('does NOT append a YOU row when the board is short enough to already include them', async () => {
        // 3 scores total, viewer is rank 3 — rows.length is 3, so they render.
        mockFetch([game({
            top_scores: [entry('P1', 300), entry('P2', 200), entry('Me', 100)],
            my_rank: 3,
            my_score: 100,
            neighbors: [entry('P2', 200, 2), entry('Me', 100, 3)],
        })]);
        renderPage('tok');

        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('You')).not.toBeInTheDocument();
    });
});

describe('GlobalScoreboard — sort pills + rail visibility', () => {
    it('offers "Pinned first" and defaults to it only when logged in', async () => {
        mockFetch([game({ top_scores: [] })]);
        const { unmount } = renderPage('tok');
        const pinnedPill = await screen.findByText('Pinned first');
        expect(pinnedPill).toHaveAttribute('aria-pressed', 'true');
        unmount();

        mockFetch([game({ top_scores: [] })]);
        renderPage(null);
        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('Pinned first')).not.toBeInTheDocument();
        expect(screen.getByText('Popular')).toHaveAttribute('aria-pressed', 'true');
    });

    it('hides the rail entirely when the logged-in viewer has no pins', async () => {
        mockFetch([game({ top_scores: [] })], { pins: [] });
        renderPage('tok');
        await screen.findByText('Medieval Madness');
        expect(screen.queryByText('MY PINS')).not.toBeInTheDocument();
    });

    it('shows the rail once pins come back', async () => {
        mockFetch([game({ top_scores: [] })], { pins: [pinRow()] });
        renderPage('tok');
        expect(await screen.findByText('MY PINS')).toBeInTheDocument();
        expect(screen.getByText('Twilight Zone')).toBeInTheDocument();
    });

    /**
     * v2.55.0 — the rail renders the SAME card as the grid, so the pins payload
     * has to carry the leaderboard rows (it shipped only a champion pre-v2.55).
     */
    it('renders the pinned game as a full card, with rows from top_scores', async () => {
        mockFetch([game({ top_scores: [] })], {
            pins: [pinRow({
                score_count: 2,
                top_scores: [entry('Champ', 900), entry('Runner', 800)],
            })],
        });
        renderPage('tok');
        await screen.findByText('MY PINS');
        expect(screen.getByText('Champ')).toBeInTheDocument();
        expect(screen.getByText('Runner')).toBeInTheDocument();
        expect(screen.getByText('2 scores')).toBeInTheDocument();
    });

    it('unpinning from the rail drops the card immediately and does not refetch the list', async () => {
        const calls = mockFetch([game({ top_scores: [] })], { pins: [pinRow()] });
        renderPage('tok');
        await screen.findByText('MY PINS');

        fireEvent.click(screen.getByLabelText('Unpin Twilight Zone'));
        // Optimistic: gone before the request settles, and with it the section.
        expect(screen.queryByText('Twilight Zone')).not.toBeInTheDocument();
        expect(screen.queryByText('MY PINS')).not.toBeInTheDocument();

        await waitFor(() => {
            expect(calls.some(c => c.method === 'DELETE' && c.url.endsWith('/pin'))).toBe(true);
        });
        // Exactly one pins fetch — the mount one. No refetch on success.
        expect(calls.filter(c => c.url.startsWith('/api/global/pins')).length).toBe(1);
    });

    it('puts the card back and toasts when the unpin request fails', async () => {
        mockFetch([game({ top_scores: [] })], { pins: [pinRow()], pinOk: false });
        renderPage('tok');
        await screen.findByText('MY PINS');

        fireEvent.click(screen.getByLabelText('Unpin Twilight Zone'));
        expect(screen.queryByText('Twilight Zone')).not.toBeInTheDocument();

        expect(await screen.findByText('Could not unpin that game.')).toBeInTheDocument();
        expect(screen.getByText('Twilight Zone')).toBeInTheDocument();
    });
});
