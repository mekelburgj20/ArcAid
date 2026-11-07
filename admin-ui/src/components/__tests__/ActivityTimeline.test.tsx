import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ActivityTimeline from '../ActivityTimeline';

/**
 * G14 (v2.227.0, ADR 0037) - the activity timeline: rows render with their
 * resolved player label and reasons, filters live in the URL and are sent to
 * the server, Problems only is one chip.
 */

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), download: vi.fn() },
}));
vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);

const ROW = {
  id: 7, created_at: '2026-11-06 03:14:00', tz: 'America/Chicago', room_name: 'Room', category: 'device',
  event_type: 'device_no_score', severity: 'problem', player: 'Krobs', actor: null, device: 'Castcade (PC)',
  tournament_name: null, game_name: null, table_name: 'Twilight Zone (Bally 1993)', source: null, score: null,
  summary: 'Played Twilight Zone (Bally 1993) for 38 min, but no score arrived',
  reasons: ['The device reported the table session but sent no score for it.'],
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.search}</div>;
}

function renderAt(url: string) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/a" element={<><ActivityTimeline mode="room" roomId="r1" /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockedGet.mockReset();
  mockedGet.mockImplementation((url: string) => {
    if (url.startsWith('/rooms/r1/admin/activity/meta')) {
      return Promise.resolve({ tournaments: [{ id: 't1', name: 'Weekly Grind' }], timezone: 'America/Chicago' });
    }
    return Promise.resolve({ rows: [ROW], nextBefore: null, timezone: 'America/Chicago' });
  });
});

describe('ActivityTimeline', () => {
  it('renders a problem row with its player label, table and reason (no ids)', async () => {
    renderAt('/a');
    expect(await screen.findByText(/no score arrived/)).toBeInTheDocument();
    expect(screen.getByText('Krobs:')).toBeInTheDocument();
    expect(screen.getByText(/sent no score for it/)).toBeInTheDocument();
    expect(screen.getByText(/Castcade \(PC\)/)).toBeInTheDocument();
    expect(screen.getByText('Dates and times in America/Chicago')).toBeInTheDocument();
  });

  it('sends the URL filters to the server and toggles Problems only into the URL', async () => {
    renderAt('/a?player=krobs&tournament=t1');
    await screen.findByText(/no score arrived/);
    expect(mockedGet).toHaveBeenCalledWith('/rooms/r1/admin/activity?player=krobs&tournament=t1');
    fireEvent.click(screen.getByRole('button', { name: 'Problems only' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('problems=1'));
    await waitFor(() => expect(mockedGet).toHaveBeenCalledWith('/rooms/r1/admin/activity?player=krobs&tournament=t1&problems=1'));
  });

  it('super-admin: says dates are read per row in its room timezone', async () => {
    mockedGet.mockImplementation((url: string) => url.startsWith('/admin/activity/meta')
      ? Promise.resolve({ rooms: [], tournaments: [], timezone: 'America/Chicago' })
      : Promise.resolve({ rows: [ROW], nextBefore: null, timezone: 'America/Chicago' }));
    render(<MemoryRouter><ActivityTimeline mode="super" /></MemoryRouter>);
    expect(await screen.findByText("Dates and times use each row's room timezone (rows with no room: America/Chicago)"))
      .toBeInTheDocument();
    expect(screen.getByText(/^Room$/)).toBeInTheDocument();
  });

  it('applies the typed player filter on submit', async () => {
    renderAt('/a');
    await screen.findByText(/no score arrived/);
    fireEvent.change(screen.getByPlaceholderText('Name or alias'), { target: { value: 'Krobs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('?player=Krobs'));
  });
});
