import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import RAGameSearch from '../RAGameSearch';

/**
 * Contract §4 — the one search+import component behind all three surfaces.
 *
 * The tests below deliberately exercise it through its PROPS rather than
 * through each host page: the whole point of the shared component is that the
 * player path and the two admin paths differ only in endpoint base and
 * capability, so verifying those two axes here is what stops them drifting.
 */

const ATTRIBUTION = {
    source: 'RetroAchievements',
    url: 'https://retroachievements.org',
    label: 'Data from RetroAchievements',
};

function searchPayload(overrides: Record<string, unknown> = {}) {
    return {
        results: [
            {
                raGameId: 1447,
                title: 'Donkey Kong',
                consoleId: 7,
                consoleName: 'NES/Famicom',
                iconUrl: 'https://media.retroachievements.org/Images/1.png',
                numAchievements: 12,
                numLeaderboards: 3,
                inCatalogue: false,
                globalGameId: null,
                scoreEligibility: null,
            },
        ],
        masterList: { total: 12000, lastSyncedAt: '2026-08-01T00:00:00Z', stale: false, syncing: false },
        configured: true,
        attribution: ATTRIBUTION,
        ...overrides,
    };
}

function ok(body: unknown, status = 200) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

describe('RAGameSearch', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('searches the surface it was pointed at and renders console + leaderboard count', async () => {
        const fetchMock = vi.fn(() => ok(searchPayload()));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="donkey" debounceMs={0} canImport />,
        );

        await waitFor(() => expect(screen.getByText('Donkey Kong')).toBeInTheDocument());
        expect(fetchMock.mock.calls[0][0]).toContain('/api/global/ra-catalogue/search?q=donkey');
        expect(screen.getByText(/NES\/Famicom/)).toBeInTheDocument();
        expect(screen.getByText(/3 leaderboards/)).toBeInTheDocument();
        // Community attribution is contractual, not decorative.
        expect(screen.getByText('Data from RetroAchievements')).toHaveAttribute(
            'href', 'https://retroachievements.org',
        );
    });

    it('imports through the same base path and flips the row to "In Arcaid"', async () => {
        const fetchMock = vi.fn((url: string, init?: RequestInit) => {
            if (init?.method === 'POST') {
                return ok({
                    success: true, action: 'inserted', raGameId: 1447,
                    scoreEligibility: 'score', leaderboardCount: 3,
                    game: { id: 'gg-1', name: 'Donkey Kong' },
                    attribution: ATTRIBUTION,
                });
            }
            return ok(searchPayload());
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
        const onImported = vi.fn();

        render(
            <RAGameSearch
                basePath="/rooms/room-1/ra-catalogue"
                authMode="admin"
                query="donkey"
                debounceMs={0}
                canImport
                onImported={onImported}
            />,
        );

        await waitFor(() => expect(screen.getByText('Donkey Kong')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /Add to Arcaid/ }));

        await waitFor(() => expect(onImported).toHaveBeenCalled());
        const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit)?.method === 'POST');
        expect(post?.[0]).toBe('/api/rooms/room-1/ra-catalogue/import/1447');
        expect(onImported.mock.calls[0][0].game.id).toBe('gg-1');
        // No refetch needed — the row reports its own new state.
        await waitFor(() => expect(screen.getByText('In Arcaid')).toBeInTheDocument());
    });

    it('shows a friendly message when the per-user import cap trips (429)', async () => {
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => (
            init?.method === 'POST'
                ? ok({ error: 'Too many requests' }, 429)
                : ok(searchPayload())
        ));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="donkey" debounceMs={0} canImport />,
        );
        await waitFor(() => expect(screen.getByText('Donkey Kong')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /Add to Arcaid/ }));

        await waitFor(() => expect(screen.getByTestId('ra-row-error')).toHaveTextContent(
            /added a lot of games recently/i,
        ));
    });

    it("surfaces the server's own message for an unsupported console (422)", async () => {
        const fetchMock = vi.fn((_url: string, init?: RequestInit) => (
            init?.method === 'POST'
                ? ok({ error: 'RetroAchievements console 41 has no Arcaid engine yet.' }, 422)
                : ok(searchPayload())
        ));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="donkey" debounceMs={0} canImport />,
        );
        await waitFor(() => expect(screen.getByText('Donkey Kong')).toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: /Add to Arcaid/ }));

        await waitFor(() => expect(screen.getByTestId('ra-row-error')).toHaveTextContent(
            'RetroAchievements console 41 has no Arcaid engine yet.',
        ));
    });

    it('offers guests a login affordance instead of an import button', async () => {
        vi.stubGlobal('fetch', vi.fn(() => ok(searchPayload())) as unknown as typeof fetch);

        render(
            <RAGameSearch
                basePath="/global/ra-catalogue"
                authMode="player"
                playerToken={null}
                query="donkey"
                debounceMs={0}
                canImport={false}
                loginPrompt={<button type="button">Log in to add this game</button>}
            />,
        );

        await waitFor(() => expect(screen.getByText('Donkey Kong')).toBeInTheDocument());
        expect(screen.queryByRole('button', { name: /Add to Arcaid/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Log in to add this game' })).toBeInTheDocument();
    });

    it('says the index is building rather than "no results" on a cold table', async () => {
        vi.stubGlobal('fetch', vi.fn(() => ok(searchPayload({
            results: [],
            masterList: { total: 0, lastSyncedAt: null, stale: true, syncing: true },
        }))) as unknown as typeof fetch);

        render(
            <RAGameSearch basePath="/admin/ra-catalogue" authMode="admin" query="donkey" debounceMs={0} canImport showConfigHint />,
        );

        await waitFor(() => expect(screen.getByTestId('ra-building')).toBeInTheDocument());
    });

    it('tells an admin how to configure the key, and tells a player nothing at all', async () => {
        vi.stubGlobal('fetch', vi.fn(() => ok(searchPayload({ configured: false, results: [] }))) as unknown as typeof fetch);

        const admin = render(
            <RAGameSearch basePath="/admin/ra-catalogue" authMode="admin" query="donkey" debounceMs={0} canImport showConfigHint />,
        );
        await waitFor(() => expect(screen.getByText(/RA_API_KEY/)).toBeInTheDocument());
        admin.unmount();

        render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="donkey" debounceMs={0} canImport />,
        );
        await waitFor(() => expect(screen.queryByTestId('ra-search')).not.toBeInTheDocument());
    });

    it('shows the eligibility verdict to admins and hides it from players', async () => {
        const payload = searchPayload({
            results: [{
                raGameId: 9, title: 'Puzzle Thing', consoleId: 7, consoleName: 'NES/Famicom',
                iconUrl: null, numAchievements: 4, numLeaderboards: 1,
                inCatalogue: true, globalGameId: 'gg-9', scoreEligibility: 'novelty',
            }],
        });
        vi.stubGlobal('fetch', vi.fn(() => ok(payload)) as unknown as typeof fetch);

        const admin = render(
            <RAGameSearch basePath="/admin/ra-catalogue" authMode="admin" query="puzzle" debounceMs={0} canImport showEligibility showConfigHint />,
        );
        await waitFor(() => expect(screen.getByTestId('ra-eligibility-hint')).toHaveTextContent(
            /isn't high-score-based/,
        ));
        admin.unmount();

        render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="puzzle" debounceMs={0} canImport />,
        );
        await waitFor(() => expect(screen.getByText('Puzzle Thing')).toBeInTheDocument());
        expect(screen.queryByTestId('ra-eligibility-hint')).not.toBeInTheDocument();
    });

    it('does not search below the minimum query length', async () => {
        const fetchMock = vi.fn(() => ok(searchPayload()));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const { container } = render(
            <RAGameSearch basePath="/global/ra-catalogue" authMode="player" playerToken="p" query="d" debounceMs={0} canImport />,
        );

        expect(container).toBeEmptyDOMElement();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
