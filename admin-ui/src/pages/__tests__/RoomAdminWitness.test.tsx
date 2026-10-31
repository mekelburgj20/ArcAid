import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import RoomAdminWitness from '../RoomAdminWitness';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * The runner's live device view (v2.187.0, W5): a room admin sees every paired
 * Witness device of the room, the table open now, where its scores go (the
 * SAME words as the player's "Your scores go to" line), and each live event's
 * check-in lobby as counts.
 */

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn() },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);

const NOW = new Date().toISOString();

const PAYLOAD = {
  devices: [
    {
      deviceId: 'cab-1', deviceType: 'atgames', label: null,
      appVersion: '1.0.8', appVersionAt: NOW,
      deviceModel: 'HA9920', deviceModelName: 'Legends Ultimate',
      userId: 'u-1', playerName: 'Alice', member: true,
      online: 'online', heartbeatAt: NOW, lastSeenAt: NOW, lastCheckinAt: NOW,
      openTable: 'Attack from Mars (Williams 1995)', openSince: NOW,
      routing: {
        deviceId: 'cab-1', deviceType: 'atgames', sendsHere: 'yes', why: null,
        targetRoomName: null, targetTournamentName: null,
      },
      target: 'All your rooms',
    },
    {
      deviceId: 'pc-2', deviceType: 'desktop', label: null,
      userId: 'u-2', playerName: 'Bob', member: false,
      online: 'offline', heartbeatAt: NOW, lastSeenAt: NOW, lastCheckinAt: null,
      openTable: null, openSince: null,
      routing: {
        deviceId: 'pc-2', deviceType: 'desktop', sendsHere: 'no', why: 'other_room',
        targetRoomName: 'RTX Pinball', targetTournamentName: null,
      },
      target: 'RTX Pinball',
    },
    {
      deviceId: 'cab-3', deviceType: 'atgames', label: null,
      userId: 'u-3', playerName: 'Carl', member: true,
      online: 'unknown', heartbeatAt: null, lastSeenAt: NOW, lastCheckinAt: null,
      openTable: null, openSince: null, routing: null, target: 'Global Scoreboard only',
    },
  ],
  events: [
    {
      tournamentId: 't-1', name: 'Friday Night', state: 'checkin',
      counts: { ready: 3, table_open: 1, no_checkin: 2, offline: 1, not_routed: 0, no_cabinet: 4 },
      roster: [
        {
          userId: 'u-1', displayName: 'Alice', avatarHash: null, avatarUrl: null, checkedInAt: NOW,
          source: 'checkin', status: 'table_open', witnessCheckinAt: NOW, openTable: 'Attack from Mars', lastSeenAt: NOW,
        },
      ],
    },
  ],
};

function renderPage() {
  return render(
    <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'wizard', roomName: 'The Wizard Room' }}>
      <RoomAdminWitness />
    </RoomContext.Provider>,
  );
}

function stubApi(payload: unknown) {
  mockedGet.mockImplementation((async (path: string) => {
    if (path === '/rooms/room-1/admin/witness/devices') return payload;
    if (path === '/rooms/room-1/settings') return {};
    throw new Error(`unexpected GET ${path}`);
  }) as never);
}

