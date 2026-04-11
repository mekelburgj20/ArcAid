/**
 * Catalogue analysis script. Read-only — never writes to the DB.
 *
 * Projects the current global_games table into two artifacts:
 *   1. docs/catalogue-master.csv — one row per external-source claim, so records
 *      with multiple source IDs (opdb_id, vps_id, igdb_id) produce multiple CSV rows.
 *      This lets us analyze by source without un-merging the DB first.
 *   2. docs/catalogue-analysis.md — human review doc summarizing source
 *      inventory, dedup damage (Frankenstein records), legitimate merges,
 *      platform vocabulary per source, and name collision analysis.
 *
 * Run from the repo root:
 *   tsx scripts/analyze-catalogue.ts
 *
 * The DB is volume-mounted from the container, so this reads the live state
 * without touching the running instance.
 */

import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs/promises';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'arcaid.db');
const OUT_DIR = path.join(process.cwd(), 'docs');
const OUT_CSV = path.join(OUT_DIR, 'catalogue-master.csv');
const OUT_MD = path.join(OUT_DIR, 'catalogue-analysis.md');

interface GlobalGameRow {
    id: string;
    name: string;
    display_name: string | null;
    manufacturer: string | null;
    year: number | null;
    type: string;
    subtype: string | null;
    platforms: string;      // JSON
    themes: string;         // JSON
    designers: string;      // JSON
    features: string;       // JSON
    opdb_id: string | null;
    vps_id: string | null;
    igdb_id: number | null;
    ipdb_url: string | null;
    external_url: string | null;
    imported_from: string | null;
    created_at: string;
}

interface SyncLogRow {
    source: string;
    status: string;
    records_imported: number;
    records_updated: number;
    records_skipped: number;
    started_at: string;
    completed_at: string | null;
    errors: string | null;
}

// --- Helpers ---

function parseJsonArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const v = JSON.parse(raw);
        return Array.isArray(v) ? v : [];
    } catch { return []; }
}

function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = String(value);
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

