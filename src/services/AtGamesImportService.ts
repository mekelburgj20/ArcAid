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
            // Skip header (row 0) + any row whose column A is blank.
            const names = rows.slice(1)
                .map(r => normalizeName(r[0] || ''))
                .filter(n => n.length > 0);

            logInfo(`AtGames sync: ${names.length} names extracted from sheet`);

            for (const name of names) {
                try {
                    const result = await GlobalGameService.upsert({
                        name,
                        type: 'pinball',
                        platforms: ['atgames'],
                        status: 'approved',
                        imported_from: 'atgames',
                    });
                    if (result.action === 'inserted') created++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                } catch (err) {
                    errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
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
            return { created, updated, skipped, total: names.length };
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
