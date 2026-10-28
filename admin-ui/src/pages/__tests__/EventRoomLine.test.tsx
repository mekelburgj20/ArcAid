import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * W30 (v2.194.0) - the room is not the tournament. The event page header reads
 * "Room -> Tournament": the room name is a small link above the event name. A
 * Throwdown has no room, so it gets no such line.
 */

const { getMock, roomRef } = vi.hoisted(() => ({
  getMock: vi.fn(),
  roomRef: { current: null as null | { roomId: string; roomSlug: string; roomName: string } },
}));

vi.mock('../../lib/playerApi', () => ({ playerApi: { get: getMock, post: vi.fn() } }));
vi.mock('../../contexts/RoomContext', () => ({
  useOptionalRoom: () => roomRef.current,
  useRoom: () => roomRef.current,
}));
vi.mock('../../contexts/ViewerAuthContext', () => ({
  useViewerAuth: () => ({
    discordUser: null, playerToken: null,
    loginWithDiscord: vi.fn(), loginWithGoogle: vi.fn(),
  }),
}));

const { default: EventDetail } = await import('../EventDetail');

const payload = {
  event: {
    id: 'ev1', name: 'Friday Night Flip', state: 'upcoming', aggregateMethod: 'best',
    minElapsedSec: null, endGraceSec: null, startDate: null, endDate: null, finishedAt: null,
  },
  now: '2026-10-28T00:00:00.000Z',
  checkin: { opensAt: null, closesAt: null, required: false, count: 0, viewerCheckedIn: false },
  rounds: [],
  standings: null,
  viewer: { canCheckIn: false, reason: null },
};

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(payload);
});

describe('EventDetail header (W30)', () => {
  it('shows the room as a link above the tournament name on a hosted event', async () => {
    roomRef.current = { roomId: 'room-1', roomSlug: 'wizard', roomName: 'Arcaid Witness Demo' };
    render(
      <MemoryRouter initialEntries={['/wizard/events/ev1']}>
        <Routes><Route path="/:slug/events/:id" element={<EventDetail />} /></Routes>
      </MemoryRouter>,
    );
    const heading = await screen.findByRole('heading', { name: 'Friday Night Flip' });
    const roomLine = screen.getByTestId('event-room-line');
    expect(roomLine).toHaveTextContent('Arcaid Witness Demo');
    expect(roomLine).toHaveAttribute('href', '/wizard');
    // Room first, tournament heading after it.
    expect(roomLine.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a Throwdown (no room) gets no room line', async () => {
    roomRef.current = null;
    render(
      <MemoryRouter initialEntries={['/throwdown/ABC']}>
        <Routes><Route path="/throwdown/:code" element={<EventDetail throwdownCode="ABC" />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => screen.getByRole('heading', { name: 'Friday Night Flip' }));
    expect(screen.queryByTestId('event-room-line')).toBeNull();
  });
});
