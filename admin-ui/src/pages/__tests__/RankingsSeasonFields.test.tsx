import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Rankings from '../Rankings';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * Season format (plan §8.4) — the Rankings admin page's season fields:
 * "Points for 1st" only for Countdown (best_game_linear), "Include archived
 * games", and a season-managed group showing its owner with best_n locked and
 * its scoring (points for 1st) editable like any other group (v2.161.1).
 * Mocks fetch (lib/api's transport), same convention as Reports.test.tsx.
 */

const baseGroup = {
    id: 'g1', name: 'Mox Season 3 — Season', description: '', rank_method: 'best_game_linear',
    best_n: 12, min_games: 1, is_active: true, tournament_ids: ['t1'],
    points_top: 50, include_archived: true, managed_by_season: { id: 't1', name: 'Mox Season 3' },
};

function mockFetch(groups: unknown[]) {
    const fn = vi.fn((url: string) => {
        const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        if (url.includes('/ranking-groups')) return json(groups);
        if (url.includes('/tournaments')) return json([{ id: 't1', name: 'Mox Season 3', type: 'weekly', is_active: 1 }]);
        if (url.includes('/settings')) return json({});
        return json({});
    });
    vi.stubGlobal('fetch', fn as unknown as typeof fetch);
    return fn;
}

function renderPage() {
    return render(
        <MemoryRouter>
            <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'mox', roomName: 'Mox' }}>
                <Rankings />
            </RoomContext.Provider>
        </MemoryRouter>,
    );
}

describe('Rankings — season fields', () => {
    beforeEach(() => { localStorage.clear(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows Points for 1st only for Countdown, plus the archived checkbox', async () => {
        mockFetch([]);
        renderPage();
        fireEvent.click(await screen.findByText('+ New Ranking Group'));
        expect(screen.queryByLabelText('Points for 1st')).toBeNull();
        expect(screen.getByText('Include archived games')).toBeTruthy();

        const method = screen.getByDisplayValue('Best Game (PAPA)');
        fireEvent.change(method, { target: { value: 'best_game_linear' } });
        const points = screen.getByLabelText('Points for 1st') as HTMLInputElement;
        expect(points.value).toBe('100');
        expect(points.disabled).toBe(false);
        expect((screen.getByLabelText('Best N Games') as HTMLInputElement).max).toBe('200');
        expect(screen.getByText(/1st = the group's top value/)).toBeTruthy();
        expect(screen.getByRole('option', { name: 'Countdown' })).toBeTruthy();

        fireEvent.change(method, { target: { value: 'max_10' } });
        expect(screen.queryByLabelText('Points for 1st')).toBeNull();
    });

    it('a season-managed group names its season, locks best_n and lets points be edited', async () => {
        const fn = mockFetch([baseGroup]);
        renderPage();
        fireEvent.click(await screen.findByText('Edit'));
        expect(screen.getByTestId('ranking-managed-by').textContent).toContain('Managed by Mox Season 3');
        expect(screen.getByTestId('ranking-managed-by').textContent).toContain("follows the season's table count");
        const points = screen.getByLabelText('Points for 1st') as HTMLInputElement;
        const bestN = screen.getByLabelText('Best N Games') as HTMLInputElement;
        expect(points.value).toBe('50');
        expect(points.disabled).toBe(false);
        expect(bestN.value).toBe('12');
        expect(bestN.disabled).toBe(true);

        fireEvent.change(points, { target: { value: '30' } });
        fireEvent.click(screen.getByText('Update'));
        await waitFor(() => {
            const put = fn.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PUT');
            expect(put).toBeTruthy();
            const body = JSON.parse(String((put![1] as RequestInit).body));
            // The group's scoring is its own — points_top is sent even when managed.
            expect(body.points_top).toBe(30);
            expect(body.include_archived).toBe(true);
        });
    });
});
