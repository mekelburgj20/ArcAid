import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicLayout from '../PublicLayout';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { useRoom } from '../../contexts/RoomContext';

// S18 — PublicLayout owns the single portal fetch for its whole subtree and
// provides RoomContext to every child route. This is the regression test for
// both halves of that contract: exactly one /api/portal request no matter how
// many consumers (nav's usePickAwardEnabled + the layout itself) need it, and
// the child route sees the resolved room via useRoom() with no fetch of its own.
function ChildProbe() {
  const { roomId, roomSlug, roomName } = useRoom();
  return (
    <div>
      <span data-testid="roomId">{roomId}</span>
      <span data-testid="roomSlug">{roomSlug}</span>
      <span data-testid="roomName">{roomName}</span>
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewerAuthProvider>
        <Routes>
          <Route path="/:slug" element={<PublicLayout />}>
            <Route path="child" element={<ChildProbe />} />
          </Route>
        </Routes>
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('makes exactly one /api/portal request and provides the resolved room to children', async () => {
    const portalCalls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        portalCalls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
        });
      }
      // lobby-feed activity-dot poll — respond with an empty feed.
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball/child');

    await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));
    expect(screen.getByTestId('roomSlug')).toHaveTextContent('rtx_pinball');
    expect(screen.getByTestId('roomName')).toHaveTextContent('RTX Pinball');

    expect(portalCalls).toHaveLength(1);
  });

  it('renders a friendly not-found state when the portal 404s', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/no-such-room/child');

    await waitFor(() => expect(screen.getByText('Room not found')).toBeInTheDocument());
  });
});
