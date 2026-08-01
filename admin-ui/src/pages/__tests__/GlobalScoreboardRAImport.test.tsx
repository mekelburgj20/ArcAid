import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalScoreboard from '../GlobalScoreboard';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/**
 * Contract §4, the owner's headline ask: a player who searches for a game the
 * catalogue doesn't have must be able to add it from RetroAchievements and post
 * a score, without leaving /scoreboard.
 *
 * The offer appears in TWO places on this page and both are load-bearing:
 *   * inside the ⌘K palette's no-results state — typing opens the palette, and
 *     while it is open the page behind it is dimmed and `aria-hidden`, so an
 *     offer that lived only on the page would be unreachable exactly when the
 *     player is told "no games match"
 *   * on the page itself, under/instead of the grid, once the palette is closed
 *
 * These tests exercise both, plus the guest affordance and the post-import
 * refetch that puts the new (scoreless, therefore claimable) card on screen.
 */

vi.mock('../../lib/websocket', () => ({
    getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
    return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn() {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    localStorage.setItem('arcaid_player_token', fakeJwt({ discordId: 'd1', username: 'Tester', avatar: null, exp }));
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId: 'd1', username: 'Tester', avatar: null }));
}

const RA_ROW = {
    raGameId: 1447,
    title: 'Donkey Kong',
    consoleId: 7,
    consoleName: 'NES/Famicom',
    iconUrl: null,
    numAchievements: 12,
    numLeaderboards: 3,
    inCatalogue: false,
    globalGameId: null,
    scoreEligibility: null,
};

const ATTRIBUTION = {
    source: 'RetroAchievements',
    url: 'https://retroachievements.org',
    label: 'Data from RetroAchievements',
};

function claimCard(id: string, name: string) {
    return {
        global_game_id: id,
        card_id: `${id}::none`,
        name,
        display_name: null,
        manufacturer: null,
        year: null,
        type: 'video_game',
        image_url: null,
        local_image_path: null,
        wheel_image_path: null,
        platforms: JSON.stringify(['nes']),
        score_count: 0,
        top_score: null,
        last_submitted_at: null,
        avg_rating: 0,
        rating_count: 0,
        top_scores: [],
        category: null,
        prospective_category: 'video',
    };
}

/**
 * `scoreboardGames` is a function so a test can change what the NEXT scoreboard
 * fetch returns — which is how the post-import refetch is observed.
 */
function mockFetch(scoreboardGames: () => unknown[], raResults: unknown[] = [RA_ROW]) {
    const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/global/ra-catalogue/import/')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: () => Promise.resolve({
                    success: true, action: 'inserted', raGameId: 1447,
                    scoreEligibility: 'score', leaderboardCount: 3,
                    game: { id: 'gg-dk', name: 'Donkey Kong' },
                    attribution: ATTRIBUTION,
                }),
            });
        }
        if (url.startsWith('/api/global/ra-catalogue/search')) {
            return Promise.resolve({
                ok: true, status: 200,
                json: () => Promise.resolve({
                    results: raResults,
                    masterList: { total: 12000, lastSyncedAt: '2026-08-01T00:00:00Z', stale: false, syncing: false },
                    configured: true,
                    attribution: ATTRIBUTION,
                }),
            });
        }
        if (url.startsWith('/api/global/scoreboard')) {
            const games = scoreboardGames();
            return Promise.resolve({
                ok: true, status: 200,
                json: () => Promise.resolve({ data: games, total: games.length, hasMore: false, hero: null }),
            });
        }
        if (url.startsWith('/api/global/pins')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ pins: [] }) });
        }
        if (url.startsWith('/api/rooms')) {
            return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
        }
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    return fetchMock;
}

function renderScoreboard() {
    return render(
        <MemoryRouter initialEntries={['/scoreboard']}>
            <ThemeProvider>
                <ViewerAuthProvider>
                    <GlobalScoreboard />
                </ViewerAuthProvider>
            </ThemeProvider>
        </MemoryRouter>,
    );
}

/** Type into the page's (palette-owned) search field. Typing opens the palette. */
function typeSearch(term: string) {
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: term } });
}

