import { AlertTriangle } from 'lucide-react';

/**
 * The Arcaid Witness verdict for one witness-sourced score (v2.145.0, P8).
 * Optional throughout: absent on every non-witness row, and on any board
 * rendered from a result frozen before v2.145.0.
 *
 * v2.190.0 (W22) — moved here from `pages/EventDetail.tsx` so the game page and
 * the scoreboard cards render the SAME badge and copy the event page does.
 */
export interface WitnessVerdict {
    status: 'verified' | 'flagged' | 'unwitnessed';
    /**
     * Which tier verified it (v2.148.0, ADR 0021): a joined table `session`, or
     * the cabinet's round-start `checkin` attestation. Optional so a board
     * rendered by an older client/server pair still reads as a session verdict.
     */
    method?: 'session' | 'checkin' | null;
    launchTs: number | null;
    exitTs: number | null;
    durationSec: number | null;
    table: string | null;
    /** `retro` = reconstructed after the fact. Same trust, shown for honesty. */
    via?: 'live' | 'retro' | null;
    checkinTs?: number | null;
    /**
     * `'exit'` (v2.158.0) — a no-ROM table's single score reading, taken when
     * the player left. It can verify (table opened inside the round) or stay
     * unwitnessed (table opened before it), never flag.
     */
    sample?: 'exit' | null;
    /** v2.160.0 — ball-1 restarts in the joined game, and whether the score was a ball-sum floor. */
    restarts?: number | null;
    partial?: boolean | null;
}

/** The copy for a score an event under 'prevent' leaves out (v2.169.0, W20). */
export const NOT_COUNTED_LABEL = 'Not counted: started before the round opened';
export const NOT_COUNTED_TITLE = 'The Arcaid Witness saw this game start before the round opened';
export const FLAGGED_TITLE = 'Witness: this table was launched before the round opened';

/** Trailing notes for a verified-session tooltip: restarts and a partial score. */
function witnessNotes(witness: WitnessVerdict): string {
    const notes: string[] = [];
    if (witness.restarts != null && witness.restarts > 0) {
        notes.push(`${witness.restarts} ball-1 restart${witness.restarts === 1 ? '' : 's'} in this game`);
    }
    if (witness.partial) notes.push('score is a floor — the launcher lost one ball\'s points');
    return notes.length ? ` · ${notes.join(' · ')}` : '';
}

/** `4m 12s` / `47s` — how long the witness saw the table open. */
function playDuration(sec: number): string {
    const clamped = Math.max(0, Math.floor(sec));
    const m = Math.floor(clamped / 60);
    return m > 0 ? `${m}m ${clamped % 60}s` : `${clamped}s`;
}

/**
 * The Arcaid Witness badge for one score (v2.145.0, P8; tiers v2.148.0).
 *
 * A BADGE — under 'prevent' the RANKING already left a flagged score out
 * upstream (ADR 0031); this only shows what the witness saw. `unwitnessed` is
 * the neutral default (most players have no paired cabinet), so it renders as
 * quiet grey text and never as a warning.
 *
 * A check-in verdict shows NO duration on purpose: the cabinet attested it was
 * free before this score, which dates the play but does not measure it.
 */
export function WitnessBadge({ witness }: { witness?: WitnessVerdict | null }) {
    if (!witness) return null;
    if (witness.status === 'verified') {
        if (witness.method === 'checkin') {
            return (
                <span
                    className="ml-1 text-neon-green"
                    title="The cabinet checked in after this round opened and before this score — so the table was played inside the round window"
                >✓ <span className="text-xs">checked in</span></span>
            );
        }
        if (witness.sample === 'exit') {
            return (
                <span
                    className="ml-1 text-neon-green"
                    title="Witnessed: this table has no ROM, so the cabinet read the score once when the player left — and the table was opened inside the round window"
                >✓</span>
            );
        }
        const played = witness.durationSec != null ? ` · ${playDuration(witness.durationSec)} of play` : '';
        return (
            <span
                className="ml-1 text-neon-green"
                title={`Witnessed: launched inside the round window${played}${witnessNotes(witness)}`}
            >✓</span>
        );
    }
    if (witness.status === 'flagged') {
        return (
            <span
                className="ml-1 text-neon-amber"
                title={FLAGGED_TITLE}
            >⚠</span>
        );
    }
    if (witness.sample === 'exit') {
        return (
            <span
                className="ml-1 text-faint text-xs"
                title="This table has no ROM, so the cabinet read the score once when the player left. The table was opened before the round started, so the cabinet cannot say when this game began. Open the table after the round starts to have it witnessed."
            >unwitnessed</span>
        );
    }
    return (
        <span
            className="ml-1 text-faint text-xs"
            title="No Witness evidence for this score — most players have no paired Witness device (cabinet or desktop)"
        >unwitnessed</span>
    );
}

/**
 * v2.190.0 (W22) — the scoreboard CARD's mark: a compact warning on a `flagged`
 * score and nothing else. Cards are tight, so a verified or unwitnessed score
 * shows nothing here (the game page carries the full badge). Sized like the
 * cards' verified checkmark it sits beside.
 */
export function WitnessFlagMark({ witness, size = 12 }: { witness?: WitnessVerdict | null; size?: number }) {
    if (witness?.status !== 'flagged') return null;
    return (
        <span
            className="inline-flex shrink-0 items-center text-neon-amber"
            title={FLAGGED_TITLE}
            aria-label="Witness flagged: started before the round opened"
            data-testid="witness-flag-mark"
        >
            <AlertTriangle size={size} />
        </span>
    );
}
