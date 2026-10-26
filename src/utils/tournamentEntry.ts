/**
 * Is this player ALLOWED IN this tournament? The ONE answer (W37, ADR 0033 §1–2),
 * shared by the typed-score gate (`EventSubmissionGate` / `TournamentEntryService`),
 * the Witness device path (`VpxScoreIngestService`) and the Start attempts
 * button (`AttemptService`), so they can never disagree — before v2.175.0 a
 * device score skipped "check-in required" entirely (W36).
 *
 * - **A Throwdown** (room-less event): only a player who joined it.
 * - **An invite-only tournament** (`Entry: Invited players`, W39, ADR 0033 §6):
 *   only a player on its ROSTER — and an event that also requires check-in
 *   still needs them checked in (owner ruling 2026-10-26: the roster says who
 *   may play, check-in says who showed up).
 * - **An event that requires check-in**: only a checked-in (or admin-added)
 *   participant.
 * - **Anything else** (a rotation, an event without check-in): a member of the
 *   room is in — room membership IS entry — and so is anyone the host entered
 *   directly. The typed path passes `isMember: true`: submitting a score joins
 *   the room.
 */
export type EntryMode = 'members' | 'invited';

export interface EntryFacts {
    format: 'rotation' | 'event';
    /** No room at all — a Throwdown. */
    roomless: boolean;
    checkinRequired: boolean;
    isMember: boolean;
    /** Has a `tournament_participants` row (checked in, joined, or admin-added). */
    isParticipant: boolean;
    /** W39 — the tournament's entry setting. Absent = 'members'. */
    entryMode?: EntryMode;
    /** W39 — on the tournament's roster (`tournament_roster`). Absent = false. */
    onRoster?: boolean;
}

export function entryAllowed(f: EntryFacts): boolean {
    if (f.roomless) return f.isParticipant;
    if (f.entryMode === 'invited') {
        if (!f.onRoster) return false;
        if (f.format === 'event' && f.checkinRequired) return f.isParticipant;
        return true;
    }
    if (f.format === 'event' && f.checkinRequired) return f.isParticipant;
    return f.isMember || f.isParticipant;
}

/** Read the stored column; anything unknown is the default. */
export function normalizeEntryMode(value: unknown): EntryMode {
    return value === 'invited' ? 'invited' : 'members';
}

/** Which self-serve ways onto the roster the host switched on (adding by name is always on). */
export interface EntryMethods {
    link: boolean;
    request: boolean;
}

export function normalizeEntryMethods(value: unknown): EntryMethods {
    let raw: unknown = value;
    if (typeof value === 'string') {
        try { raw = JSON.parse(value); } catch { raw = null; }
    }
    const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return { link: o.link === true, request: o.request === true };
}
