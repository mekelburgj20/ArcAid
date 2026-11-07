import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import TournamentFormFields, { defaultFormState, type TournamentFormState } from '../TournamentForm';
import { toPayload, tournamentToFormState, type Tournament } from '../../lib/tournamentFormPayload';

/**
 * E16 (v2.226.0) - the tournament form's Announcements setting:
 * Room defaults / Don't post to Discord / Customize per category, one row per
 * kind (Tournament posts, Pick prompts, Polls, Top-score posts), each Room
 * default / Don't post / a guild channel. A legacy specific catch-all channel
 * shows as Customize with a caption naming it.
 */

vi.mock('../../lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
}));

import { api } from '../../lib/api';
const mockedGet = vi.mocked(api.get);

const TOURNEYS = '3000000000000000001';
const SCORES = '3000000000000000002';
const LEGACY = '3000000000000000003';

function mockChannels(fail = false) {
  mockedGet.mockReset();
  mockedGet.mockImplementation((url: string) => {
    if (url.endsWith('/admin/discord/channels?forums=1')) {
      if (fail) return Promise.reject(new Error('Bot is not in this server'));
      return Promise.resolve({ channels: [
        { id: TOURNEYS, name: 'lu-tourneys', parent: 'LU HUB', type: 'text' },
        { id: SCORES, name: 'lu-glory', parent: 'LU HUB', type: 'forum' },
        { id: LEGACY, name: 'old-grind', parent: null, type: 'text' },
      ] });
    }
    return Promise.resolve([]);
  });
}

function Harness({ initial }: { initial?: Partial<TournamentFormState> }) {
  const [state, setState] = useState<TournamentFormState>({ ...defaultFormState, ...initial });
  return (
    <>
      <TournamentFormFields
        state={state}
        set={(field, value) => setState(s => ({ ...s, [field]: value }))}
        platforms={[]}
        roomId="r1"
      />
      <pre data-testid="payload">{JSON.stringify(toPayload(state))}</pre>
    </>
  );
}

const payload = () => JSON.parse(screen.getByTestId('payload').textContent || '{}');
const mode = () => screen.getByTestId('tournament-announce-mode') as HTMLSelectElement;
const row = (kind: string) => screen.getByTestId(`tournament-announce-${kind}`) as HTMLSelectElement;

beforeEach(() => mockChannels());

