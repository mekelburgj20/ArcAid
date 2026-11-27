import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LiveRunsStrip from '../LiveRunsStrip';

function stub(body: unknown, ok = true) {
  const f = vi.fn().mockResolvedValue({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
  vi.stubGlobal('fetch', f);
  return f;
}
const renderStrip = () => render(
  <MemoryRouter><LiveRunsStrip roomId="room-1" slug="r" tournamentId="t-1" /></MemoryRouter>,
);

describe('LiveRunsStrip', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows one chip per active run linking to its recap', async () => {
    const f = stub({ runs: [{ game_id: 'g-1', game_name: 'Lost in Space', start_date: null, image_url: null }] });
    renderStrip();
    const link = await screen.findByRole('link', { name: /Lost in Space/ });
    expect(link).toHaveAttribute('href', '/r/tournaments/t-1?run=g-1&recap=1');
    expect(String(f.mock.calls[0]![0])).toBe('/api/rooms/room-1/tournaments/t-1/runs/live');
  });

  it('renders nothing when empty or failed', async () => {
    const f = stub({ runs: [] });
    const { container } = renderStrip();
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
