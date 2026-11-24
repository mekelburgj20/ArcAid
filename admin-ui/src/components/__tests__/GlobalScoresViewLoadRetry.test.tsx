import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { GLOBAL_SEARCH_PLACEHOLDER, LOAD_MORE_LABEL } from '../../lib/scoresCopy';
import GlobalScoresView from '../GlobalScoresView';

/**
 * G32 — the Global tab of the room Scoreboard. Before this a refused or failed
 * first page read "No global scores yet", a failed reload after a score post
 * wiped the cards on screen, a failed Load more left its spinner on forever
 * and hid the button, and nothing asked again until a manual refresh.
 *
 * The real ScoreCardGrid is rendered (legacy cards, `config={}`); only the
 * submission sheet is stood in for, as a button that reports a posted score.
 */

vi.mock('../SubmissionSheet', () => ({
  default: (props: { onSubmitted?: () => void }) => (
    <button type="button" onClick={() => props.onSubmitted?.()}>Posted</button>
  ),
}));

function game(id: string, name: string) {
  return {
    global_game_id: id, name, display_name: null, image_url: null, local_image_path: null,
    wheel_image_path: null, top_scores: [],
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

/** `limited` = every Global Scoreboard request is refused (429); `offline` = it throws. */
let limited = false;
let offline = false;
let firstPage: Page;
let nextPage: Page;
let searchPage: Page;
/** When set, the next Load more request waits until `releaseMore()` is called. */
let holdMore = false;
let releaseMore: (() => void) | null = null;
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (!url.startsWith('/api/global/scoreboard')) return ok({});
    if (offline) return Promise.reject(new TypeError('Failed to fetch'));
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

function renderView() {
  return render(
    <MemoryRouter>
      <GlobalScoresView roomId="room-1" slug="rtx" config={{}} roomName="rtx_pinball" />
    </MemoryRouter>,
  );
}

const boardCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/global/scoreboard'));
/** Let resolved fetches and their state updates land, without moving the clock. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const card = (name: string) => screen.queryByRole('button', { name: `Submit score for ${name}` });

describe('the Global tab when its loads fail for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    limited = false;
    offline = false;
    holdMore = false;
    releaseMore = null;
    firstPage = { data: [game('gg-1', 'Monster Bash')], total: 1, hasMore: false };
    nextPage = { data: [game('gg-2', 'Attack from Mars')], total: 2, hasMore: false };
    searchPage = { data: [game('gg-3', 'Medieval Madness')], total: 1, hasMore: false };
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says the load failed, not that there are no global scores, and keeps the controls', async () => {
    limited = true;
    renderView();
    await settle();

    expect(screen.getByTestId('global-scores-load-failed')).toHaveTextContent("Couldn't load the scores");
    expect(screen.getByTestId('global-scores-load-failed')).toHaveTextContent('Trying again automatically.');
    expect(screen.queryByText('No global scores yet')).not.toBeInTheDocument();
    expect(screen.getByLabelText(GLOBAL_SEARCH_PLACEHOLDER)).toBeInTheDocument();
  });

  it('asks again by itself and draws the cards when the requests are let through', async () => {
    limited = true;
    renderView();
    await settle();
    expect(boardCalls()).toHaveLength(1);

    await advance(1_000);
    expect(boardCalls()).toHaveLength(2);
    expect(screen.getByTestId('global-scores-load-failed')).toBeInTheDocument();

    limited = false;
    await advance(2_000);
    expect(boardCalls()).toHaveLength(3);
    expect(screen.queryByTestId('global-scores-load-failed')).not.toBeInTheDocument();
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 1 games with global scores')).toBeInTheDocument();
  });

  it('"Try now" asks at once, without waiting for the next try', async () => {
    offline = true;
    renderView();
    await settle();
    expect(screen.getByTestId('global-scores-load-failed')).toBeInTheDocument();
    offline = false;

    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(boardCalls()).toHaveLength(2);
  });

  it('no global scores still reads "No global scores yet" and schedules nothing', async () => {
    firstPage = { data: [], total: 0, hasMore: false };
    renderView();
    expect(screen.queryByText('No global scores yet')).not.toBeInTheDocument();
    await settle();
    expect(screen.getByText('No global scores yet')).toBeInTheDocument();
    expect(screen.queryByTestId('global-scores-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(boardCalls()).toHaveLength(1);
  });

  it('a failed reload after a score post keeps the cards and retries quietly', async () => {
    renderView();
    await settle();

    fireEvent.click(card('Monster Bash')!);
    limited = true;
    fireEvent.click(screen.getByRole('button', { name: 'Posted' }));
    await settle();
    expect(boardCalls()).toHaveLength(2);
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(screen.queryByTestId('global-scores-load-failed')).not.toBeInTheDocument();

    limited = false;
    firstPage = { data: [game('gg-1', 'Monster Bash'), game('gg-2', 'Attack from Mars')], total: 2, hasMore: false };
    await advance(1_000);
    expect(boardCalls()).toHaveLength(3);
    expect(card('Attack from Mars')).toBeInTheDocument();
  });

  it('a failed Load more stops its spinner, keeps the cards and the button', async () => {
    firstPage = { data: [game('gg-1', 'Monster Bash')], total: 2, hasMore: true };
    renderView();
    await settle();

    limited = true;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    expect(screen.getByRole('button', { name: LOAD_MORE_LABEL })).toBeEnabled();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
    expect(card('Monster Bash')).toBeInTheDocument();
    await advance(45_000);
    expect(boardCalls()).toHaveLength(2);

    offline = true;
    limited = false;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    expect(screen.getByRole('button', { name: LOAD_MORE_LABEL })).toBeEnabled();

    offline = false;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();
    const last = String(boardCalls().at(-1)![0]);
    expect(new URL(last, 'http://localhost').searchParams.get('offset')).toBe('1');
    expect(card('Monster Bash')).toBeInTheDocument();
    expect(card('Attack from Mars')).toBeInTheDocument();
  });

  it('a Load more answer that lands after the search changed is not added to the new list', async () => {
    firstPage = { data: [game('gg-1', 'Monster Bash')], total: 2, hasMore: true };
    renderView();
    await settle();

    holdMore = true;
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE_LABEL }));
    await settle();

    fireEvent.change(screen.getByLabelText(GLOBAL_SEARCH_PLACEHOLDER), { target: { value: 'medi' } });
    await advance(300);
    await settle();
    expect(card('Medieval Madness')).toBeInTheDocument();

    releaseMore!();
    await settle();
    expect(card('Medieval Madness')).toBeInTheDocument();
    expect(card('Attack from Mars')).not.toBeInTheDocument();
  });
});
