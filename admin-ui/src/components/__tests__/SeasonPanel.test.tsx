import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import SeasonPanel, { type SeasonPoll, type SeasonQueue } from '../SeasonPanel';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * Season panel (docs/season-format-plan.md §8.2). Locks the wire contract
 * (paths + bodies the season routes expect), that the queue renders what the
 * SERVER returned, and that an open poll's editor freezes everything except an
 * earlier close time (Discord cannot edit a posted poll).
 */

const { apiMock, socketMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  socketMock: { emit: vi.fn(), on: vi.fn(), off: vi.fn() },
}));

vi.mock('../../lib/api', () => ({ api: apiMock }));
vi.mock('../../lib/websocket', () => ({ getSocket: () => socketMock }));

const ROOM = 'room-1';
const TID = 't-1';
const BASE = `/rooms/${ROOM}/tournaments/${TID}/season`;

const tournament: Tournament = {
  id: TID, name: 'Weekly Grind Season', type: 'WG', mode: 'pinball',
  cadence: JSON.stringify({ cron: '0 0 * * 5', timezone: 'America/New_York' }),
  platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
  cleanup_rule: '{"mode":"retain","count":1}', winner_picks: 0, auto_pick: 0,
  eligibility_days: 0, winner_pick_window_min: 60, runnerup_pick_window_min: 30,
  format: 'rotation', season_table_count: 12, season_tie_rule: 'admin',
};

function poll(over: Partial<SeasonPoll>): SeasonPoll {
  return {
    id: 'p', slot_no: 1, status: 'draft', question: 'Weekly Grind Season — week 1 table', question_custom: null,
    opens_at: null, closes_at: null, posted_at: null, discord_channel_id: null, discord_message_id: null,
    discord_url: null, tie_rule: null, effective_tie_rule: 'admin', result_game_name: null,
    result_queued_game_id: null, result_queued_status: null, tied: false, tied_positions: [],
    can_choose: false, resolved_at: null, created_at: '2026-10-01 00:00:00', beyond_bound: false,
    candidates: [], total_votes: 0, voters: [],
    ...over,
  };
}

const QUEUE: SeasonQueue = {
  tournament_id: TID, table_count: 12, tables_done: 5, resolved_count: 6, bound_reached: false,
  paused: false, finished: false,
  polls: [
    poll({
      id: 'p-res', slot_no: 6, status: 'resolved', tied: true, tied_positions: [1, 2], can_choose: true,
      result_game_name: 'Attack from Mars', result_queued_game_id: 'g-q', result_queued_status: 'QUEUED',
      candidates: [
        { position: 1, game_name: 'Attack from Mars', global_game_id: 'g1', discord_answer_id: 1, votes: 4 },
        { position: 2, game_name: 'Medieval Madness', global_game_id: 'g2', discord_answer_id: 2, votes: 4 },
        { position: 3, game_name: 'Twilight Zone', global_game_id: 'g3', discord_answer_id: 3, votes: 1 },
      ],
      total_votes: 9,
      voters: [{ user_id: 'u1', display_name: 'PinWizard', position: 1, source: 'discord', voted_at: '2026-10-01 01:00:00' }],
    }),
    poll({
      id: 'p-open', slot_no: 7, status: 'open', question: 'Which table next?', question_custom: 'Which table next?',
      opens_at: '2026-10-19T04:00:00.000Z', closes_at: '2027-10-23T01:00:00.000Z', posted_at: '2026-10-19T04:00:30.000Z',
      discord_channel_id: '123', discord_message_id: '456', discord_url: 'https://discord.com/channels/1/123/456',
      candidates: [
        { position: 1, game_name: 'Fish Tales', global_game_id: 'g4', discord_answer_id: 1, votes: 2 },
        { position: 2, game_name: 'Funhouse', global_game_id: 'g5', discord_answer_id: 2, votes: 0 },
      ],
      total_votes: 2,
    }),
    poll({ id: 'p-d1', slot_no: 8, status: 'draft', candidates: [
      { position: 1, game_name: 'Scared Stiff', global_game_id: 'g6', discord_answer_id: null, votes: 0 },
    ] }),
    poll({ id: 'p-d2', slot_no: 13, status: 'draft', beyond_bound: true }),
  ],
};

const CANDIDATES = {
  candidates: [
    { global_game_id: 'g7', name: 'Theatre of Magic', manufacturer: 'Bally', year: 1995, played_before: false },
    { global_game_id: 'g8', name: 'The Addams Family', manufacturer: 'Bally', year: 1992, played_before: false },
  ],
};

function renderPanel() {
  return render(
    <SeasonPanel roomId={ROOM} tournament={tournament} onClose={vi.fn()} onChanged={vi.fn()} toast={vi.fn()} />,
  );
}

