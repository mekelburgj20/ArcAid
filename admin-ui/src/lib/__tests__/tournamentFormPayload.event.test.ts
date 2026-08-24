import { describe, it, expect } from 'vitest';
import { toPayload, tournamentToFormState, lockedRoundNumbers, type Tournament } from '../tournamentFormPayload';
import { defaultFormState } from '../../components/TournamentForm';
import { defaultEventState } from '../eventTime';

/**
 * The form <-> API boundary for Live Events (v2.135.0, ADR 0017).
 *
 * Two failure modes this pins down, both silent:
 *
 *   1. **An event emitting a cron.** The server rejects it, but more importantly
 *      a cron would hand the tournament to `Scheduler.scheduleTournament`, and
 *      `runMaintenance` would rotate the rounds out from under their own
 *      schedule. A rotation emitting NO cron is the mirror bug: it saves and
 *      then never runs.
 *   2. **Round times losing their timezone.** The admin types wall-clock in the
 *      event's zone; the API stores UTC. An off-by-an-hour conversion produces
 *      a schedule that is wrong with no error anywhere.
 */

const eventState = (overrides: Partial<typeof defaultEventState> = {}) => ({
  ...defaultFormState,
  name: 'Stream Night',
  tag: 'SN',
  format: 'event' as const,
  event: {
    ...defaultEventState,
    timezone: 'America/Chicago',
    checkinOpensLocal: '2026-09-01T19:30',
    checkinRequired: true,
    aggregateMethod: 'average' as const,
    minElapsedSec: 120,
    endGraceSec: 180,
    rounds: [
      { roundNo: 1, gameName: 'Medieval Madness', startLocal: '2026-09-01T20:00', durationMin: 25 },
      { roundNo: 2, gameName: 'Attack from Mars', startLocal: '2026-09-01T20:30', durationMin: 25 },
    ],
    ...overrides,
  },
});

describe('toPayload — event', () => {
  it('emits the event block with UTC round windows and NO cron', () => {
    const payload = toPayload(eventState(), { id: 'x', is_active: true }) as any;

    expect(payload.format).toBe('event');
    expect(payload.cadence.cron).toBeUndefined();
    expect(payload.cadence.timezone).toBe('America/Chicago');

    // 2026-09-01 is CDT (UTC-5), so 20:00 local is 01:00 UTC the next day.
    expect(payload.event.rounds[0].scheduledStartAt).toBe('2026-09-02T01:00:00.000Z');
    expect(payload.event.rounds[0].scheduledEndAt).toBe('2026-09-02T01:25:00.000Z');
    expect(payload.event.rounds[1].scheduledStartAt).toBe('2026-09-02T01:30:00.000Z');
    expect(payload.event.checkinOpensAt).toBe('2026-09-02T00:30:00.000Z');

    expect(payload.event.checkinRequired).toBe(true);
    expect(payload.event.aggregateMethod).toBe('average');
    expect(payload.event.minElapsedSec).toBe(120);
    expect(payload.event.endGraceSec).toBe(180);
  });

  it('sends null rather than 0 when the gear-up badge is off', () => {
    const payload = toPayload(eventState({ minElapsedSec: 0 }), {}) as any;
    expect(payload.event.minElapsedSec).toBeNull();
  });

  it('sends a null check-in time when the field is blank (opens immediately)', () => {
    const payload = toPayload(eventState({ checkinOpensLocal: '' }), {}) as any;
    expect(payload.event.checkinOpensAt).toBeNull();
  });

  it('trims round game names', () => {
    const payload = toPayload(eventState({
      rounds: [{ roundNo: 1, gameName: '  Medieval Madness  ', startLocal: '2026-09-01T20:00', durationMin: 25 }],
    }), {}) as any;
    expect(payload.event.rounds[0].gameName).toBe('Medieval Madness');
  });
});

describe('toPayload — rotation is unchanged', () => {
  it('still emits its cron and no event block', () => {
    const payload = toPayload({ ...defaultFormState, name: 'Daily Grind', tag: 'DG' }, { id: 'x' }) as any;
    expect(payload.format).toBe('rotation');
    expect(payload.cadence.cron).toBe(defaultFormState.schedule.cron);
    expect(payload.event).toBeUndefined();
  });
});

describe('tournamentToFormState', () => {
  const row: Tournament = {
    id: 't1',
    name: 'Stream Night',
    type: 'SN',
    mode: 'pinball',
    cadence: JSON.stringify({ timezone: 'America/Chicago' }),
    platform_rules: '{}',
    is_active: 1,
    display_order: 0,
    max_active_games: 1,
    cleanup_rule: '{"mode":"retain","count":0}',
    winner_picks: 1,
    auto_pick: 1,
    eligibility_days: 120,
    winner_pick_window_min: 60,
    runnerup_pick_window_min: 30,
    format: 'event',
    checkin_opens_at: '2026-09-02T00:30:00.000Z',
    checkin_required: 0,
    aggregate_method: 'sum',
    min_elapsed_sec: 90,
    end_grace_sec: 150,
    rounds: [
      { id: 'g1', name: 'Medieval Madness', status: 'COMPLETED', round_no: 1, scheduled_start_at: '2026-09-02T01:00:00.000Z', scheduled_end_at: '2026-09-02T01:25:00.000Z' },
      { id: 'g2', name: 'Attack from Mars', status: 'SCHEDULED', round_no: 2, scheduled_start_at: '2026-09-02T01:30:00.000Z', scheduled_end_at: '2026-09-02T01:55:00.000Z' },
    ],
  };

  it('hydrates rounds back into local wall-clock plus duration', () => {
    const state = tournamentToFormState(row);
    expect(state.format).toBe('event');
    expect(state.event.timezone).toBe('America/Chicago');
    expect(state.event.checkinOpensLocal).toBe('2026-09-01T19:30');
    expect(state.event.checkinRequired).toBe(false);
    expect(state.event.aggregateMethod).toBe('sum');
    expect(state.event.minElapsedSec).toBe(90);
    expect(state.event.endGraceSec).toBe(150);
    expect(state.event.rounds).toEqual([
      { roundNo: 1, gameName: 'Medieval Madness', startLocal: '2026-09-01T20:00', durationMin: 25 },
      { roundNo: 2, gameName: 'Attack from Mars', startLocal: '2026-09-01T20:30', durationMin: 25 },
    ]);
  });

  it('survives a full round-trip without drifting the schedule', () => {
    const payload = toPayload(tournamentToFormState(row), {}) as any;
    expect(payload.event.rounds[0].scheduledStartAt).toBe(row.rounds![0]!.scheduled_start_at);
    expect(payload.event.rounds[0].scheduledEndAt).toBe(row.rounds![0]!.scheduled_end_at);
    expect(payload.event.rounds[1].scheduledStartAt).toBe(row.rounds![1]!.scheduled_start_at);
    expect(payload.event.checkinOpensAt).toBe(row.checkin_opens_at);
  });

  it('treats a row with no format as rotation', () => {
    const state = tournamentToFormState({ ...row, format: undefined, rounds: undefined });
    expect(state.format).toBe('rotation');
    expect(state.event.rounds).toEqual(defaultEventState.rounds);
  });

  it('reports only non-SCHEDULED rounds as locked', () => {
    expect(lockedRoundNumbers(row)).toEqual([1]);
    expect(lockedRoundNumbers({ ...row, rounds: undefined })).toEqual([]);
  });
});
