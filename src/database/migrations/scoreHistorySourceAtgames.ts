import { logInfo, logWarn } from '../../utils/logger.js';

/**
 * Migration 167 — widen `score_history.source` to accept `'atgames'` (P7).
 *
 * ## Why a fourth source at all
 *
 * An AtGames score is not any of the three we already have. It is not
 * `'tournament'` (Arcaid never saw the submit — it arrived from a third-party
 * API), not `'community'` (it happened inside a tournament window and counts
 * for standings), and not `'sync'` (that value means iScored, and doctrine
 * forces `engine`/`device` to `'unknown'` for it per ADR 0016 P2, whereas an
 * AtGames row carries KNOWN provenance: the cabinet model is in the payload).
 *
 * Reusing any of the three would make provenance unrecoverable afterwards —
 * "which of these tournament rows did we actually witness?" is a question the
 * trust model has to be able to answer, and a shared source value erases it.
 * S23.4 chose `'community'` for CSV backfills specifically to avoid this
 * rebuild; that was the right call there because those rows have no tournament
 * linkage. These do.
 *
 * ## Why this is the careful one
 *
 * The rebuild itself lives in `rebuildScoreHistorySource` — extracted verbatim
 * when migration 172 needed the same surgery for `'vpx'`. Two hand-copied
 * copy-drop-rename migrations over the score table is exactly the drift this
 * codebase refuses elsewhere; the safeguards are documented there.
 */

import { rebuildScoreHistorySource } from './rebuildScoreHistorySource.js';

type Db = Parameters<typeof rebuildScoreHistorySource>[0];

export async function scoreHistorySourceAtgames(db: Db): Promise<void> {
    await rebuildScoreHistorySource(db, {
        label: 'Migration 167',
        newValue: 'atgames',
        values: ['tournament', 'community', 'sync', 'atgames'],
    });
}
