import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SeasonPollCards from '../SeasonPollCard';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { applyVote, closesInLabel, type SeasonOpenPoll } from '../../lib/seasonPoll';

/**
 * Season format — the public table poll card (plan §8.3). The server owns the
 * tally; this pins that the card renders it, posts `{position}` to the right
 * path, withdraws with DELETE, and renders nothing without an open poll.
 */

function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signIn() {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${b64url({ alg: 'none' })}.${b64url({ discordId: '111', username: 'Tester', avatar: null, exp })}.sig`;
    localStorage.setItem('arcaid_player_token', token);
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId: '111', username: 'Tester', avatar: null }));
}

function poll(over: Partial<SeasonOpenPoll> = {}): SeasonOpenPoll {
    return {
        id: 'poll-1', slot_no: 6, question: 'Week 6 table poll',
        opens_at: '2026-10-12T04:00:00.000Z',
        // +30 s so the minute floor is stable however long the render takes.
        closes_at: new Date(Date.now() + (2 * 60 + 5) * 60000 + 30000).toISOString(),
        posted_at: '2026-10-12T04:00:00.000Z',
        discord_url: 'https://discord.com/channels/1/2/3',
        candidates: [
            { position: 1, game_name: 'Attack from Mars (Bally 1995)', global_game_id: 'g1', votes: 7 },
            { position: 2, game_name: 'Medieval Madness', global_game_id: 'g2', votes: 3 },
        ],
        total_votes: 10,
        my_vote: null,
        ...over,
    };
}

function mockFetch(opts: { open?: boolean; myVote?: number | null; voteStatus?: number } = {}) {
    const { open = true, myVote = null, voteStatus = 200 } = opts;
    const fn = vi.fn((url: string, init?: RequestInit) => {
        const json = (body: unknown, status = 200) =>
            Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
        if (url.endsWith('/vote')) {
            if (voteStatus >= 400) return json({ error: 'Poll is not open', code: 'POLL_NOT_OPEN' }, voteStatus);
            return json({ success: true, my_vote: init?.method === 'DELETE' ? null : JSON.parse(String(init?.body)).position });
        }
        if (url.endsWith('/season')) {
            return json({ tournament_id: 't1', name: 'Mox Season 3', open_poll: open ? poll({ my_vote: myVote }) : null });
        }
        if (url.endsWith('/tournaments')) {
            return json([
                { id: 't1', name: 'Mox Season 3', season: { tables_done: 5, table_count: 12, paused: false, finished: false, open_poll_id: open ? 'poll-1' : null } },
                { id: 't2', name: 'Daily Grind' },
            ]);
        }
        return json([]);
    });
    vi.stubGlobal('fetch', fn as unknown as typeof fetch);
    return fn;
}

function renderCards() {
    return render(
        <MemoryRouter initialEntries={['/mox/']}>
            <ViewerAuthProvider>
                <SeasonPollCards roomId="room-1" roomSlug="mox" />
            </ViewerAuthProvider>
        </MemoryRouter>,
    );
}

describe('SeasonPollCards', () => {
    beforeEach(() => { localStorage.clear(); });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders the question, candidates, tally, countdown and Discord link', async () => {
        mockFetch();
        renderCards();
        expect(await screen.findByText('Week 6 table poll')).toBeTruthy();
        expect(screen.getByText('Mox Season 3')).toBeTruthy();
        expect(screen.getByText('Attack from Mars (Bally 1995)')).toBeTruthy();
        expect(screen.getByText('Medieval Madness')).toBeTruthy();
        expect(screen.getByText('10 votes')).toBeTruthy();
        expect(screen.getByText('Closes in 2 hr 5 min')).toBeTruthy();
        const link = screen.getByRole('link', { name: /Vote on Discord instead/ });
        expect(link.getAttribute('href')).toBe('https://discord.com/channels/1/2/3');
        // Bar width is proportional to the share of the vote.
        expect((screen.getByTestId('season-poll-bar-1') as HTMLElement).style.width).toBe('70%');
    });

    it('only fetches the season summary for tournaments with an open poll', async () => {
        const fn = mockFetch();
        renderCards();
        await screen.findByText('Week 6 table poll');
        const urls = fn.mock.calls.map(c => c[0] as string);
        expect(urls).toContain('/api/rooms/room-1/tournaments/t1/season');
        expect(urls.some(u => u.includes('/t2/season'))).toBe(false);
    });

    it('renders nothing when there is no open poll', async () => {
        const fn = mockFetch({ open: false });
        const { container } = renderCards();
        await waitFor(() => expect(fn).toHaveBeenCalled());
        await new Promise(r => setTimeout(r, 0));
        expect(container.innerHTML).toBe('');
    });

    it('a vote POSTs {position} to the poll path with the player token, optimistically', async () => {
        signIn();
        const fn = mockFetch();
        renderCards();
        fireEvent.click(await screen.findByRole('button', { name: /Medieval Madness/ }));
        // Optimistic tally moves before the server answers.
        expect(screen.getByText('11 votes')).toBeTruthy();
        await waitFor(() => {
            const call = fn.mock.calls.find(c => (c[0] as string).endsWith('/vote'));
            expect(call).toBeTruthy();
            expect(call![0]).toBe('/api/rooms/room-1/season-polls/poll-1/vote');
            const init = call![1] as RequestInit;
            expect(init.method).toBe('POST');
            expect(JSON.parse(String(init.body))).toEqual({ position: 2 });
            expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
        });
        expect(screen.getByRole('button', { name: /Medieval Madness/ }).getAttribute('aria-pressed')).toBe('true');
    });

    it('tapping the chosen row withdraws with DELETE', async () => {
        signIn();
        const fn = mockFetch({ myVote: 1 });
        renderCards();
        const mine = await screen.findByRole('button', { name: /Attack from Mars/ });
        expect(mine.getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(mine);
        await waitFor(() => {
            const call = fn.mock.calls.find(c => (c[0] as string).endsWith('/vote'));
            expect(call).toBeTruthy();
            expect((call![1] as RequestInit).method).toBe('DELETE');
        });
        expect(screen.getByText('9 votes')).toBeTruthy();
    });

    it('rolls back and explains when the poll has closed', async () => {
        signIn();
        mockFetch({ voteStatus: 409 });
        renderCards();
        fireEvent.click(await screen.findByRole('button', { name: /Medieval Madness/ }));
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toBe('This poll has closed.');
        expect(screen.getByText('10 votes')).toBeTruthy();
    });

    it('a logged-out tap shows the login buttons and sends nothing', async () => {
        const fn = mockFetch();
        renderCards();
        fireEvent.click(await screen.findByRole('button', { name: /Medieval Madness/ }));
        expect(screen.getByText(/Log in to vote/)).toBeTruthy();
        expect(fn.mock.calls.some(c => (c[0] as string).endsWith('/vote'))).toBe(false);
    });
});

describe('seasonPoll helpers', () => {
    it('applyVote moves, adds and withdraws a vote', () => {
        const p = poll({ my_vote: 1 });
        const moved = applyVote(p, 2);
        expect(moved.candidates.map(c => c.votes)).toEqual([6, 4]);
        expect(moved.total_votes).toBe(10);
        const withdrawn = applyVote(p, null);
        expect(withdrawn.total_votes).toBe(9);
        expect(withdrawn.my_vote).toBeNull();
        expect(applyVote(poll(), 1).total_votes).toBe(11);
    });

    it('closesInLabel formats days, hours and minutes', () => {
        const now = Date.parse('2026-10-15T00:00:00.000Z');
        expect(closesInLabel('2026-10-17T03:00:00.000Z', now)).toBe('Closes in 2 days 3 hr');
        expect(closesInLabel('2026-10-15T00:30:00.000Z', now)).toBe('Closes in 30 min');
        expect(closesInLabel('2026-10-14T00:00:00.000Z', now)).toBe('Closing now');
        expect(closesInLabel(null, now)).toBeNull();
    });
});
