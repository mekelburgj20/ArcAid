/**
 * Season format (docs/season-format-plan.md §3.1, §8.1) — the pure half of the
 * tournament form's "Season" section: its state, its defaults, the client-side
 * mirror of the server's validation, and the plain-language poll-timing echo.
 *
 * Kept out of `components/TournamentForm.tsx` so the form file keeps exporting
 * components (react-refresh) and so these stay unit-testable without a render.
 */

export type SeasonTieRule = 'admin' | 'random' | 'first_nominated';
export type SeasonTieFallback = 'random' | 'first_nominated';

export interface SeasonFormState {
  /** Off = not a season (`season_table_count: null` on save). */
  enabled: boolean;
  tableCount: number;
  pointsTop: number;
  opensBeforeH: number;
  closesBeforeH: number;
  tieRule: SeasonTieRule;
  tieFallback: SeasonTieFallback;
}

export const defaultSeasonState: SeasonFormState = {
  enabled: false,
  tableCount: 12,
  pointsTop: 50,
  opensBeforeH: 96,
  closesBeforeH: 3,
  tieRule: 'admin',
  tieFallback: 'random',
};

/** The Zod cap on both offsets (`24 * 32` h — Discord's 32-day poll ceiling). */
export const SEASON_MAX_OFFSET_H = 24 * 32;

export const TIE_RULE_LABEL: Record<SeasonTieRule, string> = {
  admin: 'Admin decides (fallback applies until then)',
  random: 'Random pick among the tied',
  first_nominated: 'First nominated wins',
};

export const TIE_FALLBACK_LABEL: Record<SeasonTieFallback, string> = {
  random: 'Random pick among the tied',
  first_nominated: 'First nominated wins',
};

/**
 * Client-side mirror of `resolveSeason` in `src/services/TournamentService.ts`
 * and the Zod season block in `src/api/schemas.ts`. Empty when the season is
 * off or valid. The server re-validates the merged block either way.
 */
export function getSeasonErrors(season: SeasonFormState, cron: string | undefined): string[] {
  if (!season.enabled) return [];
  const errs: string[] = [];
  const isInt = (n: number) => Number.isInteger(n);
  if (!isInt(season.tableCount) || season.tableCount < 1 || season.tableCount > 200) {
    errs.push('A season must have between 1 and 200 tables.');
  }
  if (!isInt(season.pointsTop) || season.pointsTop < 1 || season.pointsTop > 1000) {
    errs.push('Points for 1st must be between 1 and 1000.');
  }
  if (!isInt(season.closesBeforeH) || season.closesBeforeH < 1) {
    errs.push('The poll must close at least 1 hour before the rotation (Discord\'s shortest poll is 1 hour).');
  }
  if (!isInt(season.opensBeforeH) || season.opensBeforeH <= season.closesBeforeH) {
    errs.push('The poll must open earlier than it closes — "opens" hours must be more than "closes" hours.');
  }
  if (season.opensBeforeH > SEASON_MAX_OFFSET_H || season.closesBeforeH > SEASON_MAX_OFFSET_H) {
    errs.push(`Poll offsets can be at most ${SEASON_MAX_OFFSET_H} hours (32 days).`);
  }
  if (!cron || !cron.trim()) {
    errs.push('A season needs a rotation schedule.');
  }
  return errs;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MINUTES_PER_WEEK = 7 * 24 * 60;

function wallLabel(minuteOfWeek: number): string {
  const m = ((minuteOfWeek % MINUTES_PER_WEEK) + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  const day = Math.floor(m / 1440);
  const hour = Math.floor((m % 1440) / 60);
  const minute = m % 60;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${DAY_NAMES[day]} ${h12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "ET" / "CT" style zone label; falls back to the short name, then the IANA id. */
export function zoneLabel(timeZone: string, at: Date = new Date()): string {
  for (const style of ['shortGeneric', 'short'] as const) {
    try {
      const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style })
        .formatToParts(at)
        .find(p => p.type === 'timeZoneName');
      if (part?.value) return part.value;
    } catch { /* unsupported style or zone — try the next */ }
  }
  return timeZone;
}

/**
 * "Opens Monday 12:00 AM ET · closes Thursday 9:00 PM ET · table starts
 * Friday 12:00 AM ET" for a WEEKLY cron (`m h * * d`, single values — the only
 * weekly shape `ScheduleBuilder` emits). Wall-clock arithmetic in the cron's
 * own zone, so a DST change inside the window can shift the real instant by an
 * hour; the server derives the exact times and the Season panel shows them.
 *
 * Returns null for any other cadence (daily, monthly, hand-written) — the form
 * then shows the offsets alone rather than guessing.
 */
export function describeSeasonPollTimes(
  cron: string | undefined,
  timeZone: string,
  opensBeforeH: number,
  closesBeforeH: number,
): string | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*') return null;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || !/^\d$/.test(dow)) return null;
  const m = Number(min);
  const h = Number(hour);
  const d = Number(dow) % 7; // cron allows 7 = Sunday
  if (m > 59 || h > 23) return null;
  if (!Number.isFinite(opensBeforeH) || !Number.isFinite(closesBeforeH)) return null;

  const rotation = d * 1440 + h * 60 + m;
  const tz = zoneLabel(timeZone);
  const weeks = (hrs: number) => (hrs >= 168 ? ` (${Math.floor(hrs / 168)} week${hrs >= 336 ? 's' : ''} earlier)` : '');
  return `Opens ${wallLabel(rotation - opensBeforeH * 60)} ${tz}${weeks(opensBeforeH)}`
    + ` · closes ${wallLabel(rotation - closesBeforeH * 60)} ${tz}${weeks(closesBeforeH)}`
    + ` · table starts ${wallLabel(rotation)} ${tz}`;
}

/** The season block of the tournament create/update body (`season_*` keys). */
export function seasonPayload(season: SeasonFormState): Record<string, unknown> {
  if (!season.enabled) return { season_table_count: null };
  return {
    season_table_count: season.tableCount,
    season_points_top: season.pointsTop,
    season_poll_opens_before_h: season.opensBeforeH,
    season_poll_closes_before_h: season.closesBeforeH,
    season_tie_rule: season.tieRule,
    season_tie_fallback: season.tieFallback,
  };
}

/** Raw `season_*` columns as `GET /:roomId/tournaments` ships them. */
export interface SeasonColumns {
  season_table_count?: number | null;
  season_points_top?: number | null;
  season_poll_opens_before_h?: number | null;
  season_poll_closes_before_h?: number | null;
  season_tie_rule?: string | null;
  season_tie_fallback?: string | null;
}

export function seasonStateFromRow(t: SeasonColumns): SeasonFormState {
  const rule = t.season_tie_rule;
  const fallback = t.season_tie_fallback;
  return {
    enabled: t.season_table_count != null,
    tableCount: t.season_table_count ?? defaultSeasonState.tableCount,
    pointsTop: t.season_points_top ?? defaultSeasonState.pointsTop,
    opensBeforeH: t.season_poll_opens_before_h ?? defaultSeasonState.opensBeforeH,
    closesBeforeH: t.season_poll_closes_before_h ?? defaultSeasonState.closesBeforeH,
    tieRule: rule === 'random' || rule === 'first_nominated' || rule === 'admin' ? rule : defaultSeasonState.tieRule,
    tieFallback: fallback === 'first_nominated' || fallback === 'random' ? fallback : defaultSeasonState.tieFallback,
  };
}
