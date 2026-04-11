import { GameLibraryService } from './GameLibraryService.js';
import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError } from '../utils/logger.js';

const README_URL = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main/README.md';

const GITHUB_BASE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k';

interface WizardTable {
    name: string;
    path: string | null;
    section: 'wizard_auto' | 'wizard_manual';
    hasBackglass: boolean;
    hasDmd: boolean;
    requiresRom: boolean;
    hasPuppack: boolean;
    fps: string | null;
}

/**
 * Checks if a table column cell contains a checkmark (✔, ✅, ☑, Yes, X).
 */
function isChecked(cell: string): boolean {
    const trimmed = cell.trim();
    return /[✔✅☑✓✗✘xX]|Yes/i.test(trimmed) && trimmed !== '';
}

/**
 * Parses both "Wizard Tables" and "Manual Install Tables" sections from the README.
 * Each row's Table column contains a markdown link: [Table Name (Manufacturer Year)](path)
 * Additional columns: Backglass, DMD, ROM Required, Has Puppack, FPS
 */
function parseAllSections(markdown: string): WizardTable[] {
    const lines = markdown.split('\n');
    let currentSection: 'wizard_auto' | 'wizard_manual' | null = null;
    const tables: WizardTable[] = [];

    for (const line of lines) {
        // Detect section headings
        if (/^##\s+Wizard Tables\s*$/i.test(line)) {
            currentSection = 'wizard_auto';
            continue;
        }
        if (/^##\s+Manual Install Tables\s*$/i.test(line)) {
            currentSection = 'wizard_manual';
            continue;
        }

        // Stop at a non-target heading
        if (currentSection && /^##\s/.test(line) &&
            !/Wizard Tables/i.test(line) && !/Manual Install Tables/i.test(line)) {
            currentSection = null;
            continue;
        }

        if (!currentSection) continue;

        // Skip header row, separator, and empty lines
        if (!line.startsWith('|') || line.includes('---')) continue;
        if (/\|\s*Table\s*\|/i.test(line)) continue;

        // Split row into columns
        const cols = line.split('|').map(c => c.trim()).filter(Boolean);
        if (cols.length === 0) continue;

        // First column: [Name](url)
        const firstCol = cols[0] || '';
        const match = firstCol.match(/\[([^\]]+)\]\(([^)]*)\)/);
        if (!match?.[1]) continue;

        tables.push({
            name: match[1].trim(),
            path: match[2]?.trim() || null,
            section: currentSection!,
            hasBackglass: cols.length > 1 && isChecked(cols[1] || ''),
            hasDmd: cols.length > 2 && isChecked(cols[2] || ''),
            requiresRom: cols.length > 3 && isChecked(cols[3] || ''),
            hasPuppack: cols.length > 4 && isChecked(cols[4] || ''),
            fps: cols.length > 5 && (cols[5] || '').trim() ? (cols[5] || '').trim() : null,
        });
    }

    return tables;
}

/**
 * Builds feature tags from table metadata.
 */
function buildFeatures(table: WizardTable): string[] {
    const features: string[] = [table.section];
    if (table.hasBackglass) features.push('has_backglass');
    if (table.hasDmd) features.push('has_dmd');
    if (table.requiresRom) features.push('requires_rom');
    if (table.hasPuppack) features.push('has_puppack');
    if (table.fps) {
        const fpsNum = parseInt(table.fps, 10);
        if (!isNaN(fpsNum)) features.push(`fps_${fpsNum}`);
    }
    return features;
}

/**
 * Parses manufacturer and year from a name like "Table Name (Manufacturer Year)".
 */
function parseNameParts(name: string): { baseName: string; manufacturer?: string; year?: number } {
    const match = name.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!match?.[1] || !match[2]) return { baseName: name };

    const baseName = match[1].trim();
    const parens = match[2];

    // Try to extract year (4 digits)
    const yearMatch = parens.match(/(\d{4})/);
    const year = yearMatch?.[1] ? parseInt(yearMatch[1], 10) : undefined;

    // Everything else is manufacturer
    const manufacturer = parens.replace(/\d{4}/, '').replace(/,\s*$/, '').replace(/^\s*,/, '').trim() || undefined;

    return { baseName, manufacturer, year };
}

export class WizardImportService {
    /**
     * Fetches the VPXS Wizard Tables list from GitHub and imports them.
     * Parses BOTH "Wizard Tables" (~425) and "Manual Install Tables" (~700+) sections.
     */
    static async importFromWizard(): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        total: number;
        wizardCount: number;
        manualCount: number;
        names: string[];
        autoMerged: Array<{ imported: string; existing: string }>;
    }> {
        const syncLogId = await SyncLogService.start('wizard');
        const errors: string[] = [];

        try {
            logInfo('Wizard Import: fetching README from GitHub...');
            const resp = await fetch(README_URL);
            if (!resp.ok) throw new Error(`GitHub returned ${resp.status}`);
            const markdown = await resp.text();

            const tables = parseAllSections(markdown);
            const wizardCount = tables.filter(t => t.section === 'wizard_auto').length;
            const manualCount = tables.filter(t => t.section === 'wizard_manual').length;
            logInfo(`Wizard Import: found ${wizardCount} Wizard Tables + ${manualCount} Manual Install Tables = ${tables.length} total`);

            if (tables.length === 0) {
                throw new Error('No tables found in README — format may have changed');
            }

            // Legacy import for game_library (backward compat)
            const legacyGames = tables.map(t => ({
                name: t.name,
                aliases: '',
                style_id: '',
                mode: 'pinball' as const,
                css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '',
                platforms: JSON.stringify(['vpxs']),
                external_url: t.path ? `${GITHUB_BASE}/tree/main/${t.path.replace(/^\.\//, '')}` : null,
            }));
            const legacyResult = await GameLibraryService.importGames(legacyGames);

            // Global catalogue import with rich metadata
            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            for (const table of tables) {
                try {
                    const { baseName, manufacturer, year } = parseNameParts(table.name);
                    const input: GlobalGameInput = {
                        name: baseName,
                        manufacturer,
                        year,
                        type: 'pinball',
                        platforms: ['vpxs'],
                        features: buildFeatures(table),
                        external_url: table.path
                            ? `${GITHUB_BASE}/tree/main/${table.path.replace(/^\.\//, '')}`
                            : undefined,
                        imported_from: 'wizard',
                    };

                    const result = await GlobalGameService.upsert(input);
                    if (result.action === 'inserted') inserted++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                } catch (err) {
                    const msg = `Failed to import Wizard table "${table.name}": ${err}`;
                    logError(msg);
                    errors.push(msg);
                    skipped++;
                }
            }

            const names = tables.map(t => t.name);
            logInfo(`Wizard Import: global catalogue — inserted ${inserted}, updated ${updated}, skipped ${skipped}`);

            await SyncLogService.complete(syncLogId, {
                status: errors.length > 0 ? 'partial' : 'success',
                records_imported: inserted,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length > 0 ? errors : undefined,
            });

            return {
                imported: inserted,
                updated,
                skipped,
                total: tables.length,
                wizardCount,
                manualCount,
                names,
                autoMerged: legacyResult.autoMerged,
            };
        } catch (err) {
            logError('Wizard Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }
}
