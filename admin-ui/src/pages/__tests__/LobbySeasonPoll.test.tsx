import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Lobby from '../Lobby';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * Season format — the table poll card lives on the Lobby (owner ruling
 * 2026-10-18). `season:poll` is emitted to `room:<id>`, which the Lobby did not
 * join before, so this pins the mount, the `join:room` emit, and that a
 * `season:poll` event refetches the poll.
 */

const emitted: unknown[][] = [];
const socketHandlers: Record<string, ((data?: unknown) => void)[]> = {};
vi.mock('../../lib/websocket', () => ({
    getSocket: () => ({
        emit: (...args: unknown[]) => { emitted.push(args); },
        on: (event: string, fn: (data?: unknown) => void) => { (socketHandlers[event] ||= []).push(fn); },
        off: (event: string, fn: (data?: unknown) => void) => {
            socketHandlers[event] = (socketHandlers[event] || []).filter(h => h !== fn);
        },
    }),
}));

function stubFetch(open = true) {
    const fn = vi.fn((url: string) => {
        const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
        if (url.includes('/lobby/config')) return json({ socialLinks: [], pinnedMessage: null });
        if (url.includes('/lobby/')) return json([]);
        if (url.endsWith('/tournaments')) {
            return json([{ id: 't1', name: 'Mox Season 3', season: { open_poll_id: open ? 'poll-1' : null } }]);
        }
        if (url.endsWith('/t1/season')) {
            return json({
                tournament_id: 't1', name: 'Mox Season 3', progress: { tables_done: 5, table_count: 12 },
                open_poll: {
                    id: 'poll-1', slot_no: 6, question: 'Week 6 table poll',
                    opens_at: null, closes_at: null, posted_at: null, discord_url: null,
                    candidates: [{ position: 1, game_name: 'Medieval Madness', global_game_id: 'g2', votes: 3 }],
                    total_votes: 3, my_vote: null,
                },
            });
        }
        return json([]);
    });
    vi.stubGlobal('fetch', fn as unknown as typeof fetch);
    return fn;
}

function renderLobby() {
    return render(
        <MemoryRouter initialEntries={['/mox/lobby']}>
            <ViewerAuthProvider>
                <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'mox', roomName: 'Mox' }}>
                    <Routes>
                        <Route path="/:slug/lobby" element={<Lobby />} />
                    </Routes>
                </RoomContext.Provider>
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
}

describe('Lobby — season poll card', () => {
    beforeEach(() => {
        localStorage.clear();
        emitted.length = 0;
        for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders the open poll card and joins room:<id> for season:poll', async () => {
        stubFetch();
        renderLobby();
        expect(await screen.findByText('Week 6 table poll')).toBeTruthy();
        expect(screen.getByRole('button', { name: /Medieval Madness/ })).toBeTruthy();
        expect(emitted).toContainEqual(['join:room', 'room-1']);
        // The existing lobby feed subscription is untouched.
        expect(emitted).toContainEqual(['join:lobby', 'room-1']);
        expect(socketHandlers['season:poll']?.length).toBe(1);
    });

    it('a season:poll event refetches the poll', async () => {
        const fn = stubFetch();
        renderLobby();
        await screen.findByText('Week 6 table poll');
        const before = fn.mock.calls.filter(c => (c[0] as string).endsWith('/tournaments')).length;
        act(() => { socketHandlers['season:poll'].forEach(h => h({ tournamentId: 't1', pollId: 'poll-1' })); });
        await waitFor(() => {
            const after = fn.mock.calls.filter(c => (c[0] as string).endsWith('/tournaments')).length;
            expect(after).toBeGreaterThan(before);
        });
    });

    it('renders no poll card when there is no open poll', async () => {
        const fn = stubFetch(false);
        renderLobby();
        await waitFor(() => expect(fn.mock.calls.some(c => (c[0] as string).endsWith('/tournaments'))).toBe(true));
        await new Promise(r => setTimeout(r, 0));
        expect(screen.queryByRole('region', { name: /table poll/ })).toBeNull();
    });

    it('leaves room:<id> and drops its handler on unmount', async () => {
        stubFetch();
        const { unmount } = renderLobby();
        await screen.findByText('Week 6 table poll');
        unmount();
        expect(emitted).toContainEqual(['leave:room', 'room-1']);
        expect(socketHandlers['season:poll']?.length ?? 0).toBe(0);
    });
});