/** Normalized name algorithm mirroring src/utils/catalogueUtils.ts */
function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/\(.*?\)/g, ' ')      // drop parenthetical content
        .replace(/\b(the|le|la)\b/g, ' ')
        .replace(/\b(remake|limited edition|le|pro|premium)\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')   // punctuation → space
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A record is considered a "Frankenstein" if it shows evidence of the dedup
 * bug that cross-merged unrelated sources:
 *   - Pinball record with an igdb_id — IGDB has no pinball machines
 *     (the 3 IGDB-pure pinball records are legitimately pinball video games,
 *      but a pinball row with opdb_id AND igdb_id almost certainly collided)
 *   - Pinball record whose subtype is a video-game subtype (pc/console/arcade)
 *   - Pinball record whose platforms span the physical/video category
 *     boundary (has `real` AND any of [wii, pc, gbc, nes, ...])
 */
function isFrankenstein(row: GlobalGameRow): { is: boolean; reasons: string[] } {
    const reasons: string[] = [];
    const platforms = parseJsonArray(row.platforms);

    if (row.type === 'pinball' && row.igdb_id && (row.opdb_id || row.vps_id)) {
        reasons.push('pinball+igdb cross-type');
    }
    if (row.type === 'pinball' && row.subtype && ['pc', 'console', 'arcade'].includes(row.subtype.toLowerCase())) {
        reasons.push(`pinball with video-game subtype "${row.subtype}"`);
    }

    // Video-game platforms polluting a pinball record
    const videoPlatforms = ['pc', 'wii', 'gbc', 'gb', 'gba', 'nes', 'snes', 'genesis', 'n64', 'ps1', 'ps2', 'switch', 'dreamcast', 'saturn', 'sms', 'sega_cd', 'game_gear', 'tg16', 'atari_2600', 'atari_7800', 'jaguar', '3do', 'arcade'];
    const hasPinballPlatform = platforms.some(p => ['real', 'vpx', 'vpxs', 'vp9', 'fp', 'bam', 'pinball_fx', 'pinball_fx3', 'vr', 'atgames', 'atgames_hd', 'atgames_4k'].includes(p));
    const hasVideoPlatform = platforms.some(p => videoPlatforms.includes(p));
    if (hasPinballPlatform && hasVideoPlatform) {
        reasons.push('mixed physical + video platforms');
    }

    return { is: reasons.length > 0, reasons };
}

function countSources(row: GlobalGameRow): number {
    return (row.opdb_id ? 1 : 0) + (row.vps_id ? 1 : 0) + (row.igdb_id ? 1 : 0);
}

// --- Analysis queries ---

async function getSyncLogs(db: Database): Promise<Record<string, SyncLogRow>> {
    // Most recent log per source
    const rows = await db.all<SyncLogRow[]>(`
        SELECT source, status, records_imported, records_updated, records_skipped,
               started_at, completed_at, errors
        FROM sync_logs sl
        WHERE started_at = (
            SELECT MAX(started_at) FROM sync_logs WHERE source = sl.source
        )
        ORDER BY source
    `);
    const map: Record<string, SyncLogRow> = {};
    for (const r of rows) map[r.source] = r;
    return map;
}

async function getSourceComboCounts(db: Database): Promise<Array<{ combo: string; type: string; count: number }>> {
    return db.all(`
        SELECT
            CASE
                WHEN opdb_id IS NOT NULL AND vps_id IS NOT NULL AND igdb_id IS NOT NULL THEN 'opdb+vps+igdb'
                WHEN opdb_id IS NOT NULL AND vps_id IS NOT NULL THEN 'opdb+vps'
                WHEN opdb_id IS NOT NULL AND igdb_id IS NOT NULL THEN 'opdb+igdb'
                WHEN vps_id IS NOT NULL AND igdb_id IS NOT NULL THEN 'vps+igdb'
                WHEN opdb_id IS NOT NULL THEN 'opdb'
                WHEN vps_id IS NOT NULL THEN 'vps'
                WHEN igdb_id IS NOT NULL THEN 'igdb'
                ELSE 'none'
            END as combo,
            type,
            COUNT(*) as count
        FROM global_games
        GROUP BY combo, type
        ORDER BY count DESC
    `);
}

async function getTypeSubtypeCounts(db: Database): Promise<Array<{ type: string; subtype: string | null; count: number }>> {
    return db.all(`
        SELECT type, subtype, COUNT(*) as count
        FROM global_games
        GROUP BY type, subtype
        ORDER BY type, count DESC
    `);
}

/**
 * For each source, collect the platform vocabulary — distinct platform tokens
 * that appear in records where that source's ID is set. Shows the "reach" of
 * each source after our canonical normalization.
 */
async function getPlatformVocabularyBySource(db: Database): Promise<Record<string, Record<string, number>>> {
    const sources: Array<{ name: string; predicate: string }> = [
        { name: 'opdb', predicate: 'opdb_id IS NOT NULL' },
        { name: 'vps', predicate: 'vps_id IS NOT NULL' },
        { name: 'igdb', predicate: 'igdb_id IS NOT NULL' },
        { name: 'none', predicate: 'opdb_id IS NULL AND vps_id IS NULL AND igdb_id IS NULL' },
    ];

    const result: Record<string, Record<string, number>> = {};
    for (const src of sources) {
        const rows = await db.all<Array<{ platforms: string }>>(`SELECT platforms FROM global_games WHERE ${src.predicate}`);
        const counts: Record<string, number> = {};
        for (const r of rows) {
            for (const p of parseJsonArray(r.platforms)) {
                counts[p] = (counts[p] || 0) + 1;
            }
        }
        result[src.name] = counts;
    }
    return result;
}

async function getFrankensteinSample(db: Database, limit: number): Promise<GlobalGameRow[]> {
    // Grab pinball records with igdb_id (the clearest signal of cross-type merge)
    const rows = await db.all<GlobalGameRow[]>(`
        SELECT * FROM global_games
        WHERE type = 'pinball' AND igdb_id IS NOT NULL
        ORDER BY (CASE WHEN opdb_id IS NOT NULL THEN 1 ELSE 0 END)
               + (CASE WHEN vps_id IS NOT NULL THEN 1 ELSE 0 END) DESC,
                 name COLLATE NOCASE
        LIMIT ?
    `, limit);
    return rows;
}

async function getLegitimateMergeSample(db: Database, limit: number): Promise<GlobalGameRow[]> {
    return db.all<GlobalGameRow[]>(`
        SELECT * FROM global_games
        WHERE type = 'pinball'
          AND opdb_id IS NOT NULL
          AND vps_id IS NOT NULL
          AND igdb_id IS NULL
        ORDER BY name COLLATE NOCASE
        LIMIT ?
    `, limit);
}

/**
 * For each frankenstein record, find other records whose normalized name is
 * similar so we can see what DID NOT get merged and assess how many legitimate
 * distinct games are being collapsed.
 */
async function findSiblings(db: Database, name: string, excludeId: string): Promise<GlobalGameRow[]> {
    const firstToken = normalizeName(name).split(' ').slice(0, 2).join(' ');
    if (!firstToken) return [];
    const rows = await db.all<GlobalGameRow[]>(`
        SELECT * FROM global_games
        WHERE LOWER(name) LIKE ? AND id != ?
        LIMIT 10
    `, `%${firstToken}%`, excludeId);
    const target = normalizeName(name);
    // Pre-filter to rows whose normalized name SHARES the first 2 tokens
    return rows.filter(r => {
        const candidate = normalizeName(r.name);
        const candidateFirst = candidate.split(' ').slice(0, 2).join(' ');
        return candidateFirst === firstToken || candidate === target;
    });
}

/**
 * Find the top N normalized-name collisions: distinct global_game rows whose
 * normalized name matches. These are rows the current dedup LEFT separate
 * (because the name match hit multiple candidates and required admin review).
 */
async function getNameCollisions(db: Database, limit: number): Promise<Array<{ normalized: string; count: number; samples: GlobalGameRow[] }>> {
    const rows = await db.all<GlobalGameRow[]>(`SELECT * FROM global_games`);
    const buckets = new Map<string, GlobalGameRow[]>();
    for (const r of rows) {
        const n = normalizeName(r.name);
        if (!n) continue;
        if (!buckets.has(n)) buckets.set(n, []);
        buckets.get(n)!.push(r);
    }
    const collisions: Array<{ normalized: string; count: number; samples: GlobalGameRow[] }> = [];
    for (const [normalized, bucket] of buckets) {
        if (bucket.length > 1) {
            collisions.push({ normalized, count: bucket.length, samples: bucket.slice(0, 5) });
        }
    }
    collisions.sort((a, b) => b.count - a.count);
    return collisions.slice(0, limit);
}

async function getTotalRowCount(db: Database): Promise<number> {
    const row = await db.get<{ c: number }>('SELECT COUNT(*) as c FROM global_games');
    return row?.c ?? 0;
}

// --- CSV emission ---

/**
 * Emit one row per external-source claim. A global_games row with all three
 * IDs (opdb+vps+igdb) becomes three rows, letting you group by source.
 * Wizard and manual records emit a single row with source=wizard/manual.
 */
async function writeCsv(db: Database): Promise<{ rowCount: number; gameCount: number }> {
    const allRows = await db.all<GlobalGameRow[]>(`
        SELECT * FROM global_games ORDER BY name COLLATE NOCASE
    `);

    const columns = [
        'global_game_id',
        'source',
        'source_id',
        'source_count',
        'is_frankenstein',
        'frankenstein_reasons',
        'name',
        'type',
        'subtype',
        'year',
        'manufacturer',
        'platforms',
        'features',
        'themes',
        'ipdb_url',
        'external_url',
        'imported_from',
        'opdb_id',
        'vps_id',
        'igdb_id',
        'created_at',
    ];

    const lines: string[] = [columns.join(',')];
    let rowCount = 0;

    for (const r of allRows) {
        const platforms = parseJsonArray(r.platforms).join(';');
        const features = parseJsonArray(r.features).join(';');
        const themes = parseJsonArray(r.themes).join(';');
        const frank = isFrankenstein(r);
        const sourceCount = countSources(r);

        const baseCols = [
            r.id,
            '',            // placeholder for source
            '',            // placeholder for source_id
            sourceCount,
            frank.is ? 'true' : 'false',
            frank.reasons.join('; '),
            r.display_name || r.name,
            r.type,
            r.subtype || '',
            r.year || '',
            r.manufacturer || '',
            platforms,
            features,
            themes,
            r.ipdb_url || '',
            r.external_url || '',
            r.imported_from || '',
            r.opdb_id || '',
            r.vps_id || '',
            r.igdb_id || '',
            r.created_at,
        ];

        const emissions: Array<{ source: string; sourceId: string }> = [];
        if (r.opdb_id) emissions.push({ source: 'opdb', sourceId: r.opdb_id });
        if (r.vps_id) emissions.push({ source: 'vps', sourceId: r.vps_id });
        if (r.igdb_id) emissions.push({ source: 'igdb', sourceId: String(r.igdb_id) });
        if (emissions.length === 0) {
            // No external ID — emit a single row using imported_from, or 'manual' if unknown
            emissions.push({ source: r.imported_from || 'manual', sourceId: '' });
        }

        for (const e of emissions) {
            baseCols[1] = e.source;
            baseCols[2] = e.sourceId;
            lines.push(baseCols.map(csvEscape).join(','));
            rowCount++;
        }
    }

    await fs.writeFile(OUT_CSV, lines.join('\n') + '\n', 'utf-8');
    return { rowCount, gameCount: allRows.length };
}

// --- Markdown emission ---

function formatRowForMd(r: GlobalGameRow): string {
    const platforms = parseJsonArray(r.platforms).join(', ');
    const ids: string[] = [];
    if (r.opdb_id) ids.push(`opdb:${r.opdb_id}`);
    if (r.vps_id) ids.push(`vps:${r.vps_id}`);
    if (r.igdb_id) ids.push(`igdb:${r.igdb_id}`);
    return `- **${r.display_name || r.name}** (${r.type}${r.subtype ? `/${r.subtype}` : ''}) — ${r.manufacturer || '?'} ${r.year || '?'} — platforms: [${platforms}] — ${ids.join(', ')}${r.external_url ? ` — ${r.external_url}` : ''}`;
}

async function writeMarkdown(db: Database, csvStats: { rowCount: number; gameCount: number }): Promise<void> {
    const [
        total,
        syncLogs,
        sourceCombos,
        typeSubtypes,
        platformVocab,
        frankensteinSample,
        legitSample,
        nameCollisions,
    ] = await Promise.all([
        getTotalRowCount(db),
        getSyncLogs(db),
        getSourceComboCounts(db),
        getTypeSubtypeCounts(db),
        getPlatformVocabularyBySource(db),
        getFrankensteinSample(db, 25),
        getLegitimateMergeSample(db, 15),
        getNameCollisions(db, 30),
    ]);

    // Enrich frankensteins with siblings
    const frankensteinsWithSiblings: Array<{ row: GlobalGameRow; siblings: GlobalGameRow[] }> = [];
    for (const r of frankensteinSample) {
        const siblings = await findSiblings(db, r.name, r.id);
        frankensteinsWithSiblings.push({ row: r, siblings });
    }

    // Count totals
    const frankensteinTotal = await db.get<{ c: number }>(`
        SELECT COUNT(*) as c FROM global_games
        WHERE type = 'pinball' AND igdb_id IS NOT NULL
    `);

    const lines: string[] = [];
    const push = (s: string = '') => lines.push(s);

    push('# Global Catalogue Analysis');
    push('');
    push(`Generated by \`scripts/analyze-catalogue.ts\` on ${new Date().toISOString()}.`);
    push('');
    push('> This report is read-only. It projects the current state of `global_games` to');
    push('> identify dedup damage from the name-match merge logic in `GlobalGameService.upsert()`.');
    push('> The companion CSV at `docs/catalogue-master.csv` has one row per external-source');
    push('> claim (so records with multiple source IDs produce multiple rows).');
    push('');

    // --- Sync Log State ---
    push('## 1. Sync State');
    push('');
    push('Most recent sync run per source:');
    push('');
    push('| Source | Status | Imported | Updated | Skipped | Started |');
    push('|---|---|---:|---:|---:|---|');
    for (const [source, log] of Object.entries(syncLogs)) {
        push(`| ${source} | ${log.status} | ${log.records_imported} | ${log.records_updated} | ${log.records_skipped} | ${log.started_at} |`);
    }
    push('');

    // --- Source Combinations ---
    push('## 2. Source Combinations');
    push('');
    push(`Total \`global_games\` rows: **${total.toLocaleString()}**`);
    push('');
    push('How many records have each combination of external source IDs, split by `type`.');
    push('A row appears in multiple source columns when its corresponding ID is populated.');
    push('');
    push('| Source combo | Type | Count | Notes |');
    push('|---|---|---:|---|');
    for (const r of sourceCombos) {
        let notes = '';
        if (r.combo.includes('igdb') && r.type === 'pinball' && (r.combo.includes('opdb') || r.combo.includes('vps'))) {
            notes = 'LIKELY FRANKENSTEIN — IGDB cross-merged into pinball';
        } else if (r.combo === 'opdb+vps' && r.type === 'pinball') {
            notes = 'Legitimate: real machine + VPX recreation';
        }
        push(`| ${r.combo} | ${r.type} | ${r.count.toLocaleString()} | ${notes} |`);
    }
    push('');

    // --- Type × Subtype ---
    push('## 3. Type × Subtype Distribution');
    push('');
    push('Highlights cross-pollution from dedup bugs. Look for video-game subtypes');
    push('(`pc`, `console`, `arcade`) appearing in `pinball` rows — those only exist');
    push('because IGDB\'s subtype overwrote pinball entries during merge.');
    push('');
    push('| Type | Subtype | Count |');
    push('|---|---|---:|');
    for (const r of typeSubtypes) {
        push(`| ${r.type} | ${r.subtype || '(null)'} | ${r.count.toLocaleString()} |`);
    }
    push('');

    // --- Platform Vocabulary by Source ---
    push('## 4. Platform Vocabulary by Source');
    push('');
    push('Distinct canonical platform tokens appearing in records where each source\'s ID');
    push('is set (or no source IDs at all). Counts are _occurrences_, not unique records,');
    push('so a single VPS record contributing both `vpx` and `real` counts twice.');
    push('');
    push('> These are _post-normalization_ via `src/utils/platformMapping.ts`.');
    push('> Cross-contamination is visible where a source\'s records contain platforms that');
    push('> shouldn\'t originate from that source — e.g. VPS records with `wii` or `pc` are');
    push('> evidence that IGDB video-game records were merged into them.');
    push('');
    for (const [source, counts] of Object.entries(platformVocab)) {
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        push(`### ${source}`);
        push('');
        if (sorted.length === 0) {
            push('_(no platforms)_');
        } else {
            push('| Platform | Count |');
            push('|---|---:|');
            for (const [p, c] of sorted) {
                push(`| ${p} | ${c.toLocaleString()} |`);
            }
        }
        push('');
    }

    // --- Frankenstein Samples ---
    push('## 5. Frankenstein Records (Sample)');
    push('');
    push(`**Total pinball rows with an \`igdb_id\` set: ${frankensteinTotal?.c?.toLocaleString() || '0'}**`);
    push('');
    push('These are pinball records where the IGDB video-game row with a matching');
    push('normalized name was merged in. The `name`, `external_url`, `subtype` and');
    push('platform arrays are polluted with IGDB video-game data.');
    push('');
    push('For each Frankenstein, "siblings" are other records in the DB whose name');
    push('starts with the same tokens but were NOT merged — they show what legitimate');
    push('distinct games exist under similar names.');
    push('');
    let n = 1;
    for (const { row, siblings } of frankensteinsWithSiblings) {
        const frank = isFrankenstein(row);
        push(`### ${n}. ${row.display_name || row.name}`);
        push('');
        push(`- **Reasons:** ${frank.reasons.join('; ')}`);
        push(`- **Current row:** ${formatRowForMd(row)}`);
        if (siblings.length > 0) {
            push(`- **Siblings (${siblings.length}) not merged:**`);
            for (const s of siblings) {
                push(`  - ${formatRowForMd(s)}`);
            }
        } else {
            push(`- _(no similar-named siblings found — this game\'s sources were all collapsed into one row)_`);
        }
        push('');
        n++;
    }

    // --- Legitimate Merge Samples ---
    push('## 6. Legitimate Merge Samples (OPDB + VPS, no IGDB)');
    push('');
    push('These are pinball records that correctly merged a real machine (OPDB) with its');
    push('VPX recreation (VPS). This is what "good" looks like — shared manufacturer/year,');
    push('both `real` and `vpx`-family platforms, no IGDB pollution.');
    push('');
    for (const r of legitSample) {
        push(formatRowForMd(r));
    }
    push('');

    // --- Name Collisions ---
    push('## 7. Normalized Name Collisions');
    push('');
    push('Distinct rows whose normalized name (lowercase, parenthesized text removed,');
    push('articles stripped) is identical. The top collisions reveal where multiple');
    push('legitimately distinct games share a name — the dedup algorithm must keep');
    push('these separate while correctly merging cross-source records of the _same_ game.');
    push('');
    push('Top 30 colliding normalized names:');
    push('');
    for (const c of nameCollisions) {
        push(`### "${c.normalized}" — ${c.count} rows`);
        push('');
        for (const s of c.samples) {
            push(`- ${formatRowForMd(s)}`);
        }
        if (c.count > c.samples.length) {
            push(`- _...and ${c.count - c.samples.length} more_`);
        }
        push('');
    }

    // --- CSV Summary ---
    push('## 8. CSV Output Summary');
    push('');
    push(`Master CSV written to \`docs/catalogue-master.csv\`:`);
    push(`- Unique \`global_games\` rows: **${csvStats.gameCount.toLocaleString()}**`);
    push(`- Total CSV rows (one per source claim): **${csvStats.rowCount.toLocaleString()}**`);
    push('');
    push('Columns:');
    push('- `global_game_id` — stable ID; group here to see all source claims for one record');
    push('- `source` — opdb | vps | igdb | wizard | manual');
    push('- `source_id` — that source\'s external ID');
    push('- `source_count` — how many sources contributed to this global_games row (1-3)');
    push('- `is_frankenstein` / `frankenstein_reasons` — flagged records from cross-type merge');
    push('- `name`, `type`, `subtype`, `year`, `manufacturer` — current (post-merge) values');
    push('- `platforms`, `features`, `themes` — semicolon-joined arrays');
    push('- `ipdb_url`, `external_url`, `imported_from` — source references');
    push('- `opdb_id`, `vps_id`, `igdb_id` — all three IDs present on the shared row, for cross-reference');
    push('');
    push('**Important limitation:** The CSV shows the _current_ name after merge. If IGDB');
    push('and VPS both had entries named "Alice in Wonderland", the CSV reflects whichever');
    push('won the merge — the original source-specific titles are lost in the DB. To recover');
    push('them, we\'d need to re-fetch from sources (not done in this script).');
    push('');

    // --- Next steps ---
    push('## 9. Recommended Next Steps');
    push('');
    push('1. **Review the "Frankenstein Records" section above** — confirm these are truly');
    push('   distinct games that should not share a row.');
    push('2. **Review the "Name Collisions" section** — see what the dedup algorithm must');
    push('   distinguish. Pay attention to cases where multiple _pinball_ machines share a');
    push('   name (e.g. 1950s EM vs. 1990s SS of the same title).');
    push('3. **Agree on dedup rules.** Proposed:');
    push('   - Never merge across `type` boundaries.');
    push('   - Within pinball, only merge when there\'s an explicit cross-reference');
    push('     (VPS `ipdbUrl` ↔ OPDB IPDB number, or VPS has `opdbId`).');
    push('   - Normalized-name matches alone are never sufficient to merge — flag for review.');
    push('   - Require manufacturer+year agreement as a secondary confirmation.');
    push('4. **Un-merge existing Frankensteins.** For the ~464 cross-type merges, split off');
    push('   the IGDB claim into its own row with `type=video_game`, clear `igdb_id` and');
    push('   video-game subtype/platforms from the pinball row, restore the IGDB title via');
    push('   targeted re-fetch.');
    push('5. **Replace `GlobalGameService.upsert()`** with rules above and re-run imports.');
    push('');

    await fs.writeFile(OUT_MD, lines.join('\n'), 'utf-8');
}

// --- Main ---

async function main() {
    await fs.mkdir(OUT_DIR, { recursive: true });

    console.log(`Opening DB: ${DB_PATH}`);
    const db = await open({
        filename: DB_PATH,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READONLY,
    });

    try {
        console.log('Writing CSV...');
        const csvStats = await writeCsv(db);
        console.log(`  -> ${OUT_CSV} (${csvStats.gameCount} games, ${csvStats.rowCount} source claims)`);

        console.log('Writing Markdown...');
        await writeMarkdown(db, csvStats);
        console.log(`  -> ${OUT_MD}`);

        console.log('Done.');
    } finally {
        await db.close();
    }
}

main().catch(err => {
    console.error('analyze-catalogue failed:', err);
    process.exit(1);
});
