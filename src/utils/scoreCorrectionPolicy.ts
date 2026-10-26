/**
 * Who may change a score's VALUE after it landed (owner ruling 2026-10-25).
 *
 * Two rules on top of the v2.150.0 correction tiers (admin any row; the
 * submitter their own row while the card is ACTIVE and unverified):
 *
 *  1. A score a MACHINE reported — the Arcaid Witness (`'vpx'`) or an AtGames
 *     cabinet pull (`'atgames'`) — is never editable, by anyone. The number is
 *     the evidence; a corrected value would sit under a Witness badge nobody
 *     measured. A wrong one is deleted (ADR 0024 keeps it from replaying).
 *  2. In a Sanctioned tournament or one with Limited attempts the SUBMITTER may
 *     not self-correct at all. Admins still can (typed scores only, by rule 1).
 *
 * The server (`PATCH /:roomId/score-history/:historyId/score` and
 * `ScoreHistoryService.correctScore`) enforces both; the FE mirror is
 * `admin-ui/src/lib/scoreCorrect.ts`.
 */

import { isAutoScoreSource } from '../services/AutoScoreSuppressionService.js';
import { normalizeIntegrityMode } from './sanctionedRules.js';

/** A score the Witness or a cabinet reported — never editable (rule 1). */
export function isMachineReportedScore(source: string | null | undefined): boolean {
    return isAutoScoreSource(source);
}

/** Does this tournament close self-correction to the submitter (rule 2)? */
export function isSelfCorrectionLocked(
    tournament: { integrity_mode?: unknown; max_attempts?: number | null } | null | undefined,
): boolean {
    if (!tournament) return false;
    if (normalizeIntegrityMode(tournament.integrity_mode) === 'sanctioned') return true;
    return tournament.max_attempts != null && tournament.max_attempts >= 1;
}

/**
 * The same rule as SQL, for queries that ship a per-board flag. `t` is the
 * tournaments alias; a NULL row (a pinned game) reads 0.
 */
export function selfCorrectionLockedSql(t: string): string {
    return `CASE WHEN ${t}.integrity_mode = 'sanctioned' OR ${t}.max_attempts >= 1 THEN 1 ELSE 0 END`;
}

export const MACHINE_SCORE_NOT_EDITABLE_MESSAGE =
    'This score was reported by Arcaid Witness and cannot be edited. Delete it instead if it is wrong.';

export const SELF_CORRECTION_LOCKED_MESSAGE =
    'This tournament does not allow players to edit their scores — ask an admin.';

/** Thrown by `correctScore` so no caller can edit a machine-reported row. */
export class ScoreNotEditableError extends Error {
    readonly code = 'SCORE_NOT_EDITABLE';
    constructor() {
        super(MACHINE_SCORE_NOT_EDITABLE_MESSAGE);
        this.name = 'ScoreNotEditableError';
    }
}
