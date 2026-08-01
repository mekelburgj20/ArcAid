import type { Database } from 'sqlite';
import { foldCataloguePlatforms } from '../../utils/scoreProvenance.js';

/**
 * Migration 129 — `global_games.platforms` becomes an ENGINE list (ADR 0016
 * §"Catalogue describes engines, not devices"; catalogue-phase contract §3).
 *
 * Data-only; no schema change. Both columns already exist and both are JSON
 * arrays.
 *
 * ### What moves, and why
 *
 * `platforms` conflated "what this table was authored for" with "what it
 * happens to be available on". `vpxs` is the VPX engine plus *also ships as a
 * standalone build*; `zaccaria_vr` is Zaccaria plus *a VR edition exists*;
 * `bam` is Future Pinball plus *requires BAM*. The engine half stays in
 * `platforms`, the availability half moves to `features` — the same column the
 * 8 AtGames cabinet variants already live in, so this follows migration 101's
 * platforms→features precedent rather than inventing a home.
 *
 * The transform is `foldCataloguePlatforms` — deliberately NOT a frozen copy of
 * the fold table. Migrations normally freeze their transform (see
 * `platformTaxonomyExpansion`, and `parseTournamentRules`'s note about the
 * migration parses staying raw), because a migration must not change what it
 * persists when shared code evolves. This one is the exception ON PURPOSE: the
 * whole point of the phase is that the migration and all seven importers apply
 * ONE fold. A frozen copy here is exactly the drift that hazard H-F describes —
 * the migration cleans the catalogue and the next importer run re-pollutes it.
 * The fold is additionally idempotent, so a later fold-table addition re-applied
 * by an importer converges with what this wrote rather than fighting it.
 *
 * ### Ordering
 *
 * Meaningful only with the importer changes (contract §5) in the same release.
 * Alone it is undone by the next sync, because `GlobalGameService.upsert`
 * union-merges platforms on update.
 *
 * ### What it does NOT touch (contract §3, explicit)
 *
 *   - `room_game_tags` — tags stay free-form. Every union site flattens
 *     catalogue ids ∪ tags into one array, and the rules layer keeps unknown
 *     tokens verbatim on the engine axis, so an un-folded tag still behaves.
 *   - `tournaments.platform_rules` — P2's read-time shim owns rule shape. A
 *     stored rule is lifted at read, never rewritten here.
 *   - `game_room_game_library.custom_platforms` — dead column (verified).
 *   - the score tables' `platform` column — a different axis entirely.
 *
 * ### Junk
 *
 * A token that yields neither an engine nor an availability feature (a typo, an
 * unmapped VPS `tableFormat`) is DROPPED from `platforms` and logged
 * with its row id, so it is findable rather than merely absent. Note the
 * deliberate asymmetry with the VPS importer, which keeps its unmapped
 * `tableFormat` strings verbatim on the engine axis (its historical behaviour):
 * a VPS-sourced row whose junk this migration drops will have it restored by
 * the next VPS sync. That is accepted — the alternative is either changing VPS
 * import semantics in a data migration or preserving typos forever.
 *
 * Rows that end with ZERO engines are counted and reported separately: such a
 * game contributes no engine to its submit picker and matches no engine-axis
 * tournament rule, which is worth knowing about on a real deploy even though it
 * is not an error (a row can legitimately fold to features only — e.g. one
 * whose sole platform was the bare `vr` seed token).
 *
 * ### Caches
 *
 * `leaderboard_cache` and `global_leaderboard_cache` hold serialized card rows
 * that embed platform chips, and neither self-invalidates on a catalogue edit.
 * Both are cleared (precedent 086/088/127/128). `ranking_groups_cache` is left
 * alone — it self-invalidates via its score watermark (ADR 0013), and no score
 * changed here.
 *
 * ### Idempotence
 *
 * Guaranteed by the fold, not by the `schema_migrations` guard: every canonical
 * engine id maps to itself (catalogue phase §1), so re-folding an already-folded
 * row yields the same engines, no new features and nothing dropped. Only changed
 * rows are written, so a second run reports zero updates.
 */

