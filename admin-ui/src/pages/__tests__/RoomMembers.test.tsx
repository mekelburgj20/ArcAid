import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RoomMembers from '../RoomMembers';
import { RoomContext } from '../../contexts/RoomContext';
import { invalidatePortal } from '../../lib/portal';

/**
 * Room Members/Players page (v2.42.0). Two modes driven entirely by data:
 * the `/members` endpoint response shape, plus `join_policy` read off
 * `getPortal(slug)` (a separate fetch to `/api/portal`). No auth branching
 * happens in this component itself — PublicLayout's gate already decided
 * whether this page is reachable.
 */

function renderRoomMembers(roomId = 'room-1', slug = 'test-room') {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/members`]}>
      <RoomContext.Provider value={{ roomId, roomSlug: slug, roomName: 'Test Room' }}>
        <Routes>
          <Route path="/:slug/members" element={<RoomMembers />} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

function mockFetch(membersResponse: unknown, joinPolicy: 'open' | 'approval' = 'open') {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/members')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(membersResponse) });
    }
    if (url.includes('/api/portal')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'test-room', name: 'Test Room', join_policy: joinPolicy }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

describe('RoomMembers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // getPortal() caches per-slug at module scope (by design, for cross-mount
    // dedup in the real app) — invalidate so each test's mocked join_policy
    // isn't shadowed by an earlier test's cached promise for the same slug.
    invalidatePortal('test-room');
  });

  it('open room: renders "Players" header + scoreCount/last-active secondary line', async () => {
    mockFetch([
      {
        userId: 'discord-alice', displayName: 'Alice', username: null,
        iscoredUsername: 'Alice', avatarHash: null, avatarUrl: null,
        firstSeenAt: '2026-01-01T00:00:00.000Z', lastSeenAt: new Date().toISOString(), scoreCount: 3,
      },
    ], 'open');

    renderRoomMembers();

    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.getByText('Players')).toBeInTheDocument();
    expect(screen.getByText("Everyone who's posted a score")).toBeInTheDocument();
    expect(screen.getByText(/3 scores/)).toBeInTheDocument();
  });

  it('approval room: renders "Members" header + "Member since" secondary line + owner badge', async () => {
    mockFetch([
      {
        userId: 'discord-owner', displayName: 'Owner Person', username: null,
        iscoredUsername: 'OwnerAlias', avatarHash: null, avatarUrl: null,
        joinedAt: '2026-01-01T00:00:00.000Z', isOwner: true, isAdmin: false,
      },
    ], 'approval');

    renderRoomMembers();

    await waitFor(() => expect(screen.getByText('Owner Person')).toBeInTheDocument());
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Approved members of this room')).toBeInTheDocument();
    expect(screen.getByText(/Member since/)).toBeInTheDocument();
    expect(screen.getByText('Owner')).toBeInTheDocument();
  });

  it('renders a row with no iscoredUsername as plain text, not a broken link', async () => {
    mockFetch([
      {
        userId: 'discord-noalias', displayName: 'No Alias User', username: null,
        iscoredUsername: null, avatarHash: null, avatarUrl: null,
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
    ], 'approval');

    renderRoomMembers();

    await waitFor(() => expect(screen.getByText('No Alias User')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /No Alias User/ })).not.toBeInTheDocument();
  });

  it('empty state: open room with no posters', async () => {
    mockFetch([], 'open');
    renderRoomMembers();
    await waitFor(() => expect(screen.getByText(/be the first to post a score/)).toBeInTheDocument());
  });

  it('empty state: approval room with no members', async () => {
    mockFetch([], 'approval');
    renderRoomMembers();
    await waitFor(() => expect(screen.getByText('No members yet.')).toBeInTheDocument());
  });
});
