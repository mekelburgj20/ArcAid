import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { LOAD_MORE_LABEL, ROOM_SCORES_SEARCH_PLACEHOLDER } from '../../lib/scoresCopy';
import RoomScoresView from '../RoomScoresView';

/**
 * G32 — the Room Scores tab of the room Scoreboard. Before this a refused or
 * failed first page read "No scores here yet", a failed reload after a score
 * post wiped the cards on screen, a failed Load more left its spinner on
 * forever and hid the button, and nothing asked again until a manual refresh.
 *
 * The real ScoreCardGrid is rendered (legacy cards, `config={}`); only the
 * submission sheet is stood in for, as a button that reports a posted score.
 */

vi.mock('../SubmissionSheet', () => ({
  default: (props: { onSubmitted?: () => void }) => (
    <button type="button" onClick={() => props.onSubmitted?.()}>Posted</button>
  ),
}));

function row(gameId: string, gameName: string) {
  return {
    gameId, gameName, displayName: null, tournamentName: '', tournamentType: 'room', imageUrl: null,
    gameStatus: 'COMPLETED', catalogueStyleId: null, logoStyleId: null, bgStyleId: null,
    styleHeaderDisabled: false, notes: null, rankings: [],
    globalGameId: null, lastPlayed: '2026-01-01T00:00:00Z', playerCount: 1, totalScores: 1,
  };
}

type Page = { data: unknown[]; total: number; hasMore: boolean };

const okResponse = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const ok = (body: unknown) => Promise.resolve(okResponse(body));
const refused = (status = 429) => Promise.resolve({
  ok: false,
  status,
  headers: { get: () => null },
  json: () => Promise.resolve({ error: 'Too many requests. Please try again later.' }),
});

/** `limited` = every room-scores request is refused (429); `offline` = it throws. */
let limited = false;
let offline = false;
let refuseWith: number | null = null;
let firstPage: Page;
let nextPage: Page;
let searchPage: Page;
/** When set, the next Load more request waits until `releaseMore()` is called. */
let holdMore = false;
let releaseMore: (() => void) | null = null;
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (!url.includes('/room-scores')) return ok({});
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
    if (refuseWith != null) return refused(refuseWith);
    if (limited) return refused();
    const params = new URL(url, 'http://localhost').searchParams;
    if (params.get('search')) return ok(searchPage);
    if (Number(params.get('offset')) === 0) return ok(firstPage);
    if (holdMore) {
      holdMore = false;
      return new Promise(resolve => { releaseMore = () => resolve(okResponse(nextPage)); });
    }
    return ok(nextPage);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

function viewer(playerToken: string | null) {
  return {
    token: null, discordUser: null, playerToken,
    loginWithDiscord: () => {}, loginWithGoogle: () => {}, logoutPlayer: () => {}, setViewerAvatar: () => {},
  };
}

function view(playerToken: string | null = null) {
  return (
    <MemoryRouter>
      <ViewerAuthContext.Provider value={viewer(playerToken)}>
        <RoomScoresView roomId="room-1" slug="rtx" config={{}} roomName="rtx_pinball" />
      </ViewerAuthContext.Provider>
    </MemoryRouter>
  );
}

const scoreCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/room-scores'));
/** Let resolved fetches and their state updates land, without moving the clock. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const card = (name: string) => screen.queryByRole('button', { name: `Submit score for ${name}` });

describe('Room Scores when its loads fail for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    limited = false;
    offline = false;
    refuseWith = null;
    holdMore = false;
    releaseMore = null;
    firstPage = { data: [row('g-1', 'Monster Bash')], total: 1, hasMore: false };
    nextPage = { data: [row('g-2', 'Attack from Mars')], total: 2, hasMore: false };
    searchPage = { data: [row('g-3', 'Medieval Madness')], total: 1, hasMore: false };
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('before the first answer it shows neither the empty text nor the failure', async () => {
    render(view());
    expect(screen.queryByText('No scores here yet')).not.toBeInTheDocument();
    expect(screen.queryByTestId('room-scores-load-failed')).not.toBeInTheDocument();
    await settle();
    expect(card('Monster Bash')).toBeInTheDocument();
  });

  it('says the load failed, not that the room has no scores, and keeps the controls', async () => {
    limited = true;
    render(view());
    await settle();

    expect(screen.getByTestId('room-scores-load-failed')).toHaveTextContent("Couldn't load the scores");
    expect(screen.getByTestId('room-scores-load-failed')).toHaveTextContent('Trying again automatically.');
    expect(screen.queryByText('No scores here yet')).not.toBeInTheDocument();
    // The search box and the sort chips stay usable.
    expect(screen.getByLabelText(ROOM_SCORES_SEARCH_PLACEHOLDER)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
  });

  it('asks again by itself and draws the cards when the requests are let through', async () => {
    limited = true;
    render(view());
    await settle();
    expect(scoreCalls()).toHaveLength(1);

    // Still refused on the first retry (1 s): the message stays.
    await advance(1_000);
    expect(scoreCalls()).toHaveLength(2);
    expect(screen.getByTestId('room-scores-load-failed')).toBeInTheDocument();

    // Let through before the second retry (2 s later).
    limited = false;
    await advance(2_000);
    expect(scoreCalls()).toHaveLength(3);
    expect(screen.queryByTestId('room-scores-load-failed')).not.toBeInTheDocument();
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(screen.getByText('1 game')).toBeInTheDocument();
  });

  it('asks again after a dropped connection too', async () => {
    offline = true;
    render(view());
    await settle();
    expect(screen.getByTestId('room-scores-load-failed')).toBeInTheDocument();

    offline = false;
    await advance(1_000);
    expect(card('Monster Bash')).toBeInTheDocument();
  });

  it('"Try now" asks at once, without waiting for the next try', async () => {
    limited = true;
    render(view());
    await settle();
    limited = false;

    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(scoreCalls()).toHaveLength(2);
  });

  it('a room with no scores still reads "No scores here yet" and schedules nothing', async () => {
    firstPage = { data: [], total: 0, hasMore: false };
    render(view());
    await settle();
    expect(screen.getByText('No scores here yet')).toBeInTheDocument();
    expect(screen.queryByTestId('room-scores-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(scoreCalls()).toHaveLength(1);
  });

  it('a definite refusal is an answer: the empty text, no retry', async () => {
    refuseWith = 403;
    render(view());
    await settle();
    expect(screen.getByText('No scores here yet')).toBeInTheDocument();
    expect(screen.queryByTestId('room-scores-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(scoreCalls()).toHaveLength(1);
  });

  it('a failed reload after a score post keeps the cards and retries quietly', async () => {
    render(view());
    await settle();
    expect(card('Monster Bash')).toBeInTheDocument();

    fireEvent.click(card('Monster Bash')!);
    limited = true;
    fireEvent.click(screen.getByRole('button', { name: 'Posted' }));
    await settle();
    expect(scoreCalls()).toHaveLength(2);
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(screen.queryByTestId('room-scores-load-failed')).not.toBeInTheDocument();

    // It tries again by itself and the new list replaces the old one.
    limited = false;
    firstPage = { data: [row('g-1', 'Monster Bash'), row('g-2', 'Attack from Mars')], total: 2, hasMore: false };
    await advance(1_000);
    expect(scoreCalls()).toHaveLength(3);
    expect(card('Attack from Mars')).toBeInTheDocument();
    expect(card('Monster Bash')).toBeInTheDocument();
  });

  it('a failed Load more stops its spinner, keeps the cards and the button, and asks from the same place again', async () => {
    firstPage = { data: [row('g-1', 'Monster Bash')], total: 2, hasMore: true };
    render(view());
    await settle();

    limited = true;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    expect(screen.getByRole('button', { name: LOAD_MORE_LABEL })).toBeEnabled();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(card('Monster Bash')).toBeInTheDocument();
    // No automatic retry for Load more.
    await advance(45_000);
    expect(scoreCalls()).toHaveLength(2);

    // A dropped connection: the same.
    limited = false;
    offline = true;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    expect(screen.getByRole('button', { name: LOAD_MORE_LABEL })).toBeEnabled();
    expect(card('Monster Bash')).toBeInTheDocument();

    // Pressed again once requests get through: the next page, from offset 48.
    offline = false;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    const last = String(scoreCalls().at(-1)![0]);
    expect(new URL(last, 'http://localhost').searchParams.get('offset')).toBe('48');
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(card('Attack from Mars')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: LOAD_MORE_LABEL })).not.toBeInTheDocument();
  });

  it('a Load more answer that lands after the search changed is not added to the new list', async () => {
    firstPage = { data: [row('g-1', 'Monster Bash')], total: 2, hasMore: true };
    render(view());
    await settle();

    holdMore = true;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    expect(screen.getByRole('button', { name: 'Loading...' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText(ROOM_SCORES_SEARCH_PLACEHOLDER), { target: { value: 'medi' } });
    await advance(300);
    await settle();
    expect(card('Medieval Madness')).toBeInTheDocument();

    releaseMore!();
    await settle();
    expect(card('Medieval Madness')).toBeInTheDocument();
    expect(card('Attack from Mars')).not.toBeInTheDocument();
    expect(card('Monster Bash')).not.toBeInTheDocument();
  });

  it("sends the player's token, and a new token reloads the first page", async () => {
    const { rerender } = render(view('tok-a'));
    await settle();
    expect(scoreCalls()).toHaveLength(1);
    expect(scoreCalls()[0][1]).toEqual({ headers: { Authorization: 'Bearer tok-a' } });

    rerender(view('tok-b'));
    await settle();
    expect(scoreCalls()).toHaveLength(2);
    expect(scoreCalls()[1][1]).toEqual({ headers: { Authorization: 'Bearer tok-b' } });
    expect(card('Monster Bash')).toBeInTheDocument();

    // A render with the same token asks nothing (no fetch loop).
    rerender(view('tok-b'));
    await advance(45_000);
    expect(scoreCalls()).toHaveLength(2);
  });
});
