import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import PublicLayout from '../PublicLayout';
import RoomNoticeSlot from '../RoomNoticeSlot';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../ThemeProvider';

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

const future = (min: number) => new Date(Date.now() + min * 60000).toISOString();

let tournamentReads = 0;

function stubFetch() {
  tournamentReads = 0;
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/portal')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 'room-slot', roomId: 'room-slot', slug: 'slot_room', name: 'Slot Room', pick_award_enabled: false }),
      });
    }
    if (url === '/api/rooms/room-slot/tournaments') {
      tournamentReads += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([{
          id: 'ev1', name: 'Slot Test Event', format: 'event', is_active: 1, checkin_required: 0,
          rounds: [{ status: 'SCHEDULED', round_no: 1, name: 'R1', scheduled_start_at: future(90), scheduled_end_at: future(120) }],
        }]),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/:slug" element={<PublicLayout />}>
              <Route path="bare" element={<p>bare page</p>} />
              <Route
                path="a"
                element={<div><h1>Page A</h1><RoomNoticeSlot /><Link to="/slot_room/b">go b</Link></div>}
              />
              <Route
                path="b"
                element={<div><h1>Page B</h1><RoomNoticeSlot /></div>}
              />
            </Route>
          </Routes>
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('RoomNoticeSlot (G13)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('with no slot on the page the notices sit at the top of the content', async () => {
    stubFetch();
    renderAt('/slot_room/bare');
    const event = await screen.findByText('Slot Test Event');
    const column = screen.getByTestId('room-notices');
    expect(column.contains(event)).toBe(true);
    expect(screen.queryByTestId('room-notice-slot')).toBeNull();
    // Before the page's own content.
    const page = screen.getByText('bare page');
    expect(column.compareDocumentPosition(page) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with a slot the notices move into it, after the page header', async () => {
    stubFetch();
    renderAt('/slot_room/a');
    const event = await screen.findByText('Slot Test Event');
    const slot = await screen.findByTestId('room-notice-slot');
    await waitFor(() => expect(within(slot).getByTestId('room-notices')).toBeInTheDocument());
    expect(slot.contains(event)).toBe(true);
    const heading = screen.getByText('Page A');
    expect(heading.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('navigating between pages moves the node without remounting the notices', async () => {
    stubFetch();
    renderAt('/slot_room/a');
    await screen.findByText('Slot Test Event');
    await waitFor(() => expect(within(screen.getByTestId('room-notice-slot')).getByTestId('room-notices')).toBeInTheDocument());
    const nodeBefore = screen.getByTestId('room-notices');
    expect(tournamentReads).toBe(1);

    fireEvent.click(screen.getByText('go b'));
    await screen.findByText('Page B');
    await waitFor(() => expect(within(screen.getByTestId('room-notice-slot')).getByTestId('room-notices')).toBeInTheDocument());

    expect(screen.getByTestId('room-notices')).toBe(nodeBefore);
    expect(screen.getByText('Slot Test Event')).toBeInTheDocument();
    // EventBanner reads the tournaments on mount: still one read = no remount.
    expect(tournamentReads).toBe(1);
  });
});