/** Dismiss the palette so the page behind it is live (and not aria-hidden). */
function closePalette() {
    fireEvent.keyDown(screen.getByPlaceholderText(/search/i), { key: 'Escape' });
}

/** The RA offer rendered inside the palette dropdown. */
function paletteOffer() {
    return within(screen.getByRole('listbox', { name: 'Game search results' }));
}

describe('GlobalScoreboard — RetroAchievements import (§4)', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
        document.documentElement.className = '';
        window.HTMLElement.prototype.scrollIntoView = vi.fn();
    });

    it('stays out of the way until something is actually searched for', async () => {
        mockFetch(() => [claimCard('g1', 'Medieval Madness')]);
        renderScoreboard();

        await waitFor(() => expect(screen.getByText('Medieval Madness')).toBeInTheDocument());
        expect(screen.queryByTestId('ra-search')).not.toBeInTheDocument();
    });

    it('offers RA results with an Add button inside the palette when nothing matches', async () => {
        signIn();
        mockFetch(() => []);
        renderScoreboard();
        typeSearch('donkey kong');

        const offer = await waitFor(() => {
            const o = paletteOffer();
            expect(o.getByText('Donkey Kong')).toBeInTheDocument();
            return o;
        }, { timeout: 3000 });

        expect(offer.getByText(/NES\/Famicom/)).toBeInTheDocument();
        expect(offer.getByText(/3 leaderboards/)).toBeInTheDocument();
        expect(offer.getByRole('button', { name: /Add to Arcaid/ })).toBeInTheDocument();
        // Community attribution is contractual, not decorative.
        expect(offer.getByText('Data from RetroAchievements')).toBeInTheDocument();
    });

    it('also offers it on the page itself once the palette is dismissed', async () => {
        signIn();
        mockFetch(() => []);
        renderScoreboard();
        typeSearch('donkey kong');
        await waitFor(() => expect(paletteOffer().getByText('Donkey Kong')).toBeInTheDocument(), { timeout: 3000 });

        closePalette();

        await waitFor(() => {
            expect(screen.getByText('No leaderboards found. Try adjusting your filters.')).toBeInTheDocument();
            expect(screen.getByTestId('ra-search')).toBeInTheDocument();
        });
        expect(within(screen.getByTestId('ra-search')).getByRole('button', { name: /Add to Arcaid/ }))
            .toBeInTheDocument();
    });

    it('shows a guest the login affordance instead of an Add button', async () => {
        mockFetch(() => []);
        renderScoreboard();
        typeSearch('donkey kong');

        const offer = await waitFor(() => {
            const o = paletteOffer();
            expect(o.getByText('Donkey Kong')).toBeInTheDocument();
            return o;
        }, { timeout: 3000 });

        expect(offer.queryByRole('button', { name: /Add to Arcaid/ })).not.toBeInTheDocument();
        expect(offer.getByRole('button', { name: /Log in to add this game/ })).toBeInTheDocument();
    });

    it('imports, refetches, and lands the new claim card on screen', async () => {
        signIn();
        let imported = false;
        const fetchMock = mockFetch(() => (imported ? [claimCard('gg-dk', 'Donkey Kong')] : []));
        renderScoreboard();
        typeSearch('donkey kong');

        const addButton = await waitFor(
            () => paletteOffer().getByRole('button', { name: /Add to Arcaid/ }),
            { timeout: 3000 },
        );
        fireEvent.click(addButton);

        await waitFor(() => {
            expect(fetchMock.mock.calls.some(
                c => String(c[0]).startsWith('/api/global/ra-catalogue/import/1447'),
            )).toBe(true);
        });
        imported = true;

        // The import rewrites the search to the imported title, which re-runs
        // the page's one fetch effect; the card lands ringed and scrolled to.
        closePalette();
        await waitFor(() => expect(screen.getByTestId('ra-import-notice')).toHaveTextContent(
            /Donkey Kong is on Arcaid now/,
        ), { timeout: 3000 });
        await waitFor(() => expect(screen.getByTestId('ra-imported-card')).toBeInTheDocument(), { timeout: 3000 });
        expect(screen.getByTestId('ra-imported-card')).toHaveTextContent('Donkey Kong');
    });
});