beforeEach(() => {
  apiMock.get.mockReset();
  apiMock.post.mockReset();
  apiMock.put.mockReset();
  apiMock.get.mockImplementation((path: string) => {
    if (path === `${BASE}/polls`) return Promise.resolve(QUEUE);
    if (path.startsWith(`${BASE}/candidates`)) return Promise.resolve(CANDIDATES);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  apiMock.post.mockResolvedValue({ success: true });
  apiMock.put.mockResolvedValue({ success: true });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SeasonPanel', () => {
  it('renders progress and the queue the server returned', async () => {
    renderPanel();
    expect(await screen.findByTestId('season-progress')).toHaveTextContent('Week 6 of 12');

    const resolved = screen.getByTestId('poll-p-res');
    expect(within(resolved).getByText('Resolved')).toBeTruthy();
    expect(within(resolved).getByText('Tie')).toBeTruthy();
    expect(within(resolved).getByText('Twilight Zone')).toBeTruthy();
    expect(within(resolved).getByText('9 votes in total')).toBeTruthy();

    const open = screen.getByTestId('poll-p-open');
    expect(within(open).getByText('Open')).toBeTruthy();
    expect(within(open).getByText('Which table next?')).toBeTruthy();
    expect(within(open).getByRole('link', { name: /Discord/ }).getAttribute('href')).toBe('https://discord.com/channels/1/123/456');
    expect(within(open).getByText('2 votes')).toBeTruthy();

    expect(within(screen.getByTestId('poll-p-d2')).getByText(/table count is already reached/)).toBeTruthy();

    // Voters are collapsed until asked for.
    expect(within(resolved).queryByText('PinWizard')).toBeNull();
    fireEvent.click(within(resolved).getByRole('button', { name: 'Show voters (1)' }));
    expect(within(resolved).getByText('PinWizard')).toBeTruthy();
    expect(within(resolved).getByText('Discord')).toBeTruthy();
  });

  it('subscribes to season:poll on the room socket', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    expect(socketMock.emit).toHaveBeenCalledWith('join:room', ROOM);
    expect(socketMock.on).toHaveBeenCalledWith('season:poll', expect.any(Function));
  });

  it('creating a draft posts candidates in nominated order', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    fireEvent.click(screen.getByRole('button', { name: 'New poll' }));

    const editor = screen.getByRole('region', { name: 'Poll editor' });
    // "Not yet played" filter is on by default.
    await waitFor(() => expect(apiMock.get).toHaveBeenCalledWith(expect.stringMatching(/\/season\/candidates\?.*unplayed=1/)));
    fireEvent.click(await within(editor).findByRole('button', { name: 'Add The Addams Family' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Add Theatre of Magic' }));
    // Reorder: Theatre of Magic becomes first nominated.
    fireEvent.click(within(editor).getByRole('button', { name: 'Move Theatre of Magic up' }));
    fireEvent.change(within(editor).getByLabelText(/Question/), { target: { value: 'Week 9?' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/polls`, {
      candidates: [
        { game_name: 'Theatre of Magic', global_game_id: 'g7' },
        { game_name: 'The Addams Family', global_game_id: 'g8' },
      ],
      question: 'Week 9?',
    });
  });

  it('an exact-time draft sends opens_at and closes_at together', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    fireEvent.click(screen.getByRole('button', { name: 'New poll' }));
    const editor = screen.getByRole('region', { name: 'Poll editor' });
    fireEvent.change(within(editor).getByLabelText('Poll times'), { target: { value: 'exact' } });
    const dates = editor.querySelectorAll('input[type="date"]');
    fireEvent.change(dates[0], { target: { value: '2027-01-04' } });
    fireEvent.change(dates[1], { target: { value: '2027-01-07' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalled());
    const body = apiMock.post.mock.calls[0][1];
    // 20:00 America/New_York (EST, UTC-5) — DateTimeField's evening default.
    expect(body.opens_at).toBe('2027-01-05T01:00:00.000Z');
    expect(body.closes_at).toBe('2027-01-08T01:00:00.000Z');
  });

  it('an open poll locks everything but an earlier close time', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    fireEvent.click(within(screen.getByTestId('poll-p-open')).getByRole('button', { name: 'Change close time' }));

    const editor = screen.getByRole('region', { name: 'Poll editor' });
    expect((within(editor).getByLabelText(/Question/) as HTMLInputElement).disabled).toBe(true);
    expect((within(editor).getByLabelText(/Discord channel/) as HTMLInputElement).disabled).toBe(true);
    expect((within(editor).getByLabelText('Tie rule') as HTMLSelectElement).disabled).toBe(true);
    expect(within(editor).queryByLabelText('Search candidates')).toBeNull();
    expect(within(editor).queryByRole('button', { name: /Remove/ })).toBeNull();

    // A LATER close is refused client-side, before it reaches the server.
    const date = editor.querySelector('input[type="date"]') as HTMLInputElement;
    fireEvent.change(date, { target: { value: '2028-01-01' } });
    expect(within(editor).getByRole('alert').textContent).toMatch(/only close earlier/);
    expect((within(editor).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(date, { target: { value: '2027-10-20' } });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiMock.put).toHaveBeenCalled());
    const [path, body] = apiMock.put.mock.calls[0];
    expect(path).toBe(`${BASE}/polls/p-open`);
    expect(Object.keys(body)).toEqual(['closes_at']);
  });

  it('the tie override chooses among the tied positions', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    const resolved = screen.getByTestId('poll-p-res');
    expect((within(resolved).getByRole('button', { name: 'Attack from Mars (queued)' }) as HTMLButtonElement).disabled).toBe(true);
    // Not tied — no button for it.
    expect(within(resolved).queryByRole('button', { name: 'Play Twilight Zone' })).toBeNull();
    fireEvent.click(within(resolved).getByRole('button', { name: 'Play Medieval Madness' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/polls/p-res/choose`, { position: 2 }));
  });

  it('poll actions hit their routes', async () => {
    renderPanel();
    await screen.findByTestId('season-progress');
    fireEvent.click(within(screen.getByTestId('poll-p-open')).getByRole('button', { name: 'Close now' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/polls/p-open/close`, {}));

    // Week 8 is the first draft after an open poll: it can move down, not up.
    const d1 = screen.getByTestId('poll-p-d1');
    expect((within(d1).getByRole('button', { name: 'Move week 8 up' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(d1).getByRole('button', { name: 'Move week 8 down' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/polls/p-d1/reorder`, { slot_no: 13 }));

    fireEvent.click(screen.getByRole('button', { name: 'Pause season' }));
    await waitFor(() => expect(apiMock.post).toHaveBeenCalledWith(`${BASE}/pause`, {}));
  });
});
