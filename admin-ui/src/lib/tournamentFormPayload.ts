import {
  parseCadence,
  parsePlatformRules,
  parseCleanupRule,
  type TournamentFormState,
} from '../components/TournamentForm';

/**
 * Plain functions shared between the Tournaments admin page's create and
 * edit flows. Split out of `pages/Tournaments.tsx` (which default-exports a
 * component) so these stay import-anywhere — colocating them there trips
 * `react-refresh/only-export-components` (Vite fast-refresh requires a
 * component file to export ONLY components).
 */

export interface Tournament {
  id: string;
  name: string;
  type: string;
  mode: string;
  cadence: string;
  platform_rules: string;
  guild_id?: string;
  discord_channel_id?: string;
  discord_role_id?: string;
  is_active: number;
  display_order: number;
  max_active_games: number;
  cleanup_rule: string;
  winner_picks: number;
  auto_pick: number;
  eligibility_days: number;
  winner_pick_window_min: number;
  runnerup_pick_window_min: number;
  /** Next-win disposition (ROADMAP, locked 2026-08-09). Absent on a row from
   *  before the migration — treated as ON (matches the DB default of 1),
   *  same `!== 0` pattern as `winner_picks`/`auto_pick` below. */
  allow_dynasty?: number;
}

/** Convert form state to API payload */
export function toPayload(state: TournamentFormState, extra: Record<string, any> = {}) {
  return {
    name: state.name,
    type: state.tag.trim().toUpperCase(),
    mode: state.mode,
    cadence: { cron: state.schedule.cron, autoRotate: true, autoLock: true, timezone: state.schedule.timezone },
    platform_rules: state.platformRules,
    discord_channel_id: state.channel,
    display_order: state.displayOrder,
    max_active_games: state.maxActiveGames,
    cleanup_rule: state.cleanupRule,
    winner_picks: state.winnerPicks,
    auto_pick: state.autoPick,
    eligibility_days: state.eligibilityDays,
    winner_pick_window_min: state.winnerPickWindowMin,
    runnerup_pick_window_min: state.runnerupPickWindowMin,
    allow_dynasty: state.allowDynasty,
    // is_active is intentionally NOT hardcoded here. `extra` is spread last, so
    // each caller supplies it: handleCreate passes `is_active: true`;
    // handleEditSave passes the row's current value so editing a paused
    // tournament does not silently resume it (the central S7 bug). The
    // dedicated PATCH .../active endpoint is the only path that flips it.
    guild_id: '',
    discord_role_id: '',
    ...extra,
  };
}

/** Convert Tournament DB row to form state */
export function tournamentToFormState(t: Tournament): TournamentFormState {
  return {
    name: t.name,
    tag: t.type,
    mode: t.mode || 'pinball',
    channel: t.discord_channel_id || '',
    displayOrder: t.display_order || 0,
    maxActiveGames: t.max_active_games || 1,
    winnerPicks: t.winner_picks !== 0,
    autoPick: t.auto_pick !== 0,
    eligibilityDays: t.eligibility_days ?? 120,
    winnerPickWindowMin: t.winner_pick_window_min ?? 60,
    runnerupPickWindowMin: t.runnerup_pick_window_min ?? 30,
    allowDynasty: t.allow_dynasty !== 0,
    platformRules: parsePlatformRules(t.platform_rules),
    cleanupRule: parseCleanupRule(t.cleanup_rule),
    schedule: parseCadence(t.cadence),
  };
}
