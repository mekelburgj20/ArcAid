import { describe, it, expect } from 'vitest';
import { toPayload, tournamentToFormState, type Tournament } from '../../lib/tournamentFormPayload';
import { defaultFormState } from '../../components/TournamentForm';

/**
 * Next-win disposition (ROADMAP, locked 2026-08-09) — `allow_dynasty`
 * round-trips through both the CREATE payload (`toPayload`, form state ->
 * API body) and the EDIT load path (`tournamentToFormState`, DB row -> form
 * state), the same two conversions every other tournament setting goes
 * through. `toPayload` feeds BOTH `handleCreate` and `handleEditSave`
 * directly, so covering it once covers both write paths.
 */

function mockTournamentRow(overrides: Partial<Tournament> = {}): Tournament {
  return {
    id: 't-1',
    name: 'Test Tournament',
    type: 'TT',
    mode: 'pinball',
    cadence: JSON.stringify({ cron: '0 0 * * *' }),
    platform_rules: '{}',
    is_active: 1,
    display_order: 0,
    max_active_games: 1,
    cleanup_rule: JSON.stringify({ mode: 'retain', count: 0 }),
    winner_picks: 1,
    auto_pick: 1,
    eligibility_days: 120,
    winner_pick_window_min: 60,
    runnerup_pick_window_min: 30,
    ...overrides,
  };
}

describe('allow_dynasty round-trip — create path (toPayload)', () => {
  it('defaults to true (CHECKED) matching the untouched form default', () => {
    const payload = toPayload(defaultFormState, { id: 'new-id', is_active: true });
    expect(payload.allow_dynasty).toBe(true);
  });

  it('carries a user-unchecked value through to the create/update payload', () => {
    const payload = toPayload({ ...defaultFormState, allowDynasty: false }, { id: 'new-id', is_active: true });
    expect(payload.allow_dynasty).toBe(false);
  });
});

describe('allow_dynasty round-trip — edit load path (tournamentToFormState)', () => {
  it('loads allow_dynasty=1 as allowDynasty=true', () => {
    const state = tournamentToFormState(mockTournamentRow({ allow_dynasty: 1 }));
    expect(state.allowDynasty).toBe(true);
  });

  it('loads allow_dynasty=0 as allowDynasty=false', () => {
    const state = tournamentToFormState(mockTournamentRow({ allow_dynasty: 0 }));
    expect(state.allowDynasty).toBe(false);
  });

  it('treats a missing allow_dynasty (pre-migration row) as ON, matching the DB default', () => {
    const row = mockTournamentRow();
    delete row.allow_dynasty;
    const state = tournamentToFormState(row);
    expect(state.allowDynasty).toBe(true);
  });

  it('a full edit-load -> re-save round trip preserves an explicit OFF', () => {
    const loaded = tournamentToFormState(mockTournamentRow({ allow_dynasty: 0 }));
    const saved = toPayload(loaded, { id: 't-1', is_active: true });
    expect(saved.allow_dynasty).toBe(false);
  });
});
