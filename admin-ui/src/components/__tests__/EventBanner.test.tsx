import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import EventBanner from '../EventBanner';

/**
 * W30 (v2.194.0) - the banner leads with the TOURNAMENT and shows the room as
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
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

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

describe('EventBanner dismissal (W83)', () => {
  const STORE = 'arcaid_room_notices_dismissed:r1';
  const DAY = 24 * 60 * 60 * 1000;
  const stubEvents = (rows: unknown[]) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => rows }));
  const upcoming = {
    id: 'ev1', name: 'Friday Night Flip', format: 'event', is_active: 1, checkin_required: 0,
    rounds: [{ status: 'SCHEDULED', round_no: 1, name: 'Medieval Madness', scheduled_start_at: future(90), scheduled_end_at: future(120) }],
  };

  it('the X hides the card, stores its key, and does not navigate', async () => {
    render(
      <MemoryRouter initialEntries={['/wizard']}>
        <Routes>
          <Route path="/wizard" element={<EventBanner roomId="r1" roomSlug="wizard" />} />
          <Route path="/wizard/events/:id" element={<p>EVENT PAGE</p>} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Friday Night Flip');
    expect(screen.getByTestId('dismissible-notice').getAttribute('data-notice-key')).toBe('event:ev1:upcoming:round');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Friday Night Flip')).toBeNull();
    expect(screen.queryByText('EVENT PAGE')).toBeNull();
    expect(Object.keys(JSON.parse(localStorage.getItem(STORE) ?? '{}'))).toEqual(['event:ev1:upcoming:round']);
  });

  it('a dismissed upcoming event stays hidden, and re-appears once it goes live', async () => {
    localStorage.setItem(STORE, JSON.stringify({ 'event:ev1:upcoming:round': Date.now() }));
    const { unmount } = render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('Friday Night Flip')).toBeNull();
    unmount();

    stubEvents([{ ...upcoming, rounds: [{ ...upcoming.rounds[0], status: 'ACTIVE', scheduled_start_at: future(-5) }] }]);
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    expect(await screen.findByText('Friday Night Flip')).toBeInTheDocument();
    expect(screen.getByTestId('dismissible-notice').getAttribute('data-notice-key')).toBe('event:ev1:live:round');
  });

  it('re-appears when check-in opens (different key)', async () => {
    localStorage.setItem(STORE, JSON.stringify({ 'event:ev1:upcoming:round': Date.now() }));
    stubEvents([{ ...upcoming, checkin_required: 1 }]);
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    expect(await screen.findByText('Friday Night Flip')).toBeInTheDocument();
    expect(screen.getByTestId('dismissible-notice').getAttribute('data-notice-key')).toBe('event:ev1:upcoming:checkin');
  });

  it('a dismissal lasts 7 days', async () => {
    const t0 = Date.now();
    localStorage.setItem(STORE, JSON.stringify({ 'event:ev1:upcoming:round': t0 }));
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 6 * DAY);
    const { unmount } = render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('Friday Night Flip')).toBeNull();
    unmount();

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 8 * DAY);
    stubEvents([{ ...upcoming, rounds: [{ ...upcoming.rounds[0], scheduled_start_at: new Date(t0 + 9 * DAY).toISOString() }] }]);
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Friday Night Flip')).toBeInTheDocument());
  });

  it('wraps a long title instead of truncating it', async () => {
    render(<MemoryRouter><EventBanner roomId="r1" roomSlug="wizard" /></MemoryRouter>);
    const title = await screen.findByText('Friday Night Flip');
    expect(title.className).not.toMatch(/truncate/);
    expect(title.className).toMatch(/break-words/);
  });
});
