import {
  parseCadence,
  parsePlatformRules,
  parseCleanupRule,
  type TournamentFormState,
} from '../components/TournamentForm';
import { DEFAULT_TIMEZONE } from './timezone';
import { defaultEventState, utcIsoToWallTime, wallTimeToUtcIso } from './eventTime';
import { seasonPayload, seasonStateFromRow } from './seasonForm';
import { pollPayload, pollStateFromRow } from './pollForm';
import { integrityModeFromRow, integrityPayload, sanctionedRulesFromRow } from './integrityForm';

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
  /** Season block (migration 181, docs/season-format-plan.md §3.1). NULL table count = not a season. */
  season_table_count?: number | null;
  season_ranking_group_id?: string | null;
  season_paused_at?: string | null;
  season_finished_at?: string | null;
  /** Pick by poll (migration 182, ADR 0026) — a rotation method, independent of seasons. */
  poll_picks?: number | null;
  poll_opens_before_h?: number | null;
  poll_closes_before_h?: number | null;
  poll_tie_rule?: string | null;
  /** Compact progress, embedded for season and poll-picked rows only. */
  season?: SeasonSummary;
  /** Integrity mode (migration for v2.165.0, ADR 0027). null / absent = open. */
  integrity_mode?: 'open' | 'sanctioned' | null;
  /** The stored Sanctioned rule set as a JSON string; null = the defaults. */
  sanctioned_rules?: string | null;
  /** Limited attempts (migration 186, ADR 0029). null = unlimited. */
  max_attempts?: number | null;
  /** W38 (migration 193) — players press Start attempts first. 1 = on. */
  require_attempt_start?: number | null;
  /** W39 (migration 194) — who may play. Absent = 'members'. */
  entry_mode?: 'members' | 'invited' | null;
  /** W39 — the self-serve ways onto the roster, as stored JSON `{link, request}`. */
  entry_methods?: string | null;
  /** Flagged witness scores in an event (migration 188, W20). Absent = 'prevent'. */
  witness_flag_mode?: 'prevent' | 'flag' | null;
}

/** `GET /:roomId/tournaments` → `season` sub-object on season / poll-picked rows. */
export interface SeasonSummary {
  poll_picks: boolean;
  /** null for a poll-only (season-less) tournament. */
  tables_done: number | null;
  table_count: number | null;
  paused: boolean;
  finished: boolean;
  open_poll_id: string | null;
}

/** True when the row is a Season (a rotation tournament with a season block). */
export function isSeasonTournament(t: Pick<Tournament, 'format' | 'season_table_count'>): boolean {
  return t.format !== 'event' && t.season_table_count != null;
}

/** True when the row's tables are picked by a community poll (ADR 0026). */
export function isPollTournament(t: Pick<Tournament, 'format' | 'poll_picks'>): boolean {
  return t.format !== 'event' && !!t.poll_picks;
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
  // Pick by poll forces these server-side (TournamentService, ADR 0026);
  // sending the forced values keeps the request honest about what will be
  // stored. A Season alone forces nothing.
  const pollOn = !isEvent && state.poll.enabled;
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
          scheduledEndAt: wallTimeToUtcIso(r.endLocal, tz),
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
    max_active_games: pollOn ? 1 : state.maxActiveGames,
    cleanup_rule: state.cleanupRule,
    winner_picks: pollOn ? false : state.winnerPicks,
    auto_pick: pollOn ? false : state.autoPick,
    eligibility_days: pollOn ? 0 : state.eligibilityDays,
    winner_pick_window_min: state.winnerPickWindowMin,
    runnerup_pick_window_min: state.runnerupPickWindowMin,
    allow_dynasty: state.allowDynasty,
    // Season + Pick by poll: rotation only. `season_table_count: null` /
    // `poll_picks: false` switch them off; an event omits the keys entirely
    // (the server refuses either on an event).
    ...(isEvent ? {} : seasonPayload(state.season)),
    ...(isEvent ? {} : pollPayload(state.poll)),
    // Integrity mode + Sanctioned rules, both formats. The rules are sent in
    // BOTH modes so a tuned set survives a switch to Open play and back.
    ...integrityPayload(state.integrityMode, state.sanctionedRules),
    // Limited attempts (ADR 0029): always sent; null = unlimited, so blanking
    // the field switches the limit off.
    max_attempts: state.maxAttempts ?? null,
    // W38: always sent; only a limited tournament reads it.
    require_attempt_start: state.requireAttemptStart,
    // W39: always sent, both formats. The methods ride along in members mode
    // too, so a tuned choice survives a switch to Room members and back.
    entry_mode: state.entryMode,
    entry_methods: { link: state.entryLink, request: state.entryRequest },
    // W20: always sent; only an event reads it.
    witness_flag_mode: state.witnessFlagMode,
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

/** W39 — the stored `entry_methods` JSON; anything unreadable reads as both off. */
function entryMethodsFromRow(raw: string | null | undefined): { link: boolean; request: boolean } {
  try {
    const o = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    return { link: o.link === true, request: o.request === true };
  } catch {
    return { link: false, request: false };
  }
}

/**
 * Convert Tournament DB row to form state. `roomTimezone` fills a cadence that
 * carries no zone; a saved zone is the tournament's own override and wins.
 */
export function tournamentToFormState(t: Tournament, roomTimezone: string = DEFAULT_TIMEZONE): TournamentFormState {
  const format = t.format === 'event' ? 'event' as const : 'rotation' as const;
  // An event's timezone lives in its cadence — the ONE thing an event cadence
  // still carries.
  const tz = parseCadence(t.cadence, roomTimezone).timezone;
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
        ? t.rounds!.map(r => ({
          roundNo: r.round_no,
          gameName: r.name,
          startLocal: utcIsoToWallTime(r.scheduled_start_at, tz),
          endLocal: utcIsoToWallTime(r.scheduled_end_at, tz),
        }))
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
    schedule: parseCadence(t.cadence, roomTimezone),
    season: seasonStateFromRow(t),
    poll: pollStateFromRow(t),
    integrityMode: integrityModeFromRow(t),
    sanctionedRules: sanctionedRulesFromRow(t.sanctioned_rules),
    maxAttempts: typeof t.max_attempts === 'number' && t.max_attempts >= 1 ? t.max_attempts : null,
    requireAttemptStart: t.require_attempt_start === 1,
    entryMode: t.entry_mode === 'invited' ? 'invited' : 'members',
    entryLink: entryMethodsFromRow(t.entry_methods).link,
    entryRequest: entryMethodsFromRow(t.entry_methods).request,
    witnessFlagMode: t.witness_flag_mode === 'flag' ? 'flag' : 'prevent',
  };
}
