import axios from 'axios';
import { GlobalGameService } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * AtGames Legends Pinball catalogue tagger.
 *
 * AtGames doesn't expose a public API of which licensed virtual tables ship
 * on the cabinet — the authoritative list is a community / user-curated
 * Google Sheet. We pull column A of that sheet (publicly readable as CSV
 * via Google's export endpoint, no API key required) and run each name
 * through `GlobalGameService.upsert` with `platforms=['atgames']`. The
 * 4-step dedup hierarchy in upsert merges the tag into existing catalogue
 * rows (Williams/Bally pinballs already imported from VPS) and creates
 * fresh rows for names that aren't in the catalogue yet — same pattern as
 * `FxVrImportService`.
 *
 * If the sheet URL changes, edit `SHEET_ID` / `GID` here and redeploy.
 */

// Source-of-truth: user-curated AtGames availability sheet.
// https://docs.google.com/spreadsheets/d/.../edit?gid=...
const SHEET_ID = '1NZ5kK7xuzdXISAfl7lfoQ3SSeE-AWR_4xvGAy-OZYkU';
const GID = '1726389143';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`;

/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields with embedded
 * commas/newlines and `""` quote-escapes. Returns an array of rows; each
 * row is an array of string fields. Drops trailing empty trailing row.
 */
function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let field = '';
    let row: string[] = [];
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++;
        } else {
            if (ch === '"') { inQuotes = true; i++; continue; }
            if (ch === ',') { row.push(field); field = ''; i++; continue; }
            if (ch === '\r') { i++; continue; }
            if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
            field += ch; i++;
        }
    }
    if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
    // Drop trailing all-empty row if Google Sheets emits a final \n.
    const last = rows[rows.length - 1];
    if (last && last.every(c => c === '')) rows.pop();
    return rows;
}

/**
 * Normalize unicode quote variants the curated sheet sometimes contains
 * (curly apostrophes / quotes from copy-paste sources). Without this,
 * "A Samurai’s Vengeance" wouldn't match a catalogue row stored as
 * "A Samurai's Vengeance" — upsert dedup would create a duplicate.
 */
function normalizeName(s: string): string {
    return s
        .replace(/[‘’]/g, "'")  // curly single → straight
        .replace(/[“”]/g, '"')  // curly double → straight
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * AtGames cabinet identifier → canonical platform ID. Sheet cells in
 * columns H/I/J/K (one per porter studio) carry these tokens, sometimes
 * with parenthetical suffixes like "(most)" or "(some)" — stripped before
 * lookup. Cells starting with "(" (e.g. "(HDP soon)") indicate "coming
 * soon" — caller filters those out.
 */
const CABINET_ID_BY_TOKEN: Record<string, string> = {
    'HD':    'atgames_hd',
    '4K':    'atgames_4k',
    'MICRO': 'atgames_micro',
    'HDP':   'atgames_hdp',
    'ALU':   'atgames_alu',
    'MINI':  'atgames_mini',
    'GAMER': 'atgames_gamer',
    'CORE':  'atgames_core',
};

/**
 * Extract a single cabinet variant ID from a sheet cell. Returns null when:
 *  - cell is blank
 *  - cell starts with "(" — game's "coming soon" to that cabinet, not yet
 *    shipped (e.g. "(HDP soon)")
 *  - leading token is non-AtGames-cabinet (Steam, Pinball Arcade, etc.)
 */
function extractCabinetVariant(raw: string): string | null {
    const trimmed = (raw || '').trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('(')) return null;
    // Strip trailing parenthetical: "Mini (most)" → "Mini".
    const stripped = trimmed.replace(/\s*\([^)]*\)\s*$/, '').trim();
    return CABINET_ID_BY_TOKEN[stripped.toUpperCase()] ?? null;
}

// Column indices (0-based). Sheet layout per user clarification:
//   A=name · B/C=2025 play · D/E/F=2026 play · G=padding ·
//   H=AtGames porter · I=FarSight · J=Magic Pixel · K=Zen Studios
const COL_NAME = 0;
const COLS_PORTER_STUDIOS = [7, 8, 9, 10] as const; // H, I, J, K

export class AtGamesImportService {
    static async applyTags(): Promise<{ created: number; updated: number; skipped: number; total: number }> {
        const syncLogId = await SyncLogService.start('atgames');
        let created = 0;
        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];

        try {
            logInfo(`AtGames sync: fetching ${CSV_URL}`);
            const res = await axios.get<string>(CSV_URL, {
                responseType: 'text',
                maxRedirects: 5,
                timeout: 30000,
                // axios defaults to JSON parsing — force text so we get the raw CSV.
                transformResponse: [(d) => d],
            });
            const rows = parseCsv(res.data);
            // Skip row 0 (header "All Tables A to Z" / year-cluster labels) and
            // row 1 (sub-header — studio names AtGames/FarSight/Magic Pixel/Zen).
            const games = rows.slice(2)
                .map(r => ({
                    name: normalizeName(r[COL_NAME] || ''),
                    cabinetCells: COLS_PORTER_STUDIOS.map(i => r[i] ?? ''),
                }))
                .filter(g => g.name.length > 0);

            logInfo(`AtGames sync: ${games.length} names extracted from sheet`);

            for (const game of games) {
                try {
                    // v2.13.6: tag with the umbrella `atgames` platform (the
                    // tournament-meaningful axis) and stash cabinet variants
                    // — atgames_hd / atgames_4k / atgames_hdp / etc. — in
                    // `features`. Cabinet availability is a catalogue-level
                    // attribute, sibling to wizard_auto/has_puppack/fps_*;
                    // it isn't a player-eligibility distinction so it doesn't
                    // belong in the platform rule picker.
                    const variants = new Set<string>();
                    for (const cell of game.cabinetCells) {
                        const id = extractCabinetVariant(cell);
                        if (id) variants.add(id);
                    }

                    const result = await GlobalGameService.upsert({
                        name: game.name,
                        type: 'pinball',
                        platforms: ['atgames'],
                        features: [...variants],
                        status: 'approved',
                        imported_from: 'atgames',
                    });
                    if (result.action === 'inserted') created++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                } catch (err) {
                    errors.push(`${game.name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const status = errors.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: created,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length > 0 ? errors : undefined,
            });

            logInfo(`AtGames Import: ${created} created, ${updated} updated, ${skipped} skipped, ${errors.length} errored`);
            return { created, updated, skipped, total: games.length };
        } catch (err) {
            logError('AtGames Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }
}
