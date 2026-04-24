import type { Database } from 'sqlite';

/**
 * Migration handlers for Sprint v2.4.0 — catalogue unification + pin feature.
 *
 * Each export is the body of a `{ name, handler }` entry in the main
 * migrations array in database.ts. Handlers throw on failure, halting startup
 * — a botched backfill must never be silently skipped.
 *
 * Ordering (enforced by the migrations array):
 *   068 → auditAndCreateGlobalGamesUniqueIndex
 *   069 → backfillGlobalGameId
 *   070 → deleteLegacyOrphanGames
 */

/**
 * Logs to stderr without pulling the full logger dependency in here — we want
 * this module to remain near-zero-deps so it can run early in startup.
 */
function log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[migration] ${line}`);
}

/**
 * Migration 068 — close the read-check-insert race in `GlobalGameService.upsert`
 * by adding a UNIQUE INDEX on (LOWER(name), type). Precedent: migration 059
 * (anonymous_identities).
 *
 * Duplicates from legacy imports (pre-Frankenstein-fix, 2026-04-10) would
 * make the index creation fail. We auto-merge those first: within each
 * duplicate group, pick the row with the most external IDs (opdb + vps +
 * igdb) as canonical, break ties by earliest `created_at`, and fold others
 * in via `GlobalGameService.merge()` — which already cascades references
 * across global_scores, game_room_game_library, games, and leaderboard cache.
 */
export async function auditAndCreateGlobalGamesUniqueIndex(db: Database): Promise<void> {
    const duplicates = (await db.all(`
        SELECT LOWER(name) AS name_key, type, COUNT(*) AS n
        FROM global_games
        GROUP BY LOWER(name), type
        HAVING COUNT(*) > 1
    `)) as Array<{ name_key: string; type: string; n: number }>;

    if (duplicates.length > 0) {
        log(`068: auto-merging ${duplicates.length} duplicate (name,type) group(s) in global_games`);
        const { GlobalGameService } = await import('../../services/GlobalGameService.js');

        // Loop up to 3 passes — if merge transitively exposes new duplicates
        // (e.g. two rows match another row via external ID cascade), a single
        // sweep can leave residue. Three passes is generous; real data should
        // converge in one.
        for (let pass = 1; pass <= 3; pass++) {
            const groups = (await db.all(`
                SELECT LOWER(name) AS name_key, type, COUNT(*) AS n
                FROM global_games
                GROUP BY LOWER(name), type
                HAVING COUNT(*) > 1
            `)) as Array<{ name_key: string; type: string; n: number }>;
            if (groups.length === 0) {
                log(`068: pass ${pass} — no duplicates remaining`);
                break;
            }
            log(`068: pass ${pass} — ${groups.length} group(s) to merge`);

            for (const group of groups) {
                const rows = (await db.all(
                    `SELECT id, opdb_id, vps_id, igdb_id, created_at
                     FROM global_games
                     WHERE LOWER(name) = ? AND type = ?`,
                    group.name_key, group.type,
                )) as Array<{ id: string; opdb_id: string | null; vps_id: string | null; igdb_id: number | null; created_at: string | null }>;

                rows.sort((a, b) => {
                    const aScore = (a.opdb_id ? 1 : 0) + (a.vps_id ? 1 : 0) + (a.igdb_id ? 1 : 0);
                    const bScore = (b.opdb_id ? 1 : 0) + (b.vps_id ? 1 : 0) + (b.igdb_id ? 1 : 0);
                    if (aScore !== bScore) return bScore - aScore;
                    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
                });

                const canonical = rows[0]!;
                for (let i = 1; i < rows.length; i++) {
                    const duplicate = rows[i]!;
                    try {
                        await GlobalGameService.merge(canonical.id, duplicate.id);
                    } catch (err) {
                        log(`068: merge failed for ${duplicate.id} → ${canonical.id} (name='${group.name_key}', type='${group.type}'): ${err}`);
                        throw err;
                    }
                }
            }
        }

        // Final check — if anything survives the 3-pass loop, abort with
        // diagnostics so an admin can resolve manually.
        const residual = (await db.all(`
            SELECT LOWER(name) AS name_key, type, COUNT(*) AS n, GROUP_CONCAT(id) AS ids
            FROM global_games
            GROUP BY LOWER(name), type
            HAVING COUNT(*) > 1
        `)) as Array<{ name_key: string; type: string; n: number; ids: string }>;
        if (residual.length > 0) {
            for (const r of residual) {
                log(`068: UNRESOLVED (name='${r.name_key}', type='${r.type}') ids=[${r.ids}]`);
            }
            throw new Error(`Migration 068: ${residual.length} duplicate group(s) survived the merge loop — see logs above for IDs.`);
        }
    }

    await db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_global_games_name_type
         ON global_games(LOWER(name), type)`,
    );
    log('068: created idx_global_games_name_type');
}

/**
 * Migration 069 — backfill `global_game_id` on `games`, `game_library`, and
 * `game_room_game_library` rows that have NULL FK.
 *
 * Type-aware: `games.name` has no type/mode column; we resolve it from
 * `tournaments.mode` via `tournament_id`. Defaulting to 'pinball' for rows
 * without a tournament would silently merge "Tron" pinball with "Tron"
 * video_game under step 4 of the upsert hierarchy (name-match). We use NULL
 * for orphan games (tournament_id IS NULL) — they get handled by migration
 * 070 anyway.
 *
 * Wrapped in a single transaction so the ScoreSyncPoller or a live score
 * fan-out only ever sees pre- or post-state, never half-state.
 *
 * Idempotent: rows with non-NULL `global_game_id` are skipped, so a failed
 * re-run picks up only what's left.
 */
