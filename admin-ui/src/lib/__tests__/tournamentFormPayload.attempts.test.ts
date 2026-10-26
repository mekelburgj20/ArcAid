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

describe('entry setting in the tournament form (W39, ADR 0033 §6)', () => {
  it('a new tournament is open to room members, both self-serve methods off, always sent', () => {
    expect(defaultFormState).toMatchObject({ entryMode: 'members', entryLink: false, entryRequest: false });
    expect(toPayload(defaultFormState, { id: 'new', is_active: true })).toMatchObject({
      entry_mode: 'members', entry_methods: { link: false, request: false },
    });
  });

  it('an invite-only row loads and saves back unchanged; unreadable methods read as off', () => {
    const state = tournamentToFormState(row({ entry_mode: 'invited', entry_methods: '{"link":true,"request":false}' }));
    expect(state).toMatchObject({ entryMode: 'invited', entryLink: true, entryRequest: false });
    expect(toPayload(state, { id: 't-1', is_active: true })).toMatchObject({
      entry_mode: 'invited', entry_methods: { link: true, request: false },
    });
    expect(tournamentToFormState(row({ entry_methods: 'not json' }))).toMatchObject({ entryMode: 'members', entryLink: false, entryRequest: false });
  });
});

describe('require_attempt_start in the tournament form (W38, ADR 0033 §4)', () => {
  it('is off for a new tournament and always sent', () => {
    expect(defaultFormState.requireAttemptStart).toBe(false);
    expect(toPayload(defaultFormState, { id: 'new', is_active: true })).toMatchObject({ require_attempt_start: false });
  });

  it('a stored 1 loads as on and saves back as true; 0 / absent load as off', () => {
    const on = tournamentToFormState(row({ max_attempts: 5, require_attempt_start: 1 }));
    expect(on.requireAttemptStart).toBe(true);
    expect(toPayload(on, { id: 't-1', is_active: true })).toMatchObject({ require_attempt_start: true });
    expect(tournamentToFormState(row({ require_attempt_start: 0 })).requireAttemptStart).toBe(false);
    expect(tournamentToFormState(row()).requireAttemptStart).toBe(false);
  });
});