describe('RoomAdminWitness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('names each player and device, its status, open table and the routing words', async () => {
    stubApi(PAYLOAD);
    renderPage();

    const cards = await screen.findAllByTestId('witness-admin-device');
    expect(cards).toHaveLength(3);

    const alice = within(cards[0]!);
    expect(alice.getByText('Alice')).toBeInTheDocument();
    expect(alice.getByText('Cabinet')).toBeInTheDocument();
    expect(alice.getByText('Online')).toBeInTheDocument();
    expect(alice.getByText(/Attack from Mars \(Williams 1995\)/)).toBeInTheDocument();
    expect(alice.getByText('Your cabinet sends its scores here.')).toBeInTheDocument();
    expect(alice.getByText('Target: All your rooms')).toBeInTheDocument();

    const bob = within(cards[1]!);
    expect(bob.getByText('Bob')).toBeInTheDocument();
    expect(bob.getByText('(entered, not a member)')).toBeInTheDocument();
    expect(bob.getByText('PC')).toBeInTheDocument();
    expect(bob.getByText('Not responding')).toBeInTheDocument();
    expect(bob.getByText('Never')).toBeInTheDocument();
    expect(bob.getByText('None')).toBeInTheDocument();
    expect(bob.getByText("Your PC sends to RTX Pinball only, so plays here won't count in this room.")).toBeInTheDocument();

    const carl = within(cards[2]!);
    expect(carl.getByText('Unknown')).toBeInTheDocument();
    expect(carl.getByText('Not known')).toBeInTheDocument();
  });

  it('W73: shows the cabinet model, or "model unknown" when it never said', async () => {
    stubApi(PAYLOAD);
    renderPage();

    const cards = await screen.findAllByTestId('witness-admin-device');
    expect(within(cards[0]!).getByTestId('witness-model-label')).toHaveTextContent('Legends Ultimate · HA9920');
    expect(within(cards[1]!).getByTestId('witness-model-label')).toHaveTextContent('model unknown');
  });

  it('W60: shows each device\'s Witness build, or "unknown" when it never said', async () => {
    stubApi(PAYLOAD);
    renderPage();

    const cards = await screen.findAllByTestId('witness-admin-device');
    expect(within(cards[0]!).getByTestId('witness-build-chip')).toHaveTextContent('Witness 1.0.8');
    expect(within(cards[1]!).getByTestId('witness-build-chip')).toHaveTextContent('Witness build unknown (before 1.0.8)');
    expect(within(cards[2]!).getByTestId('witness-build-chip')).toHaveTextContent('Witness build unknown (before 1.0.8)');
  });

  it('shows each live event with its lobby counts and compact roster', async () => {
    stubApi(PAYLOAD);
    renderPage();

    const counts = await screen.findByTestId('witness-admin-counts');
    expect(counts).toHaveTextContent('Ready 3');
    expect(counts).toHaveTextContent('Exit the table 1');
    expect(counts).toHaveTextContent('Not checked in 2');
    expect(counts).toHaveTextContent('Not responding 1');
    expect(counts).toHaveTextContent('No device 4');
    expect(screen.getByText('Friday Night · check-in lobby')).toBeInTheDocument();
    expect(screen.getByTestId('event-lobby-roster')).toBeInTheDocument();
  });

  it('shows the empty state when no member has a paired device', async () => {
    stubApi({ devices: [], events: [] });
    renderPage();
    expect(await screen.findByText('No Witness devices are paired by members of this room yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('witness-admin-devices')).not.toBeInTheDocument();
  });

  it('Refresh reloads, and an error is shown without dropping the list', async () => {
    stubApi(PAYLOAD);
    renderPage();
    await screen.findAllByTestId('witness-admin-device');
    const calls = () => mockedGet.mock.calls.filter(c => c[0] === '/rooms/room-1/admin/witness/devices').length;
    expect(calls()).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(calls()).toBe(2));

    mockedGet.mockImplementation((async (path: string) => {
      if (path === '/rooms/room-1/settings') return {};
      throw new Error('Server exploded');
    }) as never);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    // 5 s, not the 1 s default: on a loaded CI runner the refresh + rerender took 1.2 s (run 40741233426, 2026-10-28).
    expect(await screen.findByRole('alert', {}, { timeout: 10000 })).toHaveTextContent('Server exploded');
    expect(screen.getAllByTestId('witness-admin-device')).toHaveLength(3);
  }, 15000);

  it('polls every 20 seconds while visible and skips the tick while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubApi(PAYLOAD);
    renderPage();
    await screen.findAllByTestId('witness-admin-device');
    const calls = () => mockedGet.mock.calls.filter(c => c[0] === '/rooms/room-1/admin/witness/devices').length;
    expect(calls()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(calls()).toBe(2);

    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(calls()).toBe(2);
    hidden.mockRestore();
  });
});
