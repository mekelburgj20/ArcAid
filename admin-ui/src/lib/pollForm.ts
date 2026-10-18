/**
 * Pick by poll (ADR 0026, docs/season-format-plan.md §13) — the pure half of
 * the tournament form's "Pick by poll" option in the Game Rotation section: its
 * state, its defaults, the client-side mirror of the server's validation, the
 * plain-language poll-timing echo and its slice of the create/update body.
 *
 * Pick by poll is a ROTATION METHOD, independent of Seasons: any rotation
 * tournament may switch it on. While it is on the server forces winner picks
 * and auto-pick off, one active slot and a 0-day cooldown.
 *
 * Kept out of `components/TournamentForm.tsx` so the form file keeps exporting
 * components (react-refresh) and so these stay unit-testable without a render.
 */

export type PollTieRule = 'admin' | 'random' | 'first_nominated';

export interface PollFormState {
  /** Off = the winner / auto-pick / admin choose tables as before. */
  enabled: boolean;
  opensBeforeH: number;
  closesBeforeH: number;
  tieRule: PollTieRule;
}

export const defaultPollState: PollFormState = {
  enabled: false,
  opensBeforeH: 96,
  closesBeforeH: 3,
  tieRule: 'admin',
};

/** The Zod cap on both offsets (`24 * 32` h — Discord's 32-day poll ceiling). */
export const POLL_MAX_OFFSET_H = 24 * 32;

/**
 * The Poll Tie-breaker options. "Admin decides" is a HOLD, not a fallback: no
 * table is queued until an admin chooses one of the tied tables.
 */
export const TIE_RULE_LABEL: Record<PollTieRule, string> = {
  admin: 'Admin decides — no table is queued until an admin chooses',
  random: 'Random pick among the tied',
  first_nominated: 'First nominated wins',
};

/** Note shown beside every field Pick by poll locks. */
export const POLL_LOCK_NOTE =
  'Fixed while Pick by poll is on: the poll picks each table, one table is live at a time; a community vote overrides cooldown.';

/**
 * Client-side mirror of `resolvePoll` in `src/services/TournamentService.ts`
 * and the Zod poll refine in `src/api/schemas.ts`. Empty when the poll is off
 * or valid. The server re-validates the merged block either way.
 */
export function getPollErrors(poll: PollFormState, cron: string | undefined): string[] {
  if (!poll.enabled) return [];
  const errs: string[] = [];
  const isInt = (n: number) => Number.isInteger(n);
  if (!isInt(poll.closesBeforeH) || poll.closesBeforeH < 1) {
    errs.push('The poll must close at least 1 hour before the rotation (Discord\'s shortest poll is 1 hour).');
  }
  if (!isInt(poll.opensBeforeH) || poll.opensBeforeH <= poll.closesBeforeH) {
    errs.push('The poll must open earlier than it closes — "opens" hours must be more than "closes" hours.');
  }
  if (poll.opensBeforeH > POLL_MAX_OFFSET_H || poll.closesBeforeH > POLL_MAX_OFFSET_H) {
    errs.push(`Poll offsets can be at most ${POLL_MAX_OFFSET_H} hours (32 days).`);
  }
  if (!cron || !cron.trim()) {
    errs.push('Pick by poll needs a rotation schedule.');
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
 * hour; the server derives the exact times and the Polls panel shows them.
 *
 * Returns null for any other cadence (daily, monthly, hand-written) — the form
 * then shows the offsets alone rather than guessing.
 */
export function describePollTimes(
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

/** The Pick-by-poll block of the tournament create/update body (`poll_*` keys). */
export function pollPayload(poll: PollFormState): Record<string, unknown> {
  if (!poll.enabled) return { poll_picks: false };
  return {
    poll_picks: true,
    poll_opens_before_h: poll.opensBeforeH,
    poll_closes_before_h: poll.closesBeforeH,
    poll_tie_rule: poll.tieRule,
  };
}

/** Raw `poll_*` columns as `GET /:roomId/tournaments` ships them. */
export interface PollColumns {
  poll_picks?: number | boolean | null;
  poll_opens_before_h?: number | null;
  poll_closes_before_h?: number | null;
  poll_tie_rule?: string | null;
}

export function pollStateFromRow(t: PollColumns): PollFormState {
  const rule = t.poll_tie_rule;
  return {
    enabled: !!t.poll_picks,
    opensBeforeH: t.poll_opens_before_h ?? defaultPollState.opensBeforeH,
    closesBeforeH: t.poll_closes_before_h ?? defaultPollState.closesBeforeH,
    tieRule: rule === 'random' || rule === 'first_nominated' || rule === 'admin' ? rule : defaultPollState.tieRule,
  };
}
