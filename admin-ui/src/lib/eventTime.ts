/**
 * Wall-clock <-> UTC conversion for Live Event round windows (v2.135.0, ADR 0017).
 *
 * ## Why this exists at all
 *
 * An admin schedules a round in THEIR tournament's timezone ("round 1 at 8pm
 * Central"), the browser renders `<input type="datetime-local">` which has no
 * timezone at all, and the API stores ISO UTC. Something has to sit between
 * those three, and `admin-ui` has no date library — so this is it. Deliberately
 * ~60 lines rather than a dependency.
 *
 * ## Why the two-pass offset
 *
 * The offset of a zone depends on the instant, and the instant is what we're
 * trying to find — that is genuinely circular at a DST boundary. So: guess the
 * offset using the wall time read as if it were UTC, apply it, then re-read the
 * offset at that corrected instant and apply it again. One correction is enough
 * for every real zone, because no zone's offset changes by more than the ~1h
 * error the first pass can carry.
 *
 * Times inside a DST "spring forward" gap (e.g. 02:30 on the US spring change,
 * which does not exist) resolve to the instant the clock jumps to. That is the
 * same thing every calendar app does and is the only sane answer available.
 */

/**
 * `datetime-local` shape. A LENGTH check is not enough: `Date.parse` is
 * famously lenient, and V8 turns `'not-a-date-at-al:00Z'` into a real instant
 * (2000-01-01) rather than NaN. A garbage field silently becoming a valid
 * schedule is precisely the failure this module exists to prevent, so every
 * entry point matches the shape first.
 */
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Parse a datetime-local string as if its wall clock were UTC. NaN when malformed. */
function parseNaive(local: string): number {
    if (!local || !LOCAL_DATETIME.test(local)) return NaN;
    return Date.parse(`${local.slice(0, 16)}:00Z`);
}

/** Milliseconds to ADD to a UTC instant to get the zone's wall-clock reading. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));

    const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
    // Some ICU builds render midnight as hour 24 under hour12:false.
    const hour = get('hour') % 24;
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
    return wallAsUtc - utcMs;
}

/**
 * `'2026-09-01T20:00'` in `timeZone` -> `'2026-09-02T01:00:00.000Z'`.
 *
 * @returns null when the input is not a complete datetime-local value, so a
 *   half-typed field never produces a bogus instant.
 */
export function wallTimeToUtcIso(local: string, timeZone: string): string | null {
    const naive = parseNaive(local);
    if (Number.isNaN(naive)) return null;

    let utc = naive - zoneOffsetMs(naive, timeZone);
    utc = naive - zoneOffsetMs(utc, timeZone);
    return new Date(utc).toISOString();
}

/**
 * The inverse, for hydrating the form from a saved event:
 * `'2026-09-02T01:00:00.000Z'` in `timeZone` -> `'2026-09-01T20:00'`.
 */
export function utcIsoToWallTime(iso: string | null | undefined, timeZone: string): string {
    if (!iso) return '';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '';
    return new Date(ms + zoneOffsetMs(ms, timeZone)).toISOString().slice(0, 16);
}

/** Minutes between two datetime-local strings; null when either is incomplete. */
export function durationMinutes(startLocal: string, endLocal: string): number | null {
    const a = parseNaive(startLocal);
    const b = parseNaive(endLocal);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.round((b - a) / 60000);
}

/** `startLocal` + `minutes`, as a datetime-local string. */
export function addMinutes(startLocal: string, minutes: number): string {
    const a = parseNaive(startLocal);
    if (Number.isNaN(a)) return '';
    return new Date(a + minutes * 60000).toISOString().slice(0, 16);
}

export interface RoundDraft {
    roundNo: number;
    gameName: string;
    /** datetime-local, in the event's timezone. */
    startLocal: string;
    durationMin: number;
}

/**
 * The SAME rules `EventService.validateRounds` enforces server-side, run
 * client-side so an admin sees the problem while typing instead of on save.
 *
 * The server remains the authority — the Discord path and the admin
 * "start now" control reach that validation without passing through this
 * function at all. This is a convenience, never a gate.
 *
 * @returns one message per offending round, keyed by round number.
 */
export function validateRoundDrafts(
    rounds: RoundDraft[],
    checkinOpensLocal: string,
): Record<number, string> {
    const errors: Record<number, string> = {};
    const sorted = [...rounds].sort((a, b) => a.roundNo - b.roundNo);

    for (const r of sorted) {
        if (!r.gameName.trim()) errors[r.roundNo] = 'Pick a game for this round.';
        else if (!r.startLocal) errors[r.roundNo] = 'Set a start time.';
        else if (!(r.durationMin > 0)) errors[r.roundNo] = 'Duration must be at least a minute.';
    }

    for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (errors[prev.roundNo] || errors[cur.roundNo]) continue;
        const prevEnd = parseNaive(addMinutes(prev.startLocal, prev.durationMin));
        const curStart = parseNaive(cur.startLocal);
        if (Number.isNaN(prevEnd) || Number.isNaN(curStart)) continue;
        if (curStart < prevEnd) {
            errors[cur.roundNo] = `Starts before round ${prev.roundNo} ends.`;
        }
    }

    const first = sorted[0];
    if (first && checkinOpensLocal && !errors[first.roundNo]) {
        const opens = parseNaive(checkinOpensLocal);
        const start = parseNaive(first.startLocal);
        if (!Number.isNaN(opens) && opens >= start) {
            errors[first.roundNo] = 'Check-in must open before round 1 starts.';
        }
    }

    return errors;
}

/**
 * The Live Event half of the tournament form's state.
 *
 * Lives here rather than beside `EventSettingsFields` for the reason
 * `tournamentFormPayload.ts` documents: Vite fast-refresh requires a component
 * file to export ONLY components, so shared constants and types belong in a
 * plain module.
 */
export interface EventFormState {
    timezone: string;
    /** datetime-local in `timezone`; empty = check-in opens as soon as the event is saved. */
    checkinOpensLocal: string;
    checkinRequired: boolean;
    aggregateMethod: 'best' | 'average' | 'sum';
    /** 0 = no gear-up badge. */
    minElapsedSec: number;
    endGraceSec: number;
    rounds: RoundDraft[];
    /** Editing convenience only — never sent. Keeps every round on one table. */
    sameGameForAllRounds: boolean;
}

export const defaultEventState: EventFormState = {
    timezone: 'America/Chicago',
    checkinOpensLocal: '',
    checkinRequired: true,
    aggregateMethod: 'best',
    minElapsedSec: 0,
    endGraceSec: 60,
    rounds: [{ roundNo: 1, gameName: '', startLocal: '', durationMin: 30 }],
    sameGameForAllRounds: false,
};
