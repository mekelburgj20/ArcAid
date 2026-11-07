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

/**
 * G15 (v2.228.0) - every row opens an inline details panel: the server's
 * curated facts, an admin edit's change table (before/after, a secret as
 * "changed"), past rows' recorded setting names with their note, and the raw
 * JSON only when the server sent it (super-admin).
 */
const SETTINGS_ROW = {
  ...ROW, id: 8, category: 'admin', event_type: 'settings_change', severity: 'info', player: null,
  actor: 'GamerDad89', device: null, table_name: null,
  summary: 'GamerDad89 changed 3 settings: Room timezone, Slash-command policy, iScored password',
  reasons: [],
  detail: {
    facts: [],
    changes: [
      { key: 'ROOM_TIMEZONE', label: 'Room timezone', from: 'America/Chicago', to: 'America/New_York' },
      { key: 'DISCORD_COMMAND_POLICY', label: 'Slash-command policy', from: null, to: '{"version":1,"commands":{"submit-score":"members"}}' },
      { key: 'ISCORED_PASSWORD', label: 'iScored password', secret: true },
    ],
  },
};
const PAST_ROW = {
  ...SETTINGS_ROW, id: 9, summary: 'GamerDad89 saved 2 settings: Theme, Kiosk mode',
  detail: {
    facts: [], recordedKeys: ['Theme', 'Kiosk mode'],
    notes: ["Values weren't recorded before v2.228.0; only the setting names were.",
      'A full Save sends every setting on the page, so this list may include settings that did not change.'],
  },
};

describe('ActivityTimeline details panel', () => {
  beforeEach(() => {
    mockedGet.mockImplementation((url: string) => url.startsWith('/rooms/r1/admin/activity/meta')
      ? Promise.resolve({ tournaments: [], timezone: 'America/Chicago' })
      : Promise.resolve({ rows: [SETTINGS_ROW, PAST_ROW, ROW], nextBefore: null, timezone: 'America/Chicago' }));
  });

  it('expands a settings row into a change table; a secret shows as changed, JSON is pretty-printed', async () => {
    renderAt('/a');
    const toggle = (await screen.findByText(/changed 3 settings/)).closest('button')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const table = screen.getByRole('table');
    expect(table).toHaveTextContent('Room timezone');
    expect(table).toHaveTextContent('America/Chicago');
    expect(table).toHaveTextContent('America/New_York');
    expect(table).toHaveTextContent('(not set)');
    expect(table).toHaveTextContent(/iScored password\s*Changed \(secret; values are never recorded\)/);
    // The command policy reads over several lines, not one giant line.
    const pretty = screen.getByText((_, el) => el?.tagName === 'PRE' && (el.textContent ?? '').includes('"submit-score": "members"'));
    expect(pretty.textContent).toContain('\n');
    const panel = screen.getByRole('region', { name: 'Activity details' });
    expect(panel).toHaveTextContent(/Admin\s*GamerDad89/);
    expect(panel).toHaveTextContent('When');
    // No raw section for a room admin.
    expect(screen.queryByText(/Raw/)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('a past row lists the recorded setting names with the note', async () => {
    renderAt('/a');
    fireEvent.click((await screen.findByText(/saved 2 settings/)).closest('button')!);
    expect(screen.getByText('Settings saved')).toBeInTheDocument();
    expect(screen.getByText('Kiosk mode')).toBeInTheDocument();
    expect(screen.getByText(/Values weren't recorded before v2\.228\.0/)).toBeInTheDocument();
    expect(screen.getByText(/may include settings that did not change/)).toBeInTheDocument();
  });

  it('super-admin rows carry a collapsed raw section', async () => {
    mockedGet.mockImplementation((url: string) => url.startsWith('/admin/activity/meta')
      ? Promise.resolve({ rooms: [], tournaments: [], timezone: 'America/Chicago' })
      : Promise.resolve({
        rows: [{ ...ROW, detail: { facts: [{ label: 'Table', value: 'Twilight Zone' }] }, details: { durationSec: 2280 } }],
        nextBefore: null, timezone: 'America/Chicago',
      }));
    render(<MemoryRouter><ActivityTimeline mode="super" /></MemoryRouter>);
    fireEvent.click((await screen.findByText(/no score arrived/)).closest('button')!);
    expect(screen.getByText('Twilight Zone')).toBeInTheDocument();
    expect(screen.getByText('Raw (super-admin)')).toBeInTheDocument();
    expect(screen.getByText(/"durationSec": 2280/)).toBeInTheDocument();
  });
});
