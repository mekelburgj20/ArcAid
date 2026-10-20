import { describe, it, expect } from 'vitest';
import { tournamentToFormState, type Tournament } from '../tournamentFormPayload';
import { defaultFormState, defaultFormStateFor, parseCadence } from '../../components/TournamentForm';

/**
 * Room default timezone (`ROOM_TIMEZONE`): the room's zone SEEDS new forms
 * and fills a saved cadence that carries no zone, but a cadence's own zone is
 * the per-tournament override and always wins.
 */

const row = (cadence: string): Tournament => ({
  id: 't1',
  name: 'Weekly',
  type: 'WG',
  mode: 'pinball',
  cadence,
  platform_rules: '{}',
  is_active: 1,
  display_order: 0,
  max_active_games: 1,
  cleanup_rule: '{"mode":"retain","count":0}',
  winner_picks: 1,
  auto_pick: 1,
  eligibility_days: 120,
  winner_pick_window_min: 60,
  runnerup_pick_window_min: 30,
});

describe('tournamentToFormState — room timezone fallback', () => {
  it('uses the room zone when the cadence carries none', () => {
    const s = tournamentToFormState(row(JSON.stringify({ cron: '0 22 * * 3' })), 'America/Los_Angeles');
    expect(s.schedule).toEqual({ cron: '0 22 * * 3', timezone: 'America/Los_Angeles' });
    expect(s.event.timezone).toBe('America/Los_Angeles');
  });

  it("keeps the cadence's own zone over the room zone", () => {
    const s = tournamentToFormState(row(JSON.stringify({ cron: '0 22 * * 3', timezone: 'America/New_York' })), 'America/Los_Angeles');
    expect(s.schedule.timezone).toBe('America/New_York');
    expect(s.event.timezone).toBe('America/New_York');
  });

  it('falls back to Chicago when no room zone is passed', () => {
    expect(tournamentToFormState(row('{}')).schedule.timezone).toBe('America/Chicago');
  });

  it('uses the room zone for an unparseable cadence', () => {
    expect(parseCadence('not json', 'Pacific/Honolulu')).toEqual({ cron: '0 0 * * *', timezone: 'Pacific/Honolulu' });
  });
});

describe('defaultFormStateFor', () => {
  it('seeds both the schedule and the event zone', () => {
    const s = defaultFormStateFor('Pacific/Honolulu');
    expect(s.schedule.timezone).toBe('Pacific/Honolulu');
    expect(s.event.timezone).toBe('Pacific/Honolulu');
    expect(s.schedule.cron).toBe(defaultFormState.schedule.cron);
  });

  it('does not mutate the shared default', () => {
    defaultFormStateFor('Pacific/Honolulu');
    expect(defaultFormState.schedule.timezone).toBe('America/Chicago');
    expect(defaultFormState.event.timezone).toBe('America/Chicago');
  });
});
