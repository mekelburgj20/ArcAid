import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * W33 (WWS 2026-10-23) — a finished event is not an active tournament.
 *
 * TWR Tournament #1 kept reading as a live row on the admin page (with a
 * daily "Skipped" last run from its stray cron) after it had ended. A finished
 * event now sits in its own dimmed "Finished" section saying it takes no
 * scores, the event rows never show a maintenance last-run, and the edit form
 * locks the format (the server refuses a change with 409 FORMAT_LOCKED).
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
    cadence: JSON.stringify({ cron: '0 0 * * 5', timezone: 'America/Chicago' }),
    platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
    cleanup_rule: JSON.stringify({ mode: 'retain', count: 0 }), winner_picks: 1, auto_pick: 1,
    eligibility_days: 120, winner_pick_window_min: 60, runnerup_pick_window_min: 30, format: 'rotation',
    ...over,
  };
}

const ROUND = {
  id: 'r1', name: 'TNA', status: 'COMPLETED', round_no: 1,
  scheduled_start_at: '2026-10-24T01:00:00.000Z', scheduled_end_at: '2026-10-24T02:00:00.000Z',
};

const ROWS: Tournament[] = [
  row({ id: 'grind', name: 'Daily Grind' }),
  row({
    id: 'twr', name: 'TWR Tournament #1', format: 'event', is_active: 0,
    cadence: JSON.stringify({ timezone: 'America/Chicago' }),
    event_finished_at: '2026-10-24T23:00:00.000Z',
    rounds: [ROUND] as Tournament['rounds'],
  }),
];

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation((path: string) => {
    if (path.endsWith('/tournaments')) return Promise.resolve(ROWS);
    if (path.endsWith('/platforms/available')) return Promise.resolve({ platforms: [] });
    if (path.endsWith('/admin/health')) {
      return Promise.resolve({
        maintenance: [{ tournamentId: 'twr', lastRun: { outcome: 'skipped', finishedAt: '2026-10-25T17:00:00.000Z', summary: null }, nextFireAt: null }],
      });
    }
    return Promise.resolve([]);
  });
});

describe('Tournaments page — finished events (W33)', () => {
  it('lists a finished event under "Finished", not "Active Tournaments", and says it takes no scores', async () => {
    render(<Tournaments />);
    await screen.findAllByText('Daily Grind');

    const finishedCard = screen.getByRole('region', { name: 'Finished' });
    expect(within(finishedCard).getByText('TWR Tournament #1')).toBeTruthy();
    expect(within(finishedCard).getByText(/not accepting scores/)).toBeTruthy();
    expect(within(finishedCard).queryByText('Daily Grind')).toBeNull();

    // Exactly one place names the event: the Finished section.
    expect(screen.getAllByText('TWR Tournament #1')).toHaveLength(1);
  });

  it('locks the format in the edit form', async () => {
    render(<Tournaments />);
    await screen.findAllByText('Daily Grind');
    const grind = screen.getAllByText('Daily Grind')[0]!.closest('tr')!;
    fireEvent.click(within(grind).getByRole('button', { name: 'Edit' }));

    const eventBtn = screen.getAllByRole('button', { name: 'Event' }).find(b => (b as HTMLButtonElement).disabled);
    expect(eventBtn).toBeTruthy();
    expect(screen.getByText(/format can't be changed after a tournament is created/)).toBeTruthy();
  });
});