function log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[migration] 129: ${line}`);
}

function parseJsonArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
    } catch {
        return [];
    }
}

export interface CatalogueFoldCounts {
    /** Rows examined. */
    scanned: number;
    /** Rows whose `platforms` or `features` actually changed. */
    updated: number;
    /** Pre-fold distribution: legacy platform id → number of rows carrying it. */
    distribution: Record<string, number>;
    /** Legacy id → number of rows in which it was folded. */
    transformed: Record<string, number>;
    /** Availability feature → number of rows it was added to. */
    featuresAdded: Record<string, number>;
    /** Dropped junk token → the row ids it was dropped from. */
    dropped: Record<string, string[]>;
    /** Rows left with an empty engine list after folding. */
    rowsWithNoEngines: number;
}

export async function foldCatalogueToEngines(db: Database): Promise<CatalogueFoldCounts> {
    const counts: CatalogueFoldCounts = {
        scanned: 0,
        updated: 0,
        distribution: {},
        transformed: {},
        featuresAdded: {},
        dropped: {},
        rowsWithNoEngines: 0,
    };

    const rows = await db.all(
        'SELECT id, platforms, features FROM global_games',
    ) as Array<{ id: string; platforms: string | null; features: string | null }>;

    // --- Step 1: the fresh distribution, BEFORE anything is touched --------
    //
    // The only existing snapshot of what actually lives in this column is from
    // April 2026 and predates four importers, so the phase was planned against
    // a list nobody had re-checked. Logging it here means the next person has a
    // real one, taken at the moment it still mattered.
    for (const row of rows) {
        counts.scanned++;
        for (const p of parseJsonArray(row.platforms)) {
            const key = String(p).trim().toLowerCase();
            if (!key) continue;
            counts.distribution[key] = (counts.distribution[key] ?? 0) + 1;
        }
    }
    if (counts.scanned > 0) {
        const dist = Object.entries(counts.distribution)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([id, n]) => `${id}=${n}`)
            .join(', ');
        log(`pre-fold distribution over ${counts.scanned} catalogue row(s): ${dist || '(no platforms)'}`);
    }

    // --- Step 2: fold every row -------------------------------------------
    await db.exec('BEGIN');
    try {
        for (const row of rows) {
            const platforms = parseJsonArray(row.platforms);
            const existingFeatures = parseJsonArray(row.features);
            const fold = foldCataloguePlatforms(platforms);

            // `features` is union-merged, lower-cased and deduped. Existing
            // values keep their position — the AtGames cabinet variants that
            // migration 101 put there are read by the FE and must not shuffle.
            const features: string[] = [];
            const seenFeature = new Set<string>();
            for (const f of [...existingFeatures, ...fold.features]) {
                const key = String(f).trim().toLowerCase();
                if (!key || seenFeature.has(key)) continue;
                seenFeature.add(key);
                features.push(key);
            }

            const nextPlatforms = JSON.stringify(fold.engines);
            const nextFeatures = JSON.stringify(features);
            const changed = nextPlatforms !== JSON.stringify(platforms)
                || nextFeatures !== JSON.stringify(existingFeatures);

            if (fold.engines.length === 0 && platforms.length > 0) counts.rowsWithNoEngines++;

            for (const token of fold.dropped) {
                (counts.dropped[token] ??= []).push(row.id);
            }

            if (!changed) continue;

            // Per-id transform counts. Only tallied for rows that actually
            // changed, so a re-run reports zeroes rather than re-counting the
            // whole catalogue as "transformed".
            for (const p of platforms) {
                const key = String(p).trim().toLowerCase();
                if (!key) continue;
                counts.transformed[key] = (counts.transformed[key] ?? 0) + 1;
            }
            for (const f of fold.features) {
                if (existingFeatures.some(e => String(e).trim().toLowerCase() === f)) continue;
                counts.featuresAdded[f] = (counts.featuresAdded[f] ?? 0) + 1;
            }

            await db.run(
                'UPDATE global_games SET platforms = ?, features = ? WHERE id = ?',
                nextPlatforms, nextFeatures, row.id,
            );
            counts.updated++;
        }

        // --- Step 3: cache bust -------------------------------------------
        if (counts.updated > 0) {
            await db.exec('DELETE FROM leaderboard_cache');
            await db.exec('DELETE FROM global_leaderboard_cache');
        }

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    // --- Step 4: report ---------------------------------------------------
    //
    // A no-op run (every test DB init, and every re-deploy after the first)
    // stays quiet apart from the distribution line, so it does not drown the
    // startup log.
    if (counts.updated > 0) {
        const transformed = Object.entries(counts.transformed)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([id, n]) => `${id}=${n}`)
            .join(', ');
        const added = Object.entries(counts.featuresAdded)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([id, n]) => `${id}=${n}`)
            .join(', ');
        log(
            `folded ${counts.updated} of ${counts.scanned} row(s); `
            + `platform ids transformed: ${transformed || '(none)'}; `
            + `features added: ${added || '(none)'}; `
            + 'leaderboard caches cleared',
        );
    }
    for (const [token, ids] of Object.entries(counts.dropped)) {
        log(`dropped unrecognised platform id "${token}" from ${ids.length} row(s): ${ids.join(', ')}`);
    }
    if (counts.rowsWithNoEngines > 0) {
        log(
            `${counts.rowsWithNoEngines} row(s) have no engine after folding — those games `
            + 'contribute no engine to their submit picker and match no engine-axis rule',
        );
    }

    return counts;
}
