import { describe, it, expect } from 'vitest';
import { toPayload, tournamentToFormState, type Tournament } from '../tournamentFormPayload';
import { defaultFormState } from '../../components/TournamentForm';

/**
 * Limited attempts (v2.167.0, ADR 0029): `max_attempts` round-trips through
 * row → form state → body, and the body ALWAYS carries it (null = unlimited),
 * so blanking the field switches the limit off on the server.
 */

function row(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't-1', name: 'Test', type: 'TT', mode: 'pinball',
    cadence: JSON.stringify({ cron: '0 0 * * *' }),
    platform_rules: '{}', is_active: 1, display_order: 0, max_active_games: 1,
    cleanup_rule: JSON.stringify({ mode: 'retain', count: 0 }),
    winner_picks: 1, auto_pick: 1, eligibility_days: 120,
    winner_pick_window_min: 60, runnerup_pick_window_min: 30,
    ...overrides,
  };
}

describe('max_attempts in the tournament form', () => {
  it('a new tournament is unlimited and says so explicitly', () => {
    expect(defaultFormState.maxAttempts).toBeNull();
    expect(toPayload(defaultFormState, { id: 'new', is_active: true })).toMatchObject({ max_attempts: null });
  });

  it('a stored limit loads and saves back unchanged', () => {
    const state = tournamentToFormState(row({ max_attempts: 5 }));
    expect(state.maxAttempts).toBe(5);
    expect(toPayload(state, { id: 't-1', is_active: true })).toMatchObject({ max_attempts: 5 });
  });

  it('a row without the column (or null) is unlimited', () => {
    expect(tournamentToFormState(row()).maxAttempts).toBeNull();
    expect(tournamentToFormState(row({ max_attempts: null })).maxAttempts).toBeNull();
  });

  it('blanking the field sends null so the server switches the limit off', () => {
    const state = { ...tournamentToFormState(row({ max_attempts: 3 })), maxAttempts: null };
    expect(toPayload(state, { id: 't-1', is_active: true })).toHaveProperty('max_attempts', null);
  });
});