export async function backfillGlobalGameId(db: Database): Promise<void> {
    const { GlobalGameService } = await import('../../services/GlobalGameService.js');

    await db.exec('BEGIN TRANSACTION');
    try {
        // --- 1) game_library rows (these carry `mode` directly) ---
        const libraryRows = (await db.all(`
            SELECT name, mode, platforms, image_url
            FROM game_library
            WHERE global_game_id IS NULL
        `)) as Array<{ name: string; mode: string | null; platforms: string | null; image_url: string | null }>;

        let libraryLinked = 0;
        for (const row of libraryRows) {
            const type = row.mode === 'video_game' ? 'video_game' : 'pinball';
            const { id } = await GlobalGameService.upsert({
                name: row.name,
                type,
                platforms: safeJsonArray(row.platforms),
                image_url: row.image_url ?? null,
                status: 'approved',
            });
            await db.run(
                'UPDATE game_library SET global_game_id = ? WHERE name = ?',
                id, row.name,
            );
            libraryLinked++;
        }
        log(`069: linked ${libraryLinked}/${libraryRows.length} game_library rows`);

        // --- 2) game_room_game_library rows (inherit FK from resolved library row) ---
        const grlRows = (await db.all(`
            SELECT grl.game_room_id, grl.game_name, gl.global_game_id AS resolved_fk
            FROM game_room_game_library grl
            LEFT JOIN game_library gl ON gl.name = grl.game_name
            WHERE grl.global_game_id IS NULL
        `)) as Array<{ game_room_id: string; game_name: string; resolved_fk: string | null }>;

        let grlLinked = 0;
        let grlMissed = 0;
        for (const row of grlRows) {
            if (!row.resolved_fk) {
                // Library row has no FK yet — either the room references a
                // game that isn't in game_library, or upsert failed earlier.
                // Attempt direct upsert with minimal info.
                const { id } = await GlobalGameService.upsert({
                    name: row.game_name,
                    type: 'pinball',
                    status: 'approved',
                });
                await db.run(
                    'UPDATE game_room_game_library SET global_game_id = ? WHERE game_room_id = ? AND game_name = ?',
                    id, row.game_room_id, row.game_name,
                );
                grlMissed++;
            } else {
                await db.run(
                    'UPDATE game_room_game_library SET global_game_id = ? WHERE game_room_id = ? AND game_name = ?',
                    row.resolved_fk, row.game_room_id, row.game_name,
                );
                grlLinked++;
            }
        }
        log(`069: linked ${grlLinked}/${grlRows.length} game_room_game_library rows (${grlMissed} required direct upsert)`);

        // --- 3) games rows (type from tournament.mode; orphans get NULL and are cleaned up in 070) ---
        const gameRows = (await db.all(`
            SELECT g.id, g.name, t.mode AS tournament_mode
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.global_game_id IS NULL
              AND g.tournament_id IS NOT NULL
        `)) as Array<{ id: string; name: string; tournament_mode: string | null }>;

        let gamesLinked = 0;
        for (const row of gameRows) {
            const type = row.tournament_mode === 'video_game' ? 'video_game' : 'pinball';
            const { id } = await GlobalGameService.upsert({
                name: row.name,
                type,
                status: 'approved',
            });
            await db.run(
                'UPDATE games SET global_game_id = ? WHERE id = ?',
                id, row.id,
            );
            gamesLinked++;
        }
        log(`069: linked ${gamesLinked}/${gameRows.length} games rows`);

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }
}

/**
 * Migration 070 — delete legacy orphan `games` rows (tournament_id IS NULL,
 * game_room_id IS NULL). These are pre-multi-room artifacts that leaked into
 * Discord `/list-active` output before v2.3.3's INNER-JOIN fix.
 *
 * Pre-audit: if any orphan row has submissions/score_history/global_scores
 * references, UNLINK those rows (SET game_id = NULL) instead of cascading —
 * score history is preserved even when the game row goes away.
 */
export async function deleteLegacyOrphanGames(db: Database): Promise<void> {
    const orphans = (await db.all(`
        SELECT id, name FROM games WHERE tournament_id IS NULL
    `)) as Array<{ id: string; name: string }>;

    if (orphans.length === 0) {
        log('070: no orphan games to delete');
        return;
    }

    log(`070: ${orphans.length} orphan game(s) found: ${orphans.map(o => o.name).join(', ')}`);

    await db.exec('BEGIN TRANSACTION');
    try {
        for (const orphan of orphans) {
            // Unlink references in score-bearing tables before deleting the game.
            const subsUnlinked = await db.run(
                'UPDATE submissions SET game_id = NULL WHERE game_id = ?',
                orphan.id,
            );
            const histUnlinked = await db.run(
                'UPDATE score_history SET game_id = NULL WHERE game_id = ?',
                orphan.id,
            );
            // global_scores.origin_game_id references games.id too — unlink similarly.
            const gsUnlinked = await db.run(
                'UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?',
                orphan.id,
            );
            log(
                `070: orphan ${orphan.id} (${orphan.name}) — unlinked ` +
                `submissions=${subsUnlinked.changes ?? 0}, ` +
                `score_history=${histUnlinked.changes ?? 0}, ` +
                `global_scores=${gsUnlinked.changes ?? 0}`,
            );
            await db.run('DELETE FROM games WHERE id = ?', orphan.id);
        }
        await db.exec('COMMIT');
        log(`070: deleted ${orphans.length} orphan game(s)`);
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }
}

function safeJsonArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}
