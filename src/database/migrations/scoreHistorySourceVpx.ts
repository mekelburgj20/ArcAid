/**
 * Migration 172 — widen `score_history.source` to accept `'vpx'`.
 *
 * ## Why a fifth source
 *
 * A VPXS-on-cabinet score is recorded by the vpx-standalone launcher's own
 * scoreserver and read off the stick by the Arcaid Witness. It is none of the
 * four we have: not `'tournament'` (nobody submitted it — Arcaid never saw a
 * player type anything), not `'atgames'` (it never touches an AtGames board;
 * AtGames does not know these tables exist), not `'sync'` (that means iScored
 * and forces unknown provenance per ADR 0016 P2, while these rows know their
 * engine exactly), and not `'community'` (they land inside a tournament window
 * and count for standings).
 *
 * The distinction is load-bearing rather than cosmetic: the trust model has to
 * be able to answer "how did this score reach us?", and a VPX row's answer —
 * *the launcher recorded it and our own process read the record* — is different
 * in kind from every other row on the same board. It also lets the verify join
 * treat these rows by their own rule (a game ends mid-session, so the exit-time
 * join that fits AtGames does not fit here).
 *
 * The rebuild is the shared one; see `rebuildScoreHistorySource`.
 */

import { rebuildScoreHistorySource } from './rebuildScoreHistorySource.js';

type Db = Parameters<typeof rebuildScoreHistorySource>[0];

export async function scoreHistorySourceVpx(db: Db): Promise<void> {
    await rebuildScoreHistorySource(db, {
        label: 'Migration 172',
        newValue: 'vpx',
        values: ['tournament', 'community', 'sync', 'atgames', 'vpx'],
    });
}
