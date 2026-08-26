import {
  parseCadence,
  parsePlatformRules,
  parseCleanupRule,
  type TournamentFormState,
} from '../components/TournamentForm';
import { addMinutes, defaultEventState, durationMinutes, utcIsoToWallTime, wallTimeToUtcIso } from './eventTime';

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
  /** v2.135.0 (ADR 0017). Absent on rows written before the migration = rotation. */
  format?: string;
  checkin_opens_at?: string | null;
  checkin_required?: number;
  aggregate_method?: string;
  min_elapsed_sec?: number | null;
  end_grace_sec?: number | null;
  event_finished_at?: string | null;
  /** P7 — the AtGames private tournament this event reads its scores from. */
  atgames_tournament_id?: string | null;
  /** The code players type at the cabinet to join it. */
  atgames_invite_code?: string | null;
  /** Embedded by `GET /:roomId/tournaments` for event rows only. */
  rounds?: EventRoundRow[];
}

/** A round as `GET /:roomId/tournaments` and `EventService.getRounds` ship it. */
export interface EventRoundRow {
  id: string;
  name: string;
  status: string;
  round_no: number;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

/** Rounds the server will refuse to change (`ROUND_LOCKED`), so the form greys them out. */
export function lockedRoundNumbers(t: Tournament): number[] {
  return (t.rounds ?? []).filter(r => r.status !== 'SCHEDULED').map(r => r.round_no);
}

/**
 * Convert form state to API payload.
 *
 * The two formats emit deliberately different cadences. A rotation sends its
 * cron; an EVENT sends `{timezone}` with NO cron, because a cron would hand it
 * to `Scheduler.scheduleTournament` and `runMaintenance` would rotate the
 * rounds out from under their own schedule. The server rejects the wrong
 * combination either way, but emitting it correctly here means an admin never
 * sees that error.
 *
 * Round times are entered as wall-clock in the event's timezone and converted
 * to UTC here — see `lib/eventTime.ts` for why that conversion is not a
 * one-liner.
 */
export function toPayload(state: TournamentFormState, extra: Record<string, any> = {}) {
  const isEvent = state.format === 'event';
  const tz = state.event.timezone;
  return {
    name: state.name,
    type: state.tag.trim().toUpperCase(),
    mode: state.mode,
    format: state.format,
    cadence: isEvent
      ? { autoRotate: true, autoLock: true, timezone: tz }
      : { cron: state.schedule.cron, autoRotate: true, autoLock: true, timezone: state.schedule.timezone },
    ...(isEvent ? {
      event: {
        rounds: state.event.rounds.map(r => ({
          roundNo: r.roundNo,
          gameName: r.gameName.trim(),
          scheduledStartAt: wallTimeToUtcIso(r.startLocal, tz),
          scheduledEndAt: wallTimeToUtcIso(addMinutes(r.startLocal, r.durationMin), tz),
        })),
        checkinOpensAt: state.event.checkinOpensLocal
          ? wallTimeToUtcIso(state.event.checkinOpensLocal, tz)
          : null,
        checkinRequired: state.event.checkinRequired,
        aggregateMethod: state.event.aggregateMethod,
        // 0 means "no badge" in the form; the API wants null for that.
        minElapsedSec: state.event.minElapsedSec > 0 ? state.event.minElapsedSec : null,
        endGraceSec: state.event.endGraceSec,
      },
    } : {}),
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
  const format = t.format === 'event' ? 'event' as const : 'rotation' as const;
  // An event's timezone lives in its cadence — the ONE thing an event cadence
  // still carries.
  const tz = parseCadence(t.cadence).timezone;
  return {
    name: t.name,
    tag: t.type,
    mode: t.mode || 'pinball',
    format,
    event: {
      ...defaultEventState,
      timezone: tz,
      checkinOpensLocal: utcIsoToWallTime(t.checkin_opens_at, tz),
      checkinRequired: t.checkin_required !== 0,
      aggregateMethod: (t.aggregate_method as 'best' | 'average' | 'sum') || 'best',
      minElapsedSec: t.min_elapsed_sec ?? 0,
      endGraceSec: t.end_grace_sec ?? 60,
      rounds: (t.rounds ?? []).length > 0
        ? t.rounds!.map(r => {
          const startLocal = utcIsoToWallTime(r.scheduled_start_at, tz);
          return {
            roundNo: r.round_no,
            gameName: r.name,
            startLocal,
            durationMin: durationMinutes(startLocal, utcIsoToWallTime(r.scheduled_end_at, tz)) ?? 30,
          };
        })
        : [...defaultEventState.rounds],
    },
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
