import type { EventRoundRow, Tournament } from './tournamentFormPayload';

/**
 * How a Live Event reads in the admin list (v2.135.0, ADR 0017).
 *
 * The state is derived from the SCHEDULE, not from the rounds' statuses — the
 * same rule `EventService.deriveState` uses server-side. The per-minute tick
 * can be up to 60 seconds behind the clock, and an admin watching the page
 * during an event should see "live" the moment the round is due, not a minute
 * later when the row finally flips.
 */

export type EventState = 'upcoming' | 'checkin' | 'live' | 'between_rounds' | 'finished' | 'cancelled';

export function deriveEventState(t: Tournament, now: number = Date.now()): EventState | null {
  if (t.format !== 'event') return null;
  if (t.event_finished_at) return 'finished';
  if (t.is_active === 0) return 'cancelled';

  const rounds = [...(t.rounds ?? [])].sort((a, b) => a.round_no - b.round_no);
  if (rounds.length === 0) return 'upcoming';

  if (t.checkin_opens_at && now < Date.parse(t.checkin_opens_at)) return 'upcoming';
  if (now < Date.parse(rounds[0]!.scheduled_start_at)) return 'checkin';

  for (const r of rounds) {
    if (now >= Date.parse(r.scheduled_start_at) && now < Date.parse(r.scheduled_end_at)) return 'live';
  }
  if (now >= Date.parse(rounds[rounds.length - 1]!.scheduled_end_at)) return 'finished';
  return 'between_rounds';
}

/** The round happening now, or the next one due. Null once everything is over. */
export function currentOrNextRound(t: Tournament, now: number = Date.now()): EventRoundRow | null {
  const rounds = [...(t.rounds ?? [])].sort((a, b) => a.round_no - b.round_no);
  return rounds.find(r => now < Date.parse(r.scheduled_end_at)) ?? null;
}

export function eventStateLabel(state: EventState, t?: Tournament, now: number = Date.now()): {
  text: string;
  tone: 'live' | 'soon' | 'done' | 'idle';
} {
  switch (state) {
    case 'live': {
      const round = t ? currentOrNextRound(t, now) : null;
      const total = t?.rounds?.length ?? 0;
      return {
        text: round && total > 1 ? `Live · R${round.round_no}/${total}` : 'Live',
        tone: 'live',
      };
    }
    case 'checkin': return { text: 'Check-in open', tone: 'soon' };
    case 'between_rounds': {
      const round = t ? currentOrNextRound(t, now) : null;
      return { text: round ? `Between rounds · R${round.round_no} next` : 'Between rounds', tone: 'soon' };
    }
    case 'upcoming': return { text: 'Upcoming', tone: 'idle' };
    case 'finished': return { text: 'Finished', tone: 'done' };
    case 'cancelled': return { text: 'Cancelled', tone: 'done' };
  }
}

export function roundStatusLabel(status: string): string {
  switch (status) {
    case 'SCHEDULED': return 'Scheduled';
    case 'ACTIVE': return 'Live';
    case 'COMPLETED': return 'Finished';
    default: return status;
  }
}

/**
 * "in 12m" / "3h 5m" — a coarse relative time for the admin list. Deliberately
 * not a live countdown: the list is a management view, and the event page is
 * where a second-by-second clock belongs.
 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = ms - now;
  const past = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  if (mins < 1) return past ? 'just now' : 'now';
  const body = mins < 60
    ? `${mins}m`
    : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return past ? `${body} ago` : `in ${body}`;
}
