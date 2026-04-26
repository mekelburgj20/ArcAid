import type { Database } from 'sqlite';

/**
 * Migration handlers for v2.5.0 — VR + Steam-pinball platform taxonomy expansion.
 *
 * Each export is the body of a `{ name, handler }` entry in the main migrations
 * array in database.ts. Handlers throw on failure, halting startup.
 *
 * Ordering (enforced by the migrations array):
 *   083 → renameFx3ToFxClassic
 *   085 → backfillScorePlatforms
 */

function log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[migration] ${line}`);
}

/**
 * Migration 083 — rename `pinball_fx3` → `pinball_fx_classic` everywhere.
 *
 * Background: Zen Studios' April 2026 rebrand renamed "Pinball FX3" to
 * "Pinball FX Classic" on Steam (FX3 was delisted on consoles). VPS still
 * emits `tableFormat: "FX3"`, but PLATFORM_ALIASES now normalizes 'fx3' →
 * 'pinball_fx_classic' at import time, so re-imports produce the new ID.
 * This migration sweeps already-stored data so nothing is left tagged with
 * the dead identifier.
 *
 * Walks every JSON column that may contain platform identifiers:
 *   - global_games.platforms                    (JSON array)
 *   - game_library.platforms                    (JSON array)
 *   - game_room_game_library.custom_platforms   (JSON array)
 *   - tournaments.platform_rules                (JSON object: { required[], excluded[] })
 *
 * The `games` table does NOT carry its own platforms — games inherit them
 * transitively via `game.name → game_library.platforms` (or via
 * `game.global_game_id → global_games.platforms`). Rewriting game_library +
 * global_games is sufficient to cover game rows.
 *
 * Idempotent: running twice is a no-op (no rows match `LIKE '%pinball_fx3%'`
 * after the first pass).
 */
export async function renameFx3ToFxClassic(db: Database): Promise<void> {
    const FROM = 'pinball_fx3';
    const TO = 'pinball_fx_classic';

    /**
     * Replace FROM with TO inside an array of strings. Preserves order;
     * dedupes if both old and new IDs were already present (which can happen
     * if some workflow tagged a row with both during the rename window).
     */
    function replaceInArray(arr: unknown): { changed: boolean; out: string[] } {
        if (!Array.isArray(arr)) return { changed: false, out: [] };
        let changed = false;
        const seen = new Set<string>();
        const out: string[] = [];
        for (const v of arr) {
            const next = v === FROM ? TO : v;
            if (next !== v) changed = true;
            if (typeof next === 'string' && !seen.has(next)) {
                seen.add(next);
                out.push(next);
            } else if (typeof next === 'string' && seen.has(next)) {
                // Dedup collapsed two entries into one — record as a change.
                changed = true;
            }
        }
        return { changed, out };
    }

    type ArrayColumn = { table: string; column: string };
    const arrayColumns: ArrayColumn[] = [
        { table: 'global_games',           column: 'platforms' },
        { table: 'game_library',           column: 'platforms' },
        { table: 'game_room_game_library', column: 'custom_platforms' },
    ];

    for (const { table, column } of arrayColumns) {
        const rows = (await db.all(
            `SELECT rowid AS rid, ${column} AS json FROM ${table} WHERE ${column} LIKE ?`,
            `%${FROM}%`
        )) as Array<{ rid: number; json: string | null }>;
        let n = 0;
        for (const row of rows) {
            let parsed: unknown;
            try { parsed = JSON.parse(row.json ?? '[]'); } catch { continue; }
            const { changed, out } = replaceInArray(parsed);
            if (changed) {
                await db.run(
                    `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
                    JSON.stringify(out),
                    row.rid
                );
                n++;
            }
        }
        log(`083: ${table}.${column} — rewrote ${n} row(s)`);
    }

    // tournaments.platform_rules has shape { required: string[], excluded: string[] }
    const trows = (await db.all(
        `SELECT rowid AS rid, platform_rules AS json FROM tournaments WHERE platform_rules LIKE ?`,
        `%${FROM}%`
    )) as Array<{ rid: number; json: string | null }>;
    let nt = 0;
    for (const row of trows) {
        let parsed: { required?: unknown; excluded?: unknown } = {};
        try { parsed = JSON.parse(row.json ?? '{}'); } catch { continue; }
        const req = replaceInArray(parsed.required);
        const exc = replaceInArray(parsed.excluded);
        if (req.changed || exc.changed) {
            const next = { ...parsed, required: req.out, excluded: exc.out };
            await db.run(
                `UPDATE tournaments SET platform_rules = ? WHERE rowid = ?`,
                JSON.stringify(next),
                row.rid
            );
            nt++;
        }
    }
    log(`083: tournaments.platform_rules — rewrote ${nt} row(s)`);
}

/**
 * Migration 085 — best-effort backfill of `platform` on legacy score rows.
 *
 * For each score table, a row gets a platform stamp ONLY if the source game
 * has exactly 1 platform configured. Multi-platform games stay NULL — the
 * leaderboard UI will render those as "Platform unknown" until an admin
 * triggers a bulk re-tag (a follow-up tool, not in this bundle).
 *
 * Source-game lookup per table:
 *   - submissions       → game_library.platforms via games.name (case-insensitive)
 *   - score_history     → game_library.platforms via games.name (case-insensitive)
 *                         (rows with NULL game_id stay NULL — those are
 *                         community-source entries; the equivalent rows in
 *                         community_scores carry the platform.)
 *   - global_scores     → global_games.platforms via global_scores.global_game_id
 *   - community_scores  → mergeEffectivePlatforms(game_library.platforms,
 *                                                 game_room_game_library.custom_platforms)
 *                         keyed on (game_room_id, game_name).
 *
 * Note: the `games` table has no `platforms` column of its own. Games inherit
 * via the joined library row (PK = name). The submissions/score_history
 * backfill therefore joins games → game_library to read platforms.
 *
 * Wrapped in a single transaction so a partial failure rolls back cleanly.
 * Idempotent — re-running is a no-op (only updates rows where platform IS NULL).
 */
