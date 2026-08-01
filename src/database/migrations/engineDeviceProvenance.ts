import type { Database } from 'sqlite';

/**
 * Migration 125 — engine + device score provenance (ADR 0016, v2.53.0).
 *
 * Splits the conflated `platform` column into two orthogonal axes stored
 * alongside it:
 *   `engine` — what produced the score (determines comparability)
 *   `device` — what it ran on (provenance only)
 *
 * The `platform` column is deliberately NOT dropped: every read path still
 * consumes it through P1/P2 (see the ADR's phase plan), so this migration is
 * purely additive.
 *
 * Backfill is best-effort per ADR 0016's "no backfill — clean break" section:
 * unambiguous legacy values map through `LEGACY_PLATFORM_MAP` (case-normalised,
 * so prod's `ATGAMES`/`VPX`/`VPXS` uppercase rows are covered), and everything
 * else lands on `'unknown'`. `'unknown'` is a first-class value — after this
 * migration NEITHER new column is ever NULL on any existing row.
 *
 * Idempotent: column adds are guarded by PRAGMA table_info, index creation uses
 * IF NOT EXISTS, and the backfill only touches rows where the target is NULL.
 */

function log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[migration] ${line}`);
}

/** Score tables that carry per-row provenance. */
const SCORE_TABLES = ['submissions', 'score_history', 'community_scores', 'global_scores'] as const;

/**
 * Composite indexes mirroring the existing `(<game key>, platform)` shape from
 * migration 084 — same query shape ("scores for game X on engine Y"), same
 * naming convention.
 */
const PROVENANCE_INDEXES: Array<{ name: string; table: string; columns: string }> = [
    { name: 'idx_submissions_game_engine',   table: 'submissions',      columns: 'game_id, engine' },
    { name: 'idx_submissions_game_device',   table: 'submissions',      columns: 'game_id, device' },
    { name: 'idx_score_history_game_engine', table: 'score_history',    columns: 'game_id, engine' },
    { name: 'idx_score_history_game_device', table: 'score_history',    columns: 'game_id, device' },
    { name: 'idx_community_game_engine',     table: 'community_scores', columns: 'game_name, game_room_id, engine' },
    { name: 'idx_community_game_device',     table: 'community_scores', columns: 'game_name, game_room_id, device' },
    { name: 'idx_global_scores_game_engine', table: 'global_scores',    columns: 'global_game_id, engine' },
    { name: 'idx_global_scores_game_device', table: 'global_scores',    columns: 'global_game_id, device' },
];

async function hasColumn(db: Database, table: string, column: string): Promise<boolean> {
    const cols = (await db.all(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
    return cols.some(c => c.name === column);
}

async function addColumnIfMissing(db: Database, table: string, column: string, type = 'TEXT'): Promise<void> {
    if (await hasColumn(db, table, column)) return;
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export async function addEngineDeviceProvenance(db: Database): Promise<void> {
    const { mapLegacyPlatform, UNKNOWN } = await import('../../utils/scoreProvenance.js');

    // --- Schema ---------------------------------------------------------
    for (const table of SCORE_TABLES) {
        await addColumnIfMissing(db, table, 'engine');
        await addColumnIfMissing(db, table, 'device');
    }
    // OAuth-handoff drafts replay the picker selection post-login, so they must
    // carry both axes too — otherwise a stale draft commits an incoherent pair.
    await addColumnIfMissing(db, 'submission_drafts', 'engine');
    await addColumnIfMissing(db, 'submission_drafts', 'device');

    // VESTIGIAL AS OF P2 (2026-07-31) — DO NOT WIRE THESE UP.
    //
    // P1 added these as a tournament-scoped provenance fallback for
    // iScored-polled scores, mirroring `iscored_default_platform`, and the two
    // sync writers (`ScoreSyncPoller`, `TournamentEngine.finalSyncScoresForGame`)
    // read them. P2 §3b removed both reads: the product owner ruled that iScored
    // scores get NO provenance inference of any kind — iScored is a migration
    // stopgap, not a long-term integration, so inference machinery on top of it
    // invests in a path the product intends to retire. Synced scores are always
    // `unknown`/`unknown`; a player who wants provenance enters the score in
    // Arcaid. See ADR 0016, "iScored-synced scores never reach the Global
    // Scoreboard", rule 2.
    //
    // The columns are retained rather than dropped only because a SQLite column
    // drop on `tournaments` needs a create-copy-drop-rename table rebuild, which
    // is not worth the risk for two inert, always-NULL columns. Nothing reads
    // them, no admin UI writes them, and no backfill exists. `iscored_default_
    // platform` (added earlier, still read) is deliberately unaffected.
    await addColumnIfMissing(db, 'tournaments', 'iscored_default_engine');
    await addColumnIfMissing(db, 'tournaments', 'iscored_default_device');

    for (const idx of PROVENANCE_INDEXES) {
        await db.exec(`CREATE INDEX IF NOT EXISTS ${idx.name} ON ${idx.table}(${idx.columns})`);
    }

    // --- Backfill -------------------------------------------------------
    // One UPDATE per distinct legacy platform value per table (prod has a
    // handful: ATGAMES, vpx, VPX, VPXS, real, …), then a sweep that stamps
    // 'unknown' on everything left — NULL platform rows included.
    await db.exec('BEGIN');
    try {
        for (const table of [...SCORE_TABLES, 'submission_drafts']) {
            const distinct = (await db.all(
                `SELECT DISTINCT platform AS p FROM ${table} WHERE platform IS NOT NULL AND TRIM(platform) != ''`,
            )) as Array<{ p: string }>;

            const mapped: Record<string, number> = {};
            for (const row of distinct) {
                const { engine, device } = mapLegacyPlatform(row.p);
                const res = await db.run(
                    `UPDATE ${table}
                        SET engine = ?, device = ?
                      WHERE (engine IS NULL OR device IS NULL)
                        AND platform = ?`,
                    engine, device, row.p,
                );
                mapped[`${row.p}→${engine}/${device}`] = res.changes ?? 0;
            }

            const sweep = await db.run(
                `UPDATE ${table}
                    SET engine = COALESCE(engine, ?), device = COALESCE(device, ?)
                  WHERE engine IS NULL OR device IS NULL`,
                UNKNOWN, UNKNOWN,
            );

            log(`125: ${table} — mapped ${JSON.stringify(mapped)}; unknown-swept ${sweep.changes ?? 0}`);
        }
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    // Post-condition: no NULLs survive in either column on any score table.
    for (const table of SCORE_TABLES) {
        const row = (await db.get(
            `SELECT COUNT(*) AS n FROM ${table} WHERE engine IS NULL OR device IS NULL`,
        )) as { n: number };
        if (row.n > 0) {
            throw new Error(`migration 125: ${table} still has ${row.n} row(s) with NULL engine/device`);
        }
    }
}
