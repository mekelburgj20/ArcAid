import { describe, it, expect } from 'vitest';
import { toPayload, tournamentToFormState, type Tournament } from '../tournamentFormPayload';
import { defaultFormState } from '../../components/TournamentForm';
import { defaultSanctionedRules, sanctionedRulesFromRow, getIntegrityErrors } from '../integrityForm';

/**
 * Integrity mode (v2.166.0, ADR 0027) through both conversions: the stored
 * row (`integrity_mode` + `sanctioned_rules` JSON string) → form state →
 * create / update body.
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

const STORED = {
  require_named_table: true,
  require_stock_physics: false,
  require_factory_adjustments: true,
  adjustments_allowed: ['Free Play', 'Balls Per Game'],
  require_known_build: true,
  allow_nightly_builds: false,
  blessed_build_hashes: ['b'.repeat(64)],
  min_tilt_sensitivity: 350,
  max_accel_gain: 120,
  require_nudge_filter: true,
};

describe('tournamentToFormState — integrity columns', () => {
  it('a row without the columns is Open play with the default rules', () => {
    const state = tournamentToFormState(row());
    expect(state.integrityMode).toBe('open');
    expect(state.sanctionedRules).toEqual(defaultSanctionedRules);
  });

  it('null columns are Open play with the default rules', () => {
    const state = tournamentToFormState(row({ integrity_mode: null, sanctioned_rules: null }));
    expect(state.integrityMode).toBe('open');
    expect(state.sanctionedRules).toEqual(defaultSanctionedRules);
  });

  it('reads a stored Sanctioned tournament, lists as text', () => {
    const state = tournamentToFormState(row({ integrity_mode: 'sanctioned', sanctioned_rules: JSON.stringify(STORED) }));
    expect(state.integrityMode).toBe('sanctioned');
    expect(state.sanctionedRules).toEqual({
      requireNamedTable: true,
      requireStockPhysics: false,
      requireFactoryAdjustments: true,
      adjustmentsAllowed: 'Free Play, Balls Per Game',
      requireKnownBuild: true,
      allowNightlyBuilds: false,
      blessedBuildHashes: 'b'.repeat(64),
      minTiltSensitivity: 350,
      maxAccelGain: 120,
      requireNudgeFilter: true,
    });
  });

  it('tolerates garbage, partial objects and wrong types', () => {
    expect(sanctionedRulesFromRow('{not json')).toEqual(defaultSanctionedRules);
    expect(sanctionedRulesFromRow('[1,2]')).toEqual(defaultSanctionedRules);
    expect(sanctionedRulesFromRow(JSON.stringify({ min_tilt_sensitivity: '650', require_nudge_filter: 'yes', adjustments_allowed: 'Free Play' })))
      .toEqual({ ...defaultSanctionedRules, minTiltSensitivity: 650 });
    // An empty stored list is an empty list, not the default.
    expect(sanctionedRulesFromRow({ adjustments_allowed: [] }).adjustmentsAllowed).toBe('');
    expect(sanctionedRulesFromRow({ max_accel_gain: 9999 }).maxAccelGain).toBe(400);
  });
});

describe('toPayload — integrity block', () => {
  it('the untouched form sends Open play and the full default rule set', () => {
    const p = toPayload(defaultFormState, { id: 'new', is_active: true });
    expect(p.integrity_mode).toBe('open');
    expect(p.sanctioned_rules).toEqual({
      require_named_table: true,
      require_stock_physics: true,
      require_factory_adjustments: true,
      adjustments_allowed: ['Free Play'],
      require_known_build: true,
      allow_nightly_builds: true,
      blessed_build_hashes: [],
      min_tilt_sensitivity: 300,
      max_accel_gain: 150,
      require_nudge_filter: false,
    });
  });

  it('row → state → payload round-trips a Sanctioned tournament', () => {
    const loaded = tournamentToFormState(row({ integrity_mode: 'sanctioned', sanctioned_rules: JSON.stringify(STORED) }));
    const saved = toPayload(loaded, { id: 't-1', is_active: true });
    expect(saved.integrity_mode).toBe('sanctioned');
    expect(saved.sanctioned_rules).toEqual(STORED);
    expect(getIntegrityErrors(loaded.integrityMode, loaded.sanctionedRules)).toEqual([]);
  });

  it('an event carries the block too', () => {
    const loaded = tournamentToFormState(row({ format: 'event', integrity_mode: 'sanctioned', sanctioned_rules: JSON.stringify(STORED) }));
    const saved = toPayload(loaded, { id: 't-1', is_active: true });
    expect(saved.integrity_mode).toBe('sanctioned');
    expect(saved.sanctioned_rules).toEqual(STORED);
  });
});
