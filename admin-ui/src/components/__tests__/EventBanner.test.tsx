import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import EventBanner from '../EventBanner';

/**
 * W30 (v2.192.0) - the banner leads with the TOURNAMENT and shows the room as
 * its subtitle, so the room name is not mistaken for the event.
 */

const future = (min: number) => new Date(Date.now() + min * 60000).toISOString();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ([{
      id: 'ev1', name: 'Friday Night Flip', format: 'event', is_active: 1, checkin_required: 0,
      rounds: [{ status: 'SCHEDULED', round_no: 1, name: 'Medieval Madness', scheduled_start_at: future(90), scheduled_end_at: future(120) }],
    }]),
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('EventBanner (W30)', () => {
  it('names the tournament first and the room beneath it', async () => {
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" roomName="Arcaid Witness Demo" /></MemoryRouter>);
    expect(await screen.findByText('Friday Night Flip')).toBeInTheDocument();
    expect(screen.getByTestId('event-banner-sub').textContent).toMatch(/^in Arcaid Witness Demo · Round 1 starts/);
  });

  it('falls back to the plain detail line without a room name', async () => {
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    await screen.findByText('Friday Night Flip');
    expect(screen.getByTestId('event-banner-sub').textContent).toMatch(/^Round 1 starts/);
  });
});
