import { GameLibraryService } from './GameLibraryService.js';
import { logInfo, logError } from '../utils/logger.js';

interface VpsTable {
    id: string;
    name: string;
    manufacturer?: string;
    year?: number;
    type?: string;
    theme?: string[];
    designers?: string[];
    tableFiles?: VpsTableFile[];
}

interface VpsTableFile {
    id: string;
    tableFormat?: string;
    features?: string[];
    urls?: { url: string }[];
}

/**
 * Extracts unique table format platforms from a VPS game entry.
 * Only uses tableFormat values (VPX, FP, FX3, etc.) — not features.
 */
function extractPlatforms(table: VpsTable): string[] {
    const platforms = new Set<string>();
    if (!table.tableFiles) return [];
    for (const tf of table.tableFiles) {
        if (tf.tableFormat) {
            platforms.add(tf.tableFormat);
        }
    }
    return [...platforms].sort();
}

/**
 * Builds a display name including manufacturer and year when available.
 * e.g. "Pistol Poker (Alvin G., 1993)"
 */
function buildGameName(table: VpsTable): string {
    const parts: string[] = [];
    if (table.manufacturer) parts.push(table.manufacturer);
    if (table.year) parts.push(String(table.year));
    if (parts.length > 0) {
        return `${table.name} (${parts.join(', ')})`;
    }
    return table.name;
}

export class VpsImportService {
    /**
     * Fetches the VPS database JSON and imports games that have table files.
     * Only imports entries with at least one tableFile (playable games).
     * Game names include manufacturer and year for identification.
     */
    static async importFromVps(): Promise<{ imported: number; total: number }> {
        logInfo('VPS Import: fetching database...');
        const resp = await fetch('https://virtualpinballspreadsheet.github.io/vps-db/db/vpsdb.json');
        if (!resp.ok) throw new Error(`VPS API returned ${resp.status}`);
        const tables: VpsTable[] = await resp.json();
        logInfo(`VPS Import: received ${tables.length} entries`);

        // Only import entries that have playable table files
        const playable = tables.filter(t => t.name && t.tableFiles && t.tableFiles.length > 0);
        logInfo(`VPS Import: ${playable.length} games with table files`);

        const games = playable.map(t => ({
            name: buildGameName(t),
            aliases: t.name !== buildGameName(t) ? t.name : '',
            style_id: '',
            mode: 'pinball' as const,
            css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '',
            platforms: JSON.stringify(extractPlatforms(t)),
        }));

        const imported = await GameLibraryService.importGames(games);
        logInfo(`VPS Import: imported ${imported} games`);
        return { imported, total: tables.length };
    }
}
