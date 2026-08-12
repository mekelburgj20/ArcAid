import fs from 'fs';
import path from 'path';
import { initDatabase, getDatabase } from '../database/database.js';
import { deleteScorePhotoFiles, SCORE_PHOTOS_ROOT } from '../utils/scorePhotoCleanup.js';

/**
 * LAUNCH RESET — zero every score-derived artifact, keep rooms/structure/identity.
 *
 * v2.101.0 (2026-08-12): expanded from the original six-table skeleton into the
 * full pre-launch wipe, per the owner-signed scope (session marker #56):
 *
 *   WIPED: all four score tables + legacy `scores`, all three caches,
 *   score-derived ledgers (achievements, milestone dedup, lobby feed, room
 *   events, maintenance runs, drafts, score reports, suppression tombstones),
 *   ALL `games` rows (tournament history + pins — owner decision), rotation
 *   state (picker_dispositions, rotation_nudges), merge/anon-identity records,
 *   ban CONTENT actions (bans themselves stay), comments/tips/ratings (room +
 *   catalogue) + their reports, content reports, score photos on disk AND in
 *   the append-only assets-mirror (else a future restore resurrects them).
 *
 *   KEPT: game_rooms + settings, tournaments (structure; optionally
 *   deactivated — see below), ranking_groups, users/profiles/identity links,
 *   members/admins, bans, sessions, push subscriptions, friendships, the
 *   whole catalogue, styles, notification prefs, audit_log (the wipe itself
 *   stays auditable), schema_migrations (NEVER truncate — migration ledger).
 *
 * Delete order is FK-safe under `PRAGMA foreign_keys = ON` (which initDatabase
 * enables): caches and `scores`/`submissions` carry real FKs to `games`, so
 * they go first and `games` goes last; `merge_records` FKs
 * `anonymous_identities` so it precedes it. See the migration-128 module
 * (`src/database/migrations/purgeSyncAndUnknownScores.ts`) for the fuller
 * FK/soft-ref audit this ordering derives from.
 *
 * Boot notes (from the pre-wipe inventory):
 *  - Deleting all `games` rows severs every iScored link — the sync poller
 *    finds no local match and skips, so nothing re-imports even if the linked
 *    board still has scores. Belt-and-braces: keep ISCORED off for first boot.
 *  - Cron rotation would create fresh game slots for ACTIVE tournaments on
 *    first boot, BEFORE the board is rebuilt — pass
 *    WIPE_DEACTIVATE_TOURNAMENTS=yes to set every tournament is_active=0;
 *    re-enable each one from the admin Tournaments page while rebuilding.
 *  - `PRAGMA foreign_key_check` runs here AND at every boot — a clean start
 *    log is the free post-wipe verification.
 *
 * USAGE (app STOPPED — single connection, no poller racing you). Lives in
 * src/ (not the repo-root scripts/ dir) so tsc emits it into the prod image:
 *   docker compose stop arcaid
 *   docker compose run --rm --no-deps \
 *     -e CONFIRM_WIPE_SCORES=yes [-e WIPE_DEACTIVATE_TOURNAMENTS=yes] \
 *     arcaid node dist/scripts/wipe-test-scores.js
 *
 * IRREVERSIBLE. Create + verify a backup first (`POST /api/admin/backups`,
 * then `npm run restore -- --verify <folder>`), and copy it off-box.
 */

/** FK-safe delete order. Comment on the right = why it sits where it does. */
const WIPE_TABLES = [
    // 1. caches (leaderboard_cache has a NOT NULL FK -> games)
    'leaderboard_cache',
    'global_leaderboard_cache',
    'ranking_groups_cache',
    // 2. score children with real FKs -> games (scores.game_id is NOT NULL)
    'scores',
    'submissions',
    // 3. score tables without FKs to games
    'score_history',
    'community_scores',
    'score_reports',
    'global_scores',
    // 4. score-derived ledgers / feeds
    'player_achievements',
    'player_milestones_fired',
    'deleted_score_suppressions',
    'lobby_feed_events',
    'submission_drafts',
    'room_events',
    'maintenance_runs',
    'ban_content_actions',
    'merge_records',          // FK -> anonymous_identities: must precede it
    'anonymous_identities',
    // 5. user content (owner sign-off 2026-08-12: comments/ratings/reports go)
    'game_comments',
    'game_ratings',
    'global_game_comments',
    'global_game_ratings',
    'comment_reports',
    'content_reports',
    // 6. rotation state (FK -> tournaments CASCADE; explicit for clarity)
    'picker_dispositions',
    'rotation_nudges',
    // 7. games LAST (its FK children are gone). Tournaments are NOT touched.
    'games',
] as const;

/** Sanity spot-checks: these must be non-zero before AND after (kept tables). */
const KEEP_SPOT_CHECKS = ['game_rooms', 'tournaments', 'user_profiles', 'global_games'] as const;

