import { initDatabase, getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';

/**
 * One-off repair — collapse the Zaccaria/AtGames duplicate pairs in the
 * catalogue (owner-found 2026-08-16, searching "blackbelt").
 *
 * WHY THEY EXIST. `normalizeGameName` already strips "Remake", so AtGames'
 * `Blackbelt 2018 - Remake` reduces to `blackbelt 2018`. What it does not
 * strip is Zaccaria's Steam-DLC suffix, so `Blackbelt 2018 Table` reduces to
 * `blackbelt 2018 table` and the two never meet. That single gap produced
 * every pair this script fixes.
 *
 * WHY THIS IS A SCRIPT AND NOT A NORMALIZER CHANGE. Stripping a trailing
 * `Table` globally was measured against the whole approved catalogue: it
 * creates no false pairs of its own, BUT eleven of the resulting groups hold
 * three or more rows, because genuinely different machines already share a
 * normalized name (`Circus` has seven rows including a Bally 1973 and a
 * Brunswick 1980; `Clown` an Inder 1988; `Universe` a Gottlieb 1959). The
 * Zaccaria digital rows carry NULL manufacturer and NULL year, so letting the
 * generic dedup adjudicate them inside those crowded buckets invites exactly
 * the mis-filing that hit "The Aliens" in v2.108.1. This script therefore
 * pairs by EXPLICIT pattern and refuses anything ambiguous.
 *
 * THE THREE PATTERNS (owner-confirmed, 2026-08-16):
 *   `X Deluxe Pinball Table` (zaccaria) → `X Deluxe`        (atgames_native)
 *   `X Table`                (zaccaria) → `X`               (atgames_native)
 *   `X <year> Table`         (zaccaria) → `X <year> - Remake` (atgames_native),
 *                                          survivor renamed to `X <year>`
 *
 * NOT TOUCHED — Zaccaria's RETRO pack (`X Retro Table`). Those are original
 * tables built for the virtual platforms, loosely based on the classics but
 * redesigned as EM machines (owner, 2026-08-16). They are their own games. The
 * patterns above cannot reach them: `Blackbelt Retro Table` strips to
 * `Blackbelt Retro`, which pairs with AtGames' `Blackbelt Retro` and never
 * with `Blackbelt`. A guard rejects them anyway, because a future edit to the
 * patterns must not silently start eating them.
 *
 * SAFETY. Dry-run by DEFAULT — pass `--execute` to write. Every pair is
 * printed either way. A pair is only merged when the pattern matches EXACTLY
 * one `atgames_native` row and EXACTLY one `zaccaria` row; every other
 * shape is skipped and listed for manual adjudication.
 *
 * DURABILITY CAVEAT. This repairs the data; it does not stop the next
 * "Sync Steam Pinball" re-creating the Zaccaria rows, because dedup matches on
 * `normalized_name` and no row will be named `… Table` afterwards. The
 * `aliases` column exists and is written but is NOT consulted by the dedup
 * walk. See the ROADMAP entry — the follow-up is to teach dedup to read
 * aliases, and to record the Zaccaria title as one at merge time.
 *
 * Run inside the container:
 *   docker exec arcaid node dist/scripts/merge-zaccaria-atgames-dupes.js
 *   docker exec arcaid node dist/scripts/merge-zaccaria-atgames-dupes.js --execute
 */

interface Row {
    id: string;
    name: string;
    platforms: string | null;
    manufacturer: string | null;
    year: number | null;
}

interface Pair {
    zac: Row;
    atg: Row;
    /** Rename applied to the surviving row, when the pattern needs one. */
    renameTo?: string;
    pattern: 'deluxe' | 'plain' | 'remake';
}

function platformsOf(r: Row): string[] {
    try {
        const parsed = JSON.parse(r.platforms || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Loose key for pairing. Punctuation and case vary between the two sources
 *  ("Star's Phoenix" vs "Star’s Phoenix", "Shooting the Rapids" vs
 *  "Shooting The Rapids"), so compare on alphanumerics only. */
function key(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** True for Zaccaria's Retro pack, which must never be paired away. */
function isRetroTable(name: string): boolean {
    return /\bretro\s+table$/i.test(name.trim());
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute');

    await initDatabase();
    const db = await getDatabase();

    const rows = await db.all<Row[]>(
        `SELECT id, name, platforms, manufacturer, year FROM global_games WHERE status = 'approved'`,
    );

    const zaccaria: Row[] = [];
    const atgames: Row[] = [];
    for (const r of rows) {
        const p = platformsOf(r);
        if (p.includes('zaccaria')) zaccaria.push(r);
        if (p.includes('atgames_native')) atgames.push(r);
    }

    const atgByKey = new Map<string, Row[]>();
    for (const a of atgames) {
        const k = key(a.name);
        const list = atgByKey.get(k);
        if (list) list.push(a);
        else atgByKey.set(k, [a]);
    }

    const pairs: Pair[] = [];
    const skipped: string[] = [];

    for (const z of zaccaria) {
        const name = z.name.trim();

        if (isRetroTable(name)) {
            skipped.push(`RETRO (left alone by design): ${name}`);
            continue;
        }

        let wanted: string | null = null;
        let renameTo: string | undefined;
        let pattern: Pair['pattern'] | null = null;

        const deluxe = name.match(/^(.*\bDeluxe)\s+Pinball\s+Table$/i);
        const remake = name.match(/^(.*\s\d{4})\s+Table$/i);
        const plain = name.match(/^(.*?)\s+Table$/i);

        if (deluxe) {
            wanted = deluxe[1] ?? null;
            pattern = 'deluxe';
        } else if (remake) {
            // AtGames spells the remakes "<Name> <year> - Remake"; the survivor
            // is renamed to the bare "<Name> <year>" (owner call). The rename
            // is derived from the ATGAMES name below, not from this Zaccaria
            // prefix — the two sources disagree on casing ("Shooting The
            // Rapids" vs "Shooting the Rapids") and the survivor should read
            // like its siblings, which are all AtGames-named.
            wanted = `${remake[1] ?? ''} - Remake`;
            pattern = 'remake';
        } else if (plain) {
            wanted = plain[1] ?? null;
            pattern = 'plain';
        }

        if (!wanted || !pattern) continue;

        const matches = atgByKey.get(key(wanted)) ?? [];
        if (matches.length === 0) {
            skipped.push(`no AtGames twin: ${name}  (looked for "${wanted}")`);
            continue;
        }
        if (matches.length > 1) {
            skipped.push(`AMBIGUOUS — ${matches.length} AtGames rows named "${wanted}": ${name}`);
            continue;
        }
        const twin = matches[0];
        if (!twin) continue;
        if (pattern === 'remake') {
            renameTo = twin.name.replace(/\s*-\s*Remake$/i, '').trim();
        }
        pairs.push({ zac: z, atg: twin, renameTo, pattern });
    }

    // -- Phase 2: whitespace/hyphen spelling splits ------------------------
    //
    // Four AtGames rows never merged with their PHYSICAL counterpart because
    // the two sources punctuate the name differently, and `normalizeGameName`
    // does not collapse internal spaces or hyphens. Blackbelt is the one the
    // owner hit; a sweep of the whole pinball catalogue found exactly four.
    //
    // Direction is deliberate: the AtGames row folds INTO the physical row,
    // which is the one carrying opdb/vps/ipdb ids and a real manufacturer and
    // year. The survivor keeps the physical row's name, which matches IPDB in
    // three cases -- EXCEPT Blackbelt, where IPDB itself spells it without the
    // space (machine 316) and the owner asked for "Blackbelt" (2026-08-16).
    const SPELLING_SPLITS: Array<{ atgames: string; physical: string; renameTo?: string }> = [
        { atgames: 'Blackbelt', physical: 'Black Belt', renameTo: 'Blackbelt' },
        { atgames: 'JunkYard', physical: 'Junk Yard' },
        { atgames: 'TX Sector', physical: 'TX-Sector' },
        { atgames: 'Wipeout', physical: 'Wipe Out' },
    ];

    const splitPlan: Array<{ source: Row; target: Row; renameTo?: string }> = [];
    for (const split of SPELLING_SPLITS) {
        const source = rows.find(r => r.name === split.atgames && platformsOf(r).includes('atgames_native'));
        const target = rows.find(r => r.name === split.physical && !platformsOf(r).includes('atgames_native'));
        if (!source || !target) {
            skipped.push(`spelling split not found (already merged?): "${split.atgames}" / "${split.physical}"`);
            continue;
        }
        splitPlan.push({ source, target, renameTo: split.renameTo });
    }

    console.log(`\n=== Zaccaria/AtGames duplicate merge — ${execute ? 'EXECUTE' : 'DRY RUN'} ===`);
    console.log(`approved rows: ${rows.length} | zaccaria: ${zaccaria.length} | atgames_native: ${atgames.length}`);
    console.log(`\nPAIRS TO MERGE (${pairs.length}) — the zaccaria row folds into the atgames row:`);
    for (const p of pairs) {
        const rename = p.renameTo ? `   →  rename survivor to "${p.renameTo}"` : '';
        console.log(`  [${p.pattern}] "${p.zac.name}"  ->  "${p.atg.name}"${rename}`);
    }

    console.log(`\nSPELLING SPLITS (${splitPlan.length}) -- the atgames row folds into the physical row:`);
    for (const p of splitPlan) {
        const rename = p.renameTo ? `   -> rename survivor to "${p.renameTo}"` : '   (survivor keeps its name)';
        console.log(`  "${p.source.name}"  ->  "${p.target.name}"${rename}`);
    }

    console.log(`\nSKIPPED (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s}`);

    if (!execute) {
        console.log('\nDry run — nothing written. Re-run with --execute to apply.\n');
        return;
    }

    let merged = 0;
    let renamed = 0;
    for (const p of pairs) {
        // `merge(target, source)` unions platforms/features/external IDs onto
        // the target and keeps the TARGET's name — which is why the rename is
        // a separate step rather than something merge could have done.
        await GlobalGameService.merge(p.atg.id, p.zac.id);
        merged++;
        if (p.renameTo) {
            await db.run(
                `UPDATE global_games SET name = ?, normalized_name = ? WHERE id = ?`,
                p.renameTo, normalizeGameName(p.renameTo), p.atg.id,
            );
            renamed++;
        }
    }

    // Phase 2 runs AFTER the pattern merges on purpose: by then the Zaccaria
    // digital row has already folded into the AtGames row, so this second
    // merge carries every platform onto the physical row in one step.
    for (const p of splitPlan) {
        await GlobalGameService.merge(p.target.id, p.source.id);
        merged++;
        if (p.renameTo) {
            await db.run(
                `UPDATE global_games SET name = ?, normalized_name = ? WHERE id = ?`,
                p.renameTo, normalizeGameName(p.renameTo), p.target.id,
            );
            renamed++;
        }
    }

    console.log(`\nMerged ${merged} rows, renamed ${renamed} survivors.\n`);
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error(err);
        process.exit(1);
    });