describe('TournamentForm — Announcements', () => {
  it('Room defaults: no catch-all, no per-kind entries, no rows shown', () => {
    render(<Harness />);
    expect(mode().value).toBe('default');
    expect(screen.queryByTestId('tournament-announce-routes')).toBeNull();
    expect(payload()).toMatchObject({ discord_channel_id: '', discord_announce_routes: '' });
  });

  it("Don't post to Discord: catch-all 'none', per-kind cleared", () => {
    render(<Harness initial={{ announceRoutes: { picks: TOURNEYS } }} />);
    fireEvent.change(mode(), { target: { value: 'none' } });
    expect(mode().value).toBe('none');
    expect(screen.queryByTestId('tournament-announce-routes')).toBeNull();
    expect(payload()).toMatchObject({ discord_channel_id: 'none', discord_announce_routes: '' });
  });

  it('Customize with a per-row channel', async () => {
    render(<Harness />);
    fireEvent.change(mode(), { target: { value: 'custom' } });
    expect(screen.getByTestId('tournament-announce-routes')).toBeInTheDocument();
    for (const k of ['tournament', 'picks', 'polls', 'scores']) expect(row(k).value).toBe('');
    expect(screen.getByLabelText('Top-score posts')).toBe(row('scores'));
    expect(await within(row('scores')).findByRole('option', { name: '#lu-glory (forum)' })).toBeInTheDocument();
    fireEvent.change(row('scores'), { target: { value: SCORES } });
    expect(mode().value).toBe('custom');
    expect(payload()).toMatchObject({
      discord_channel_id: '',
      discord_announce_routes: JSON.stringify({ version: 1, routes: { scores: SCORES } }),
    });
  });

  it("Customize with a per-row Don't post", async () => {
    render(<Harness />);
    fireEvent.change(mode(), { target: { value: 'custom' } });
    await within(row('tournament')).findByRole('option', { name: '#lu-tourneys' });
    fireEvent.change(row('picks'), { target: { value: 'none' } });
    fireEvent.change(row('tournament'), { target: { value: TOURNEYS } });
    expect(payload().discord_announce_routes)
      .toBe(JSON.stringify({ version: 1, routes: { tournament: TOURNEYS, picks: 'none' } }));
    // Back to Room defaults clears every entry.
    fireEvent.change(mode(), { target: { value: 'default' } });
    expect(payload()).toMatchObject({ discord_channel_id: '', discord_announce_routes: '' });
  });

  it('a legacy specific catch-all channel shows as Customize with a caption naming it', async () => {
    const t = { discord_channel_id: LEGACY, discord_announce_routes: null } as Partial<Tournament>;
    const seeded = tournamentToFormState({
      id: 't1', name: 'Old', type: 'OG', mode: 'pinball', cadence: '{}', platform_rules: '{}',
      is_active: 1, display_order: 0, max_active_games: 1, cleanup_rule: '{}', winner_picks: 1,
      auto_pick: 1, eligibility_days: 120, winner_pick_window_min: 60, runnerup_pick_window_min: 30,
      ...t,
    } as Tournament, 'America/Chicago');
    render(<Harness initial={seeded} />);
    expect(mode().value).toBe('custom');
    for (const k of ['tournament', 'picks', 'polls', 'scores']) expect(row(k).value).toBe('');
    const caption = screen.getByTestId('tournament-announce-legacy');
    expect(await within(caption).findByText(/#old-grind/)).toBeInTheDocument();
    expect(caption).toHaveTextContent('Pick a channel per row to override it, or choose Room defaults to clear it.');
    expect(payload()).toMatchObject({ discord_channel_id: LEGACY, discord_announce_routes: '' });
  });

  it('the stored routes seed the rows on edit', async () => {
    const seeded = tournamentToFormState({
      id: 't1', name: 'X', type: 'X', mode: 'pinball', cadence: '{}', platform_rules: '{}',
      is_active: 1, display_order: 0, max_active_games: 1, cleanup_rule: '{}', winner_picks: 1,
      auto_pick: 1, eligibility_days: 120, winner_pick_window_min: 60, runnerup_pick_window_min: 30,
      discord_channel_id: '',
      discord_announce_routes: JSON.stringify({ version: 1, routes: { scores: 'none', polls: 'garbage' } }),
    } as Tournament, 'America/Chicago');
    expect(seeded.announceRoutes).toEqual({ scores: 'none' });
    render(<Harness initial={seeded} />);
    expect(mode().value).toBe('custom');
    expect(row('scores').value).toBe('none');
    expect(screen.queryByTestId('tournament-announce-legacy')).toBeNull();
  });

  it('when the channel list fails, a stored raw id stays editable through "A specific channel ID…"', async () => {
    mockChannels(true);
    render(<Harness initial={{ announceRoutes: { tournament: TOURNEYS } }} />);
    expect(await screen.findByText(/Could not load the server/)).toBeInTheDocument();
    expect(row('tournament').value).toBe('__id__');
    const input = screen.getByTestId('tournament-announce-tournament-id') as HTMLInputElement;
    expect(input.value).toBe(TOURNEYS);
    fireEvent.change(row('polls'), { target: { value: '__id__' } });
    fireEvent.change(screen.getByTestId('tournament-announce-polls-id'), { target: { value: SCORES } });
    expect(payload().discord_announce_routes)
      .toBe(JSON.stringify({ version: 1, routes: { tournament: TOURNEYS, polls: SCORES } }));
  });
});