export async function backfillScorePlatforms(db: Database): Promise<void> {
    await db.exec('BEGIN');
    try {
        // submissions — join games → game_library by name to read platforms.
        const sub = await db.run(`
            UPDATE submissions
               SET platform = (
                   SELECT json_extract(gl.platforms, '$[0]')
                   FROM games g
                   JOIN game_library gl ON LOWER(gl.name) = LOWER(g.name)
                   WHERE g.id = submissions.game_id
                     AND gl.platforms IS NOT NULL
                     AND json_array_length(gl.platforms) = 1
               )
             WHERE platform IS NULL
               AND game_id IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM games g
                   JOIN game_library gl ON LOWER(gl.name) = LOWER(g.name)
                   WHERE g.id = submissions.game_id
                     AND gl.platforms IS NOT NULL
                     AND json_array_length(gl.platforms) = 1
               )
        `);
        log(`085: submissions — resolved ${sub.changes ?? 0}`);

        // score_history (game_id-bound rows only — community-sourced rows with
        // NULL game_id are covered by the community_scores pass below for the
        // canonical row; score_history copies of those stay NULL by design).
        const shByGameId = await db.run(`
            UPDATE score_history
               SET platform = (
                   SELECT json_extract(gl.platforms, '$[0]')
                   FROM games g
                   JOIN game_library gl ON LOWER(gl.name) = LOWER(g.name)
                   WHERE g.id = score_history.game_id
                     AND gl.platforms IS NOT NULL
                     AND json_array_length(gl.platforms) = 1
               )
             WHERE platform IS NULL
               AND game_id IS NOT NULL
               AND EXISTS (
                   SELECT 1 FROM games g
                   JOIN game_library gl ON LOWER(gl.name) = LOWER(g.name)
                   WHERE g.id = score_history.game_id
                     AND gl.platforms IS NOT NULL
                     AND json_array_length(gl.platforms) = 1
               )
        `);
        log(`085: score_history (via game_id) — resolved ${shByGameId.changes ?? 0}`);

        // global_scores — via global_game_id → global_games.platforms.
        const gs = await db.run(`
            UPDATE global_scores
               SET platform = (
                   SELECT json_extract(global_games.platforms, '$[0]')
                   FROM global_games
                   WHERE global_games.id = global_scores.global_game_id
                     AND global_games.platforms IS NOT NULL
                     AND json_array_length(global_games.platforms) = 1
               )
             WHERE platform IS NULL
               AND EXISTS (
                   SELECT 1 FROM global_games
                   WHERE global_games.id = global_scores.global_game_id
                     AND global_games.platforms IS NOT NULL
                     AND json_array_length(global_games.platforms) = 1
               )
        `);
        log(`085: global_scores — resolved ${gs.changes ?? 0}`);

        // community_scores — join needs the per-room overlay merge, which has
        // case-insensitive Set-dedup logic that's awkward in pure SQL. Pull the
        // candidate rows + their overlay sources and apply the merge in JS.
        // Each (game_room_id, game_name) pair is queried at most once so the
        // total work is bounded by the number of distinct (room, game) groups.
        const { mergeEffectivePlatforms } = await import('../../utils/platformRules.js');
        const groups = (await db.all(`
            SELECT DISTINCT cs.game_room_id, cs.game_name
            FROM community_scores cs
            WHERE cs.platform IS NULL
        `)) as Array<{ game_room_id: string; game_name: string }>;

        let csResolved = 0;
        for (const g of groups) {
            const overlay = (await db.get(`
                SELECT gl.platforms AS lib, grgl.custom_platforms AS custom
                FROM game_room_game_library grgl
                JOIN game_library gl ON gl.name = grgl.game_name
                WHERE grgl.game_room_id = ? AND LOWER(gl.name) = LOWER(?)
                LIMIT 1
            `, g.game_room_id, g.game_name)) as { lib: string | null; custom: string | null } | undefined;
            if (!overlay) continue;
            const merged = mergeEffectivePlatforms(overlay.lib, overlay.custom);
            if (merged.length !== 1) continue;
            const r = await db.run(
                `UPDATE community_scores
                    SET platform = ?
                  WHERE platform IS NULL
                    AND game_room_id = ?
                    AND LOWER(game_name) = LOWER(?)`,
                merged[0], g.game_room_id, g.game_name,
            );
            csResolved += r.changes ?? 0;
        }
        log(`085: community_scores — resolved ${csResolved}`);

        // Final NULL counts so the migration log captures what the backfill couldn't reach.
        const ambiguous = {
            submissions:      ((await db.get(`SELECT COUNT(*) AS n FROM submissions WHERE platform IS NULL`)) as { n: number }).n,
            score_history:    ((await db.get(`SELECT COUNT(*) AS n FROM score_history WHERE platform IS NULL`)) as { n: number }).n,
            community_scores: ((await db.get(`SELECT COUNT(*) AS n FROM community_scores WHERE platform IS NULL`)) as { n: number }).n,
            global_scores:    ((await db.get(`SELECT COUNT(*) AS n FROM global_scores WHERE platform IS NULL`)) as { n: number }).n,
        };
        log(`085: ambiguous_left_null — ${JSON.stringify(ambiguous)}`);

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }
}
