import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { PRACTICE_ON_TEXT, type PracticeState } from '../../lib/attemptStarts';

/**
 * W126 (ADR 0043) — Practice mode on the public game page of a
 * Limited-attempts tournament: the banner says whether the host allows it and
 * for how many games; a signed-in player gets "Pause to practice", and while
 * paused an amber box saying plays do not count with "Resume attempts".
 */

const BOARD = {
  gameId: 'g-mb', gameName: 'Monster Bash', tournamentName: 'Five Shots', tournamentId: 't-1',
  imageUrl: null, gameStatus: 'ACTIVE', globalGameId: null,
  rankings: [
    { rank: 1, discord_user_id: 'disc-bee', iscored_username: 'Bee', score: 700, history_id: 103, source: 'vpx', submitted_by_user_id: 'disc-bee' },
  ],
};

const practice = (over: Partial<PracticeState> = {}): PracticeState => ({
  offered: true, limit: 3, used: 0, left: 3, paused: false, pausedTs: null, ...over,
});

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIn(discordId = 'disc-bee') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Bee', avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Bee', avatar: null }));
}

function stubFetch(opts: {
  practiceGames: number | null; mine?: PracticeState; requireAttemptStart?: boolean; starts?: Record<string, number>;
  used?: number; post?: { ok: boolean; body: unknown };
}) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && /attempt-(pause|resume)$/.test(url)) {
      const post = opts.post ?? { ok: true, body: { practice: practice({ paused: true, pausedTs: 1_800_000_000 }) } };
      return Promise.resolve({ ok: post.ok, json: () => Promise.resolve(post.body) });
    }
    if (url.includes('/attempt-starts/me')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        starts: opts.starts ?? {}, practice: opts.mine ? { 'g-mb': opts.mine } : {},
      }) });
    }
    if (url.includes('/integrity')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        mode: 'open', verdicts: {}, quits: {}, signed: {}, maxAttempts: 5,
        attempts: { 'g-mb': { 'disc-bee': opts.used ?? 1 } }, attemptPlayers: { 'disc-bee': 'Bee' },
        requireAttemptStart: opts.requireAttemptStart === true, practiceGames: opts.practiceGames,
      }) });
    }
    if (/\/leaderboard\/g-mb(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...BOARD, distinctEngines: [] }) });
    }
    if (url.endsWith('/leaderboard')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([BOARD]) });
    }
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ bee: 1 }) });
    }
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        gameName: 'Monster Bash', timesPlayed: 1, avgScore: 700, uniquePlayers: 1,
        allTimeHigh: 700, allTimeHighPlayer: 'Bee', recentResults: [],
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/fff/games/Monster%20Bash']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'fff', roomName: 'FFF' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GameDetail — practice mode (W126)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('says nothing about practice when the host has not turned it on', async () => {
    signIn();
    stubFetch({ practiceGames: null });
    renderPage();
    await screen.findByTestId('attempts-banner');
    expect(screen.queryByTestId('practice-box')).not.toBeInTheDocument();
  });

  it('a guest reads the rule and is told to log in; no button', async () => {
    stubFetch({ practiceGames: 3 });
    renderPage();
    const box = await screen.findByTestId('practice-box');
    expect(box).toHaveTextContent('for up to 3 games');
    expect(box).toHaveTextContent('a game already running still counts');
    expect(box).toHaveTextContent('Log in to pause');
    expect(within(box).queryByRole('button')).toBeNull();
  });

  it('unlimited (0) reads "as much as you like"', async () => {
    stubFetch({ practiceGames: 0 });
    renderPage();
    expect(await screen.findByTestId('practice-box')).toHaveTextContent('as much as you like');
  });

  it('a signed-in player pauses: the POST goes to attempt-pause and the box turns amber with Resume', async () => {
    signIn();
    const fetchMock = stubFetch({ practiceGames: 3, mine: practice() });
    renderPage();
    const pause = await screen.findByTestId('pause-attempts');
    expect(screen.getByTestId('practice-box')).toHaveTextContent('3 practice games left');
    fireEvent.click(pause);

    const on = await screen.findByTestId('practice-on');
    expect(on).toHaveTextContent(PRACTICE_ON_TEXT);
    expect(within(on).getByTestId('resume-attempts')).toBeInTheDocument();
    expect(screen.queryByTestId('pause-attempts')).not.toBeInTheDocument();
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) =>
      String(u) === '/api/rooms/room-1/tournaments/t-1/games/g-mb/attempt-pause' && (i as RequestInit | undefined)?.method === 'POST',
    )).toBe(true));
  });

  it('a paused player resumes: the POST goes to attempt-resume and Pause is offered again', async () => {
    signIn();
    const fetchMock = stubFetch({
      practiceGames: 3, mine: practice({ used: 1, left: 2, paused: true, pausedTs: 1_800_000_000 }),
      post: { ok: true, body: { resumed: true, practice: practice({ used: 1, left: 2 }) } },
    });
    renderPage();
    expect(await screen.findByTestId('practice-on')).toHaveTextContent('2 practice games left');
    fireEvent.click(screen.getByTestId('resume-attempts'));

    expect(await screen.findByTestId('pause-attempts')).toBeInTheDocument();
    expect(screen.queryByTestId('practice-on')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/games/g-mb/attempt-resume'))).toBe(true);
  });

  it('no Pause with no attempts left, and "used all" once the practice games are gone', async () => {
    signIn();
    stubFetch({ practiceGames: 3, mine: practice(), used: 5 });
    const first = renderPage();
    await screen.findByTestId('practice-box');
    await screen.findAllByTestId('attempts-used');
    expect(screen.queryByTestId('pause-attempts')).not.toBeInTheDocument();
    first.unmount();

    stubFetch({ practiceGames: 3, mine: practice({ used: 3, left: 0 }) });
    renderPage();
    expect(await screen.findByTestId('practice-used-up')).toHaveTextContent('Every game you start now counts');
    expect(screen.queryByTestId('pause-attempts')).not.toBeInTheDocument();
  });

  it('with Start attempts required, Pause waits for the press', async () => {
    signIn();
    stubFetch({ practiceGames: 0, mine: practice({ limit: 0, left: null }), requireAttemptStart: true });
    const first = renderPage();
    await screen.findByTestId('start-attempts');
    expect(screen.queryByTestId('pause-attempts')).not.toBeInTheDocument();
    first.unmount();

    stubFetch({ practiceGames: 0, mine: practice({ limit: 0, left: null }), requireAttemptStart: true, starts: { 'g-mb': 1_700_000_000 } });
    renderPage();
    expect(await screen.findByTestId('pause-attempts')).toBeInTheDocument();
    expect(screen.getByTestId('practice-box')).toHaveTextContent('Unlimited practice games');
  });

  it('a refused pause shows the server\'s sentence and changes nothing', async () => {
    signIn();
    stubFetch({ practiceGames: 3, mine: practice(), post: { ok: false, body: { error: 'This table is closed', code: 'NOT_OPEN' } } });
    renderPage();
    fireEvent.click(await screen.findByTestId('pause-attempts'));
    expect(await screen.findByText('This table is closed')).toBeInTheDocument();
    expect(screen.queryByTestId('practice-on')).not.toBeInTheDocument();
  });
});
