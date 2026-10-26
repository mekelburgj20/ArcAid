import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RosterPanel from '../RosterPanel';
import type { Tournament } from '../../lib/tournamentFormPayload';

/**
 * Roster panel (v2.179.0, W39, ADR 0033 §6) — the host's side of an invite-only
 * tournament: the invite link, the request queue and the roster itself.
 */

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);
const mockedPost = vi.mocked(api.post);

const TOURNAMENT: Tournament = {
  id: 't-1', name: 'Invite Cup', type: 'IC', mode: 'pinball',
  cadence: '{}', platform_rules: '{}', is_active: 1, display_order: 0,
  max_active_games: 1, cleanup_rule: '{}', winner_picks: 1, auto_pick: 1, eligibility_days: 120,
  winner_pick_window_min: 60, runnerup_pick_window_min: 30, entry_mode: 'invited',
};

const ROSTER = {
  mode: 'invited',
  methods: { link: true, request: true },
  inviteCode: 'ABCD2345',
  roster: [{ userId: 'u-1', label: 'Mox', source: 'invite', addedAt: '2026-10-26 10:00:00' }],
  requests: [{ id: 7, userId: 'u-2', label: 'TomatoGrass', requestedAt: '2026-10-26 11:00:00' }],
};

describe('RosterPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGet.mockResolvedValue(ROSTER as never);
    mockedPost.mockResolvedValue({} as never);
  });

  it('shows the invite link, the waiting request and the roster by NAME', async () => {
    render(<RosterPanel roomId="room-1" tournament={TOURNAMENT} onClose={() => {}} toast={() => {}} />);
    expect(await screen.findByTestId('invite-url')).toHaveTextContent('/tournament-invite/ABCD2345');
    expect(screen.getByText('TomatoGrass')).toBeInTheDocument();
    // Mox's row names the player and how they got on (the section heading also reads "Invite link").
    expect(screen.getByText('Mox')).toBeInTheDocument();
    expect(screen.getAllByText('Invite link')).toHaveLength(2);
  });

  it('approves a request and adds a player by @name through the host routes', async () => {
    render(<RosterPanel roomId="room-1" tournament={TOURNAMENT} onClose={() => {}} toast={() => {}} />);
    fireEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/rooms/room-1/admin/tournaments/t-1/entry-requests/7/approve', {}));

    fireEvent.change(screen.getByLabelText('Add a player to the roster'), { target: { value: '@Wyo' } });
    fireEvent.click(screen.getByText('Add'));
    await waitFor(() => expect(mockedPost).toHaveBeenCalledWith('/rooms/room-1/admin/tournaments/t-1/roster', { userId: '@Wyo' }));
  });
});
