/**
 * Is this player ALLOWED IN this tournament? The ONE answer (W37, ADR 0033 §1–2),
 * shared by the typed-score gate (`EventSubmissionGate`) and the Witness device
 * path (`VpxScoreIngestService`), so the two can never disagree again — before
 * v2.175.0 a device score skipped "check-in required" entirely (W36).
 *
 * - **A Throwdown** (room-less event): only a player who joined it.
 * - **An event that requires check-in**: only a checked-in (or admin-added)
 *   participant.
 * - **Anything else** (a rotation, an event without check-in): a member of the
 *   room is in — room membership IS entry — and so is anyone the host entered
 *   directly. The typed path passes `isMember: true`: submitting a score joins
 *   the room.
 *
 * W39 adds the entry roster (`Entry: Invited players`) here; it must stay the
 * one place that decides.
 */
export interface EntryFacts {
    format: 'rotation' | 'event';
    /** No room at all — a Throwdown. */
    roomless: boolean;
    checkinRequired: boolean;
    isMember: boolean;
    /** Has a `tournament_participants` row (checked in, joined, or admin-added). */
    isParticipant: boolean;
}

export function entryAllowed(f: EntryFacts): boolean {
    if (f.roomless) return f.isParticipant;
    if (f.format === 'event' && f.checkinRequired) return f.isParticipant;
    return f.isMember || f.isParticipant;
}