async function tableCount(table: string): Promise<number> {
    const db = await getDatabase();
    const row = await db.get(`SELECT COUNT(*) as n FROM ${table}`);
    return row?.n || 0;
}

/** Remove every file under `dir` (non-recursive dirs removed too); returns count. */
function sweepDirectory(dir: string): number {
    if (!fs.existsSync(dir)) return 0;
    let removed = 0;
    for (const entry of fs.readdirSync(dir)) {
        const p = path.join(dir, entry);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            removed += sweepDirectory(p);
            fs.rmdirSync(p);
        } else {
            fs.unlinkSync(p);
            removed++;
        }
    }
    return removed;
}

async function main() {
    if (process.env.CONFIRM_WIPE_SCORES !== 'yes') {
        console.error('Refusing to wipe: set CONFIRM_WIPE_SCORES=yes to proceed.');
        console.error('This is the LAUNCH RESET — it deletes ALL rows from:');
        console.error(`  ${WIPE_TABLES.join(', ')}`);
        console.error('plus score photos on disk and in the assets-mirror.');
        console.error('Optional: WIPE_DEACTIVATE_TOURNAMENTS=yes sets every tournament inactive.');
        process.exit(1);
    }

    await initDatabase();
    const db = await getDatabase();

    console.log('Pre-wipe row counts:');
    for (const t of WIPE_TABLES) console.log(`  ${t}: ${await tableCount(t)}`);
    console.log('Kept-table spot checks (must be unchanged after):');
    const keepBefore: Record<string, number> = {};
    for (const t of KEEP_SPOT_CHECKS) {
        keepBefore[t] = await tableCount(t);
        console.log(`  ${t}: ${keepBefore[t]}`);
    }

    // Collect photo references BEFORE deleting the rows that hold them
    // (AccountDeletionService pattern: unlink AFTER commit).
    const photoUrls: Array<string | null> = [];
    for (const t of ['submissions', 'score_history', 'community_scores', 'global_scores']) {
        const rows = await db.all(`SELECT photo_url FROM ${t} WHERE photo_url IS NOT NULL`);
        for (const r of rows) photoUrls.push(r.photo_url);
    }
    const draftPhotoPaths = (await db.all(
        `SELECT photo_path FROM submission_drafts WHERE photo_path IS NOT NULL`,
    )).map((r: { photo_path: string }) => r.photo_path);

    await db.exec('BEGIN TRANSACTION');
    try {
        for (const t of WIPE_TABLES) {
            const result = await db.run(`DELETE FROM ${t}`);
            console.log(`  wiped ${t}: ${result.changes ?? 0} rows`);
        }
        if (process.env.WIPE_DEACTIVATE_TOURNAMENTS === 'yes') {
            const result = await db.run('UPDATE tournaments SET is_active = 0');
            console.log(`  deactivated ${result.changes ?? 0} tournaments (re-enable per-tournament in the admin UI while rebuilding the board)`);
        }
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    // Photos: targeted unlinks first (traversal-guarded util), then sweep any
    // leftovers under score-photos, then the assets-mirror copy — the mirror
    // is deliberately append-only, so without this a future `npm run restore`
    // would quietly copy every pre-wipe photo back onto disk.
    const unlinked = deleteScorePhotoFiles(photoUrls);
    for (const p of draftPhotoPaths) {
        try { fs.unlinkSync(p); } catch { /* already gone */ }
    }
    const swept = sweepDirectory(SCORE_PHOTOS_ROOT);
    const mirror = path.join(process.cwd(), 'backups', 'assets-mirror', 'score-photos');
    const mirrorSwept = sweepDirectory(mirror);
    console.log(`Photos: ${unlinked} unlinked, ${swept} leftover files swept, ${mirrorSwept} mirror files swept, ${draftPhotoPaths.length} draft photos removed.`);

    const fkViolations = await db.all('PRAGMA foreign_key_check');
    if (fkViolations.length > 0) {
        console.error(`FOREIGN KEY CHECK FAILED — ${fkViolations.length} violations:`);
        for (const v of fkViolations.slice(0, 20)) console.error(' ', JSON.stringify(v));
        process.exit(1);
    }
    console.log('foreign_key_check: clean (0 violations).');

    console.log('Post-wipe verification:');
    let bad = false;
    for (const t of WIPE_TABLES) {
        const n = await tableCount(t);
        if (n !== 0) { console.error(`  ${t}: ${n} rows REMAIN (expected 0)`); bad = true; }
    }
    for (const t of KEEP_SPOT_CHECKS) {
        const n = await tableCount(t);
        const ok = n === keepBefore[t];
        console.log(`  ${t}: ${n} (${ok ? 'unchanged' : `WAS ${keepBefore[t]} — MISMATCH`})`);
        if (!ok) bad = true;
    }
    if (bad) process.exit(1);

    console.log('LAUNCH RESET complete.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Wipe failed (transaction rolled back):', err);
    process.exit(1);
});
