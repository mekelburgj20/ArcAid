import { initDatabase, getDatabase } from '../src/database/database.js';

/**
 * Wipe all score data across the four score tables plus their caches.
 *
 * Intended as a manual clean-slate tool before activating the Sprint 1
 * context-capture columns. Per Q1 answer: null-out legacy rows is the default;
 * this script is shipped for operators who prefer a fresh start.
 *
 * USAGE (container):
 *   docker compose exec arcaid node dist/scripts/wipe-test-scores.js
 *   docker compose exec arcaid npx tsx scripts/wipe-test-scores.ts
 *
 * IRREVERSIBLE. Back up data/arcaid.db before running.
 */
async function main() {
    const confirm = process.env.CONFIRM_WIPE_SCORES === 'yes';
    if (!confirm) {
        console.error('Refusing to wipe: set CONFIRM_WIPE_SCORES=yes to proceed.');
        console.error('This will delete ALL rows from:');
        console.error('  submissions, community_scores, score_history, global_scores,');
        console.error('  leaderboard_cache, global_leaderboard_cache');
        process.exit(1);
    }

    await initDatabase();
    const db = await getDatabase();

    const counts = {
        submissions: 0,
        community_scores: 0,
        score_history: 0,
        global_scores: 0,
        leaderboard_cache: 0,
        global_leaderboard_cache: 0,
    };

    for (const table of Object.keys(counts) as Array<keyof typeof counts>) {
        const row = await db.get(`SELECT COUNT(*) as n FROM ${table}`);
        counts[table] = row?.n || 0;
    }

    console.log('Pre-wipe row counts:');
    for (const [t, n] of Object.entries(counts)) console.log(`  ${t}: ${n}`);

    await db.exec(`
        DELETE FROM submissions;
        DELETE FROM community_scores;
        DELETE FROM score_history;
        DELETE FROM global_scores;
        DELETE FROM leaderboard_cache;
        DELETE FROM global_leaderboard_cache;
    `);

    console.log('Wipe complete. All score tables and caches emptied.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Wipe failed:', err);
    process.exit(1);
});
