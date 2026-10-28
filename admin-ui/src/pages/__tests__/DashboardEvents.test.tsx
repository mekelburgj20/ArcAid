import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * W24 (v2.192.0) - the Room Admin dashboard shows an EVENT as a round: the
 * state, the round and its window in the room timezone, the leader from the
 * round board - and an honest line when nothing is scheduled.
 */

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn() } }));
vi.mock('../../lib/api', () => ({ api: apiMock, getToken: () => 'token' }));
vi.mock('../../contexts/RoomContext', () => ({
  useRoom: () => ({ roomId: 'room-1', roomSlug: 'room', roomName: 'Room' }),
}));
vi.mock('../../components/SetupChecklist', () => ({ default: () => null }));

const { default: Dashboard } = await import('../Dashboard');

const base = {
  tournament_type: 'DG', game_image_url: null, participants: 3, next_rotation_at: null,
};

const dash = {
  recentWinners: [],
  systemHealth: { botOnline: true, setupComplete: true },
  uniquePlayersAcrossTournaments: 3,
  activeTournaments: [
    {
      ...base, tournament_name: 'WWS Night', game_name: 'Attack from Mars',
      format: 'event', event_state: 'live', round_no: 2, round_count: 3, round_status: 'ACTIVE',
      round_start_at: '2026-10-24T00:00:00.000Z', round_end_at: '2099-10-24T00:30:00.000Z',
      leader_name: 'Bee', leader_score: 700,
    },
    {
      ...base, tournament_name: 'Next Week', game_name: 'Medieval Madness',
      format: 'event', event_state: 'checkin', round_no: 1, round_count: 2, round_status: 'SCHEDULED',
      round_start_at: '2026-10-24T00:00:00.000Z', round_end_at: '2026-10-24T00:30:00.000Z',
    },
    {
      ...base, tournament_name: 'Empty Event', game_name: null,
      format: 'event', event_state: 'upcoming', round_no: null, round_count: 0, round_status: null,
      round_start_at: null, round_end_at: null,
    },
    {
      ...base, tournament_name: 'Daily Grind', game_name: 'Twilight Zone',
      leader_name: 'Sue', leader_score: 7000,
    },
  ],
};

beforeEach(() => {
  apiMock.get.mockReset().mockImplementation((path: string) => {
    if (path.endsWith('/dashboard')) return Promise.resolve(dash);
    if (path.endsWith('/settings')) return Promise.resolve({ ROOM_TIMEZONE: 'America/Chicago' });
    return Promise.reject(new Error('unmocked ' + path));
  });
});

describe('Dashboard event rows (W24)', () => {
  it('renders the round line, state, leader and an honest empty line', async () => {
    render(<Dashboard />);
    expect(await screen.findByText('Attack from Mars')).toBeInTheDocument();
    // The room zone arrives with a second request; wait for the zoned line.
    expect(await screen.findByText(/^Round 1 opens .*7:00\s?PM/)).toBeInTheDocument();

    const lines = screen.getAllByTestId('event-round-line').map(n => n.textContent ?? '');
    expect(lines.some(l => /^Round 2 is live until /.test(l))).toBe(true);

    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Check-in open')).toBeInTheDocument();
    expect(screen.getByText('Bee')).toBeInTheDocument();
    expect(screen.getByText('No round scheduled')).toBeInTheDocument();

    // The rotation card is unchanged: no event line, still a leader.
    expect(screen.getByText('Twilight Zone')).toBeInTheDocument();
    expect(screen.getByText('Sue')).toBeInTheDocument();
    expect(screen.getAllByTestId('event-round-line')).toHaveLength(2);
  });
});
