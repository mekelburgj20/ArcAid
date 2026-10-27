import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import WitnessRecentPlays, { type RecentPlay } from '../WitnessRecentPlays';

/**
 * W27.2 (ADR 0033 §5) — "Where your plays went". Pins what a player must be
 * able to read off one row: where the play counted (linked to that board), the
 * Global Scoreboard, and — the point of the item — WHY it did not count.
 */

const PLAYS: RecentPlay[] = [
    {
        key: 'a', playedAt: '2026-10-27 01:22:02', tableName: "America's Most Haunted (Spooky Pinball 2014)",
        score: 39293680, deviceId: 'dev',
        destinations: [{
            status: 'counted', tournamentName: 'Spooky Season', roundNo: null, roomName: 'The Wizard Room',
            roomSlug: 'the_wizard_room', gameName: "America's Most Haunted", globalGameId: null, reason: null,
        }],
    },
    {
        key: 'b', playedAt: '2026-10-27 00:49:04', tableName: 'Medieval Madness (Williams 1997)',
        score: 41234560, deviceId: 'dev',
        destinations: [{
            status: 'global', tournamentName: null, roundNo: null, roomName: null, roomSlug: null, gameName: null,
            globalGameId: 'gg-mm', reason: 'you are not checked in to "Friday Night" round 1 in The Wizard Room',
        }],
    },
    {
        key: 'c', playedAt: '2026-10-26 22:10:00', tableName: 'Some Homebrew (Original 2026)', score: 5, deviceId: 'dev',
        destinations: [{
            status: 'not_recorded', tournamentName: null, roundNo: null, roomName: null, roomSlug: null, gameName: null,
            globalGameId: null, reason: '"Some Homebrew (Original 2026)" is not in the Arcaid catalogue',
        }],
    },
];

function stub(body: unknown, ok = true) {
    const fetchMock = vi.fn(() => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('WitnessRecentPlays', () => {
    it('shows where each play counted, links the board, and says why a miss missed', async () => {
        const fetchMock = stub(PLAYS);
        render(<MemoryRouter><WitnessRecentPlays playerToken="tok" /></MemoryRouter>);

        const counted = await screen.findByRole('link', { name: /Counted · Spooky Season · The Wizard Room/ });
        expect(counted.getAttribute('href')).toBe(`/the_wizard_room/games/${encodeURIComponent("America's Most Haunted")}`);

        const global = screen.getByRole('link', { name: /Global Scoreboard/ });
        expect(global.getAttribute('href')).toBe('/games/gg-mm');
        expect(screen.getByText(`Didn't count in a tournament: you are not checked in to "Friday Night" round 1 in The Wizard Room`)).toBeTruthy();

        expect(screen.getByText('Not recorded')).toBeTruthy();
        expect(screen.getByText('"Some Homebrew (Original 2026)" is not in the Arcaid catalogue')).toBeTruthy();

        expect(screen.getByText('39,293,680')).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledWith('/api/me/witness/plays?limit=30', { headers: { Authorization: 'Bearer tok' } });
    });

    it('says so when there is nothing yet, and when the list cannot be read', async () => {
        stub([]);
        const { unmount } = render(<MemoryRouter><WitnessRecentPlays playerToken="tok" /></MemoryRouter>);
        await screen.findByText(/No plays reported yet/);
        unmount();

        stub({ error: 'nope' }, false);
        render(<MemoryRouter><WitnessRecentPlays playerToken="tok" /></MemoryRouter>);
        await waitFor(() => expect(screen.getByText(/Couldn't load your plays/)).toBeTruthy());
    });
});
