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
 * Maps VPS tableFiles to ArcAid platform names.
 * tableFormat values: 'VPX', 'FP', 'PM5', etc.
 * features may include: 'VR', 'FSS', etc.
 */
function extractPlatforms(table: VpsTable): string[] {
    const platforms = new Set<string>();
    if (!table.tableFiles) return [];
    for (const tf of table.tableFiles) {
        const fmt = tf.tableFormat;
        if (!fmt) continue;
        if (fmt === 'VPX') {
            platforms.add('VPX');
            if (tf.features?.includes('VR')) platforms.add('VR');
        } else if (fmt === 'FP') {
            platforms.add('FP');
        } else if (fmt === 'PM5') {
            platforms.add('PM5');
        } else {
            platforms.add(fmt);
        }
    }
    return [...platforms].sort();
}

export class VpsImportService {
    /**
     * Fetches the VPS database JSON and imports all pinball tables into game_library.
     * Uses INSERT OR REPLACE — existing games matched by name will be updated.
     * Returns count of imported games.
     */
    static async importFromVps(): Promise<{ imported: number; total: number }> {
        logInfo('VPS Import: fetching database...');
        const resp = await fetch('https://virtualpinballspreadsheet.github.io/vps-db/db/vpsdb.json');
        if (!resp.ok) throw new Error(`VPS API returned ${resp.status}`);
        const tables: VpsTable[] = await resp.json();
        logInfo(`VPS Import: received ${tables.length} tables`);

        const games = tables
            .filter(t => t.name)
            .map(t => ({
                name: t.name,
                aliases: '',
                style_id: '',
                mode: 'pinball',
                css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '',
                platforms: JSON.stringify(extractPlatforms(t)),
            }));

        const imported = await GameLibraryService.importGames(games);
        logInfo(`VPS Import: imported ${imported} games`);
        return { imported, total: tables.length };
    }
}
