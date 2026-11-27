import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RoomRecordsSection from '../RoomRecordsSection';

afterEach(() => { vi.unstubAllGlobals(); });

const renderIt = () => render(
  <MemoryRouter>
    <RoomRecordsSection roomId="room-1" slug="rtx" />
  </MemoryRouter>,
);

describe('RoomRecordsSection', () => {
  it('shows an empty state, not an endless Loading, when the read is refused (403)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({}) })) as unknown as typeof fetch);
    renderIt();
    expect(await screen.findByText('No records available')).toBeInTheDocument();
    expect(screen.queryByText(/Loading the records/)).not.toBeInTheDocument();
  });

  it('says no records yet for an empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ records: [], players: [] }) })) as unknown as typeof fetch);
    renderIt();
    expect(await screen.findByText('No records yet')).toBeInTheDocument();
  });
});
