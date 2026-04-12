/**
 * Reimport Catalogue Script
 *
 * Greenfield reset for the global_games catalogue:
 *   1. Truncates global_games and all tables that reference it (unless --no-truncate)
 *   2. Re-runs VPS, OPDB, IGDB, Wizard imports in sequence using the fixed upsert
 *   3. Prints before/after row counts
 *
 * Usage:
 *   npx tsx scripts/reimport-catalogue.ts                 # run all sources, full truncate
 *   npx tsx scripts/reimport-catalogue.ts --skip-opdb     # skip OPDB (rate limit: 1/hr)
 *   npx tsx scripts/reimport-catalogue.ts --skip-igdb     # skip IGDB (slow — full run takes hours)
 *   npx tsx scripts/reimport-catalogue.ts --igdb-limit 500  # cap IGDB at N rows for sampled dev imports
 *   npx tsx scripts/reimport-catalogue.ts --no-truncate   # add to existing catalogue without wiping
 *   npx tsx scripts/reimport-catalogue.ts --dry-run       # show what would be deleted, do nothing
 *
 * The truncate step also nulls out global_game_id references on games and
 * game_room_game_library so there are no dangling foreign keys.
 *
 * Sampled IGDB workflow (e.g. local dev top-up after the Frankenstein fix):
 *   npx tsx scripts/reimport-catalogue.ts \
 *     --skip-vps --skip-opdb --skip-wizard --no-truncate --igdb-limit 500
 */

import dotenv from 'dotenv';
dotenv.config();

import { initDatabase, getDatabase } from '../src/database/database.js';
import { VpsImportService } from '../src/services/VpsImportService.js';
import { OPDBImportService } from '../src/services/OPDBImportService.js';
import { IGDBImportService } from '../src/services/IGDBImportService.js';
import { WizardImportService } from '../src/services/WizardImportService.js';

async function loadSettingsIntoEnv(): Promise<void> {
    // Mirrors src/index.ts bootstrap step 1.5 — DB settings override .env at runtime
    const db = await getDatabase();
    const rows = await db.all('SELECT key, value FROM settings');
    for (const row of rows) {
        process.env[row.key] = row.value;
    }
}

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_VPS = args.includes('--skip-vps');
const SKIP_OPDB = args.includes('--skip-opdb');
const SKIP_IGDB = args.includes('--skip-igdb');
const SKIP_WIZARD = args.includes('--skip-wizard');
const NO_TRUNCATE = args.includes('--no-truncate');

function parseFlagValue(flag: string): number | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1) return undefined;
    const raw = args[idx + 1];
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
}

const IGDB_LIMIT = parseFlagValue('--igdb-limit');

async function countRows(): Promise<{
    global_games: number;
    global_scores: number;
    global_leaderboard_cache: number;
    games_linked: number;
    library_linked: number;
}> {
    const db = await getDatabase();
    const gg = await db.get('SELECT COUNT(*) AS n FROM global_games');
    const gs = await db.get('SELECT COUNT(*) AS n FROM global_scores');
    const gc = await db.get('SELECT COUNT(*) AS n FROM global_leaderboard_cache');
    const games = await db.get('SELECT COUNT(*) AS n FROM games WHERE global_game_id IS NOT NULL');
    const lib = await db.get('SELECT COUNT(*) AS n FROM game_room_game_library WHERE global_game_id IS NOT NULL');
    return {
        global_games: gg?.n ?? 0,
        global_scores: gs?.n ?? 0,
        global_leaderboard_cache: gc?.n ?? 0,
        games_linked: games?.n ?? 0,
        library_linked: lib?.n ?? 0,
    };
}

async function truncateCatalogue(): Promise<void> {
    const db = await getDatabase();
    await db.exec('BEGIN TRANSACTION');
    try {
        // Null out FK references first to avoid orphaning
        await db.run('UPDATE games SET global_game_id = NULL WHERE global_game_id IS NOT NULL');
        await db.run('UPDATE game_room_game_library SET global_game_id = NULL WHERE global_game_id IS NOT NULL');

        // Purge global catalogue tables
        await db.run('DELETE FROM global_leaderboard_cache');
        await db.run('DELETE FROM score_reports');
        await db.run('DELETE FROM global_scores');
        await db.run('DELETE FROM global_games');

        // Clear sync_logs so the admin dashboard only shows the fresh imports
        await db.run('DELETE FROM sync_logs');

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }
}

async function withTimer<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    console.log(`\n▶ ${label}...`);
    try {
        const result = await fn();
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`✔ ${label} — ${elapsed}s`);
        return result;
    } catch (err) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.error(`✘ ${label} failed after ${elapsed}s:`, err);
        throw err;
    }
}

async function main() {
    console.log('Reimport Catalogue');
    console.log('==================');
    if (DRY_RUN) console.log('** DRY RUN — no changes will be made **');
    console.log(`Skip flags: vps=${SKIP_VPS} opdb=${SKIP_OPDB} igdb=${SKIP_IGDB} wizard=${SKIP_WIZARD}`);
    console.log(`Truncate: ${NO_TRUNCATE ? 'NO (additive)' : 'yes'}`);
    if (IGDB_LIMIT) console.log(`IGDB sample limit: ${IGDB_LIMIT}`);

    await initDatabase();
    await loadSettingsIntoEnv();

    const before = await countRows();
    console.log('\nBefore:');
    console.table(before);

    if (DRY_RUN) {
        console.log('\nDry run — exiting without changes.');
        process.exit(0);
    }

    // Truncate (skip when --no-truncate so we can additively top up an existing catalogue)
    if (!NO_TRUNCATE) {
        await withTimer('Truncating global catalogue', truncateCatalogue);
    } else {
        console.log('\n⊘ Skipping truncate — existing rows will be preserved');
    }

    // Run imports in the order that lets cross-refs build up naturally
    const results: Record<string, any> = {};

    if (!SKIP_VPS) {
        results.vps = await withTimer('VPS import', () => VpsImportService.importFromVps());
    } else {
        console.log('⊘ Skipping VPS');
    }

    if (!SKIP_OPDB) {
        try {
            results.opdb = await withTimer('OPDB import', () => OPDBImportService.importFromOPDB());
        } catch (err) {
            // OPDB rate-limits at 1 hour per key. If we hit it, continue without OPDB.
            console.warn('OPDB import failed (continuing):', (err as Error).message);
            results.opdb = { error: (err as Error).message };
        }
    } else {
        console.log('⊘ Skipping OPDB');
    }

    if (!SKIP_WIZARD) {
        results.wizard = await withTimer('Wizard import', () => WizardImportService.importFromWizard());
    } else {
        console.log('⊘ Skipping Wizard');
    }

    if (!SKIP_IGDB) {
        try {
            const label = IGDB_LIMIT ? `IGDB import (sampled, limit=${IGDB_LIMIT})` : 'IGDB import';
            results.igdb = await withTimer(label, () => IGDBImportService.importFromIGDB(IGDB_LIMIT ? { limit: IGDB_LIMIT } : undefined));
        } catch (err) {
            console.warn('IGDB import failed (continuing):', (err as Error).message);
            results.igdb = { error: (err as Error).message };
        }
    } else {
        console.log('⊘ Skipping IGDB');
    }

    const after = await countRows();
    console.log('\nAfter:');
    console.table(after);

    console.log('\nImport results:');
    for (const [source, data] of Object.entries(results)) {
        console.log(`  ${source}:`, JSON.stringify(data));
    }

    console.log('\n✔ Reimport complete. Run scripts/analyze-catalogue.ts to verify zero Frankensteins.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Reimport failed:', err);
    process.exit(1);
});
