import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * Tournaments admin page — Season vs Pick-by-poll affordances (ADR 0026).
 *
 * A Season row reads "Season N/M" and gets a "Season" button; a poll-only
 * rotation reads "Poll" and gets a "Polls" button; an ordinary rotation gets
 * neither.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

vi.mock('../../lib/api', () => ({ api: apiMock, getToken: () => 'token' }));
vi.mock('../../contexts/RoomContext', () => ({
  useRoom: () => ({ roomId: 'room-1', roomSlug: 'room', roomName: 'Room' }),
}));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { default: Tournaments } = await import('../Tournaments');

function row(over: Partial<Tournament>): Tournament {
  return {
    id: 't', name: 'T', type: 'TT', mode: 'pinball',
    cadence: JSON.stringify({ cron: '0 0 * * 5', timezone: 'America/New_York' }),
    platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
    cleanup_rule: JSON.stringify({ mode: 'retain', count: 0 }), winner_picks: 0, auto_pick: 0,
    eligibility_days: 0, winner_pick_window_min: 60, runnerup_pick_window_min: 30, format: 'rotation',
    ...over,
  };
}

const ROWS: Tournament[] = [
  row({
    id: 'season', name: 'Mox Season', season_table_count: 12, poll_picks: 1,
    season: { poll_picks: true, tables_done: 4, table_count: 12, paused: false, finished: false, open_poll_id: null },
  }),
  row({
    id: 'poll', name: 'Weekly Vote', season_table_count: null, poll_picks: 1,
    season: { poll_picks: true, tables_done: null, table_count: null, paused: false, finished: false, open_poll_id: null },
  }),
  row({ id: 'plain', name: 'Daily Grind', winner_picks: 1, auto_pick: 1, eligibility_days: 120 }),
];

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation((path: string) => {
    if (path.endsWith('/tournaments')) return Promise.resolve(ROWS);
    if (path.endsWith('/platforms/available')) return Promise.resolve({ platforms: [] });
    if (path.endsWith('/admin/health')) return Promise.resolve({ maintenance: [] });
    return Promise.resolve([]);
  });
});

function rowFor(name: string): HTMLElement {
  const cell = screen.getAllByText(name)[0]!;
  return cell.closest('tr') ?? cell.closest('li') ?? cell.parentElement!.parentElement!;
}

describe('Tournaments page — Season / Poll chips and buttons', () => {
  it('labels each row by what it is', async () => {
    render(<Tournaments />);
    await screen.findAllByText('Mox Season');

    const season = rowFor('Mox Season');
    expect(within(season).getByText('Season 5/12')).toBeTruthy();
    expect(within(season).getByRole('button', { name: 'Season' })).toBeTruthy();
    expect(within(season).queryByText('Poll')).toBeNull();

    const poll = rowFor('Weekly Vote');
    expect(within(poll).getByText('Poll')).toBeTruthy();
    expect(within(poll).getByRole('button', { name: 'Polls' })).toBeTruthy();
    expect(within(poll).queryByText(/^Season/)).toBeNull();

    const plain = rowFor('Daily Grind');
    expect(within(plain).queryByRole('button', { name: 'Season' })).toBeNull();
    expect(within(plain).queryByRole('button', { name: 'Polls' })).toBeNull();
  });
});
