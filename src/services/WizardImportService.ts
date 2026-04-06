import { GameLibraryService } from './GameLibraryService.js';
import { logInfo, logError } from '../utils/logger.js';

const README_URL = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main/README.md';

const GITHUB_BASE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k';

interface WizardTable {
    name: string;
    path: string | null;
}

/**
 * Parses the "Wizard Tables" section from the GitHub README and extracts table names and paths.
 * Each row's Table column contains a markdown link like: [Table Name (Manufacturer Year)](path)
 */
function parseWizardTables(markdown: string): WizardTable[] {
    const lines = markdown.split('\n');
    let inWizardSection = false;
    const tables: WizardTable[] = [];

    for (const line of lines) {
        // Detect the Wizard Tables heading
        if (/^##\s+Wizard Tables\s*$/i.test(line)) {
            inWizardSection = true;
            continue;
        }

        // Stop at the next heading
        if (inWizardSection && /^##\s/.test(line)) {
            break;
        }

        if (!inWizardSection) continue;

        // Skip header row, separator, and empty lines
        if (!line.startsWith('|') || line.includes('---')) continue;
        if (/\|\s*Table\s*\|/i.test(line)) continue;

        // Extract the link text and path from the first column: | [Name](url) | ...
        const match = line.match(/\|\s*\[([^\]]+)\]\(([^)]*)\)/);
        if (match?.[1]) {
            tables.push({
                name: match[1].trim(),
                path: match[2]?.trim() || null,
            });
        }
    }

    return tables;
}

export class WizardImportService {
    /**
     * Fetches the VPXS Wizard Tables list from GitHub and imports them
     * into the game library with platform "VPXS".
     */
    static async importFromWizard(): Promise<{ imported: number; total: number; names: string[]; autoMerged: Array<{ imported: string; existing: string }> }> {
        logInfo('Wizard Import: fetching README from GitHub...');
        const resp = await fetch(README_URL);
        if (!resp.ok) throw new Error(`GitHub returned ${resp.status}`);
        const markdown = await resp.text();

        const tables = parseWizardTables(markdown);
        logInfo(`Wizard Import: found ${tables.length} Wizard Tables`);

        if (tables.length === 0) {
            throw new Error('No Wizard Tables found in README — format may have changed');
        }

        const games = tables.map(t => ({
            name: t.name,
            aliases: '',
            style_id: '',
            mode: 'pinball' as const,
            css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '',
            platforms: JSON.stringify(['VPXS']),
            external_url: t.path ? `${GITHUB_BASE}/tree/main/${t.path.replace(/^\.\//, '')}` : null,
        }));

        const result = await GameLibraryService.importGames(games);
        const names = tables.map(t => t.name);
        logInfo(`Wizard Import: imported ${result.imported} games, auto-merged ${result.autoMerged.length}`);
        return { imported: result.imported, total: tables.length, names, autoMerged: result.autoMerged };
    }
}
