import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * AtGames create-on-save. An event linked to an AtGames private tournament
 * shows its join code on its row (click to copy), and the create form offers
 * "Also create it on AtGames" for events only.
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

const EVENT: Tournament = {
  id: 'ev', name: 'Cabinet Night', type: 'CN', mode: 'pinball',
  cadence: JSON.stringify({ timezone: 'America/Chicago' }),
  platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
  cleanup_rule: JSON.stringify({ mode: 'retain', count: 0 }), winner_picks: 1, auto_pick: 1,
  eligibility_days: 120, winner_pick_window_min: 60, runnerup_pick_window_min: 30, format: 'event',
  atgames_tournament_id: '4242', atgames_invite_code: 'XK7Q2',
  rounds: [{
    id: 'r1', name: 'TNA', status: 'SCHEDULED', round_no: 1,
    scheduled_start_at: '2099-01-01T01:00:00.000Z', scheduled_end_at: '2099-01-01T02:00:00.000Z',
  }] as Tournament['rounds'],
};

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation((path: string) => {
    if (path.endsWith('/tournaments')) return Promise.resolve([EVENT]);
    if (path.endsWith('/platforms/available')) return Promise.resolve({ platforms: [] });
    return Promise.resolve([]);
  });
});

describe('Tournaments page — AtGames join code', () => {
  it('shows the join code on a linked event row and copies it on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Tournaments />);
    await screen.findAllByText('Cabinet Night');

    const chip = screen.getByRole('button', { name: /AtGames code XK7Q2/ });
    fireEvent.click(chip);
    expect(writeText).toHaveBeenCalledWith('XK7Q2');
  });

  it('offers "Also create it on AtGames" only for an event', async () => {
    render(<Tournaments />);
    await screen.findAllByText('Cabinet Night');
    expect(screen.queryByText('Also create it on AtGames')).toBeNull();

    const createCard = screen.getByText('Create New Tournament').closest('div')!.parentElement!;
    fireEvent.click(within(createCard).getAllByRole('button', { name: 'Event' })[0]!);
    expect(screen.getByText('Also create it on AtGames')).toBeTruthy();
  });
});
