import type { Database } from 'sqlite';
import { logInfo } from '../../utils/logger.js';

/**
 * Migration 133 — RetroAchievements columns on `global_games`.
 *
 * Additive, and deliberately a HANDLER rather than an inline `sql` entry: the
 * inline runner swallows exec failures (that is how it stays idempotent for
 * `ALTER TABLE ADD COLUMN`, which throws on re-run), and a swallowed failure
 * here would leave the RA import writing to columns that do not exist. The
 * fan-out try/catch class of bug — the schema silently disagrees with the code
 * and nothing says so. Pragma-guarding each ADD COLUMN gets idempotency
 * without the swallow, so a REAL failure still halts startup.
 *
 * Columns:
 *   ra_id                RA's own game id. Joins the step-1 external-id set in
 *                        `GlobalGameService.upsert` alongside opdb/vps/igdb, so
 *                        a re-import lands on the row it created last time.
 *                        UNIQUE-indexed (partial, `WHERE ra_id IS NOT NULL`)
 *                        because two catalogue rows claiming one RA game would
 *                        make that lookup ambiguous.
 *   score_eligibility    Classifier verdict — 'score' | 'score_maybe' | 'time'
 *                        | 'novelty' | 'unknown'. A HINT for admin surfaces and
 *                        the §5 review flow, never an enforcement gate: Arcaid's
 *                        submission model does not depend on RA having a board.
 *   ra_leaderboard_count How many boards RA had at import time. The evidence
 *                        behind the verdict, kept so a reviewer can tell
 *                        "RA says this isn't score-based" from "RA said
 *                        nothing" without re-querying the API.
 *   ra_imported_by       WHO triggered the import (moderation provenance).
 *                        Players can import from the Global Scoreboard, so a
 *                        junk add needs an attributable actor. Nullable —
 *                        admin-triggered imports may leave it null, and every
 *                        pre-RA row has no importer at all.
 *
 * No FK anywhere: `ra_id` points at RetroAchievements, and `ra_imported_by`
 * is an identity string that must outlive the account it names (an audit
 * value, like `games.tournament_id`).
 */
const COLUMNS: Array<{ name: string; ddl: string }> = [
    { name: 'ra_id', ddl: 'ra_id INTEGER' },
    { name: 'score_eligibility', ddl: 'score_eligibility TEXT' },
    { name: 'ra_leaderboard_count', ddl: 'ra_leaderboard_count INTEGER' },
    { name: 'ra_imported_by', ddl: 'ra_imported_by TEXT' },
];

export async function addRaCatalogueColumns(db: Database): Promise<void> {
    const existing = await db.all<Array<{ name: string }>>(`PRAGMA table_info(global_games)`);
    const have = new Set(existing.map(c => c.name));

    const added: string[] = [];
    for (const col of COLUMNS) {
        if (have.has(col.name)) continue;
        await db.exec(`ALTER TABLE global_games ADD COLUMN ${col.ddl}`);
        added.push(col.name);
    }

    // Partial UNIQUE index. SQLite already treats NULLs as distinct in a
    // UNIQUE index, so the `WHERE` is not what makes the nullable column
    // legal — it keeps the index off the ~30k rows that will never have an
    // `ra_id`, which is nearly all of them.
    await db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_global_games_ra
             ON global_games(ra_id) WHERE ra_id IS NOT NULL`,
    );

    logInfo(
        added.length > 0
            ? `[migration] 133: added global_games columns ${added.join(', ')}`
            : '[migration] 133: global_games RA columns already present',
    );
}
