import fs from 'fs';
import path from 'path';
import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError } from '../utils/logger.js';

const README_URL = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main/README.md';

const GITHUB_BASE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k';
const RAW_BASE = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/main';
const IMAGES_API = 'https://api.github.com/repos/LegendsUnchained/vpx-standalone-alp4k/contents/images';

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
 * Reconcile the `vpxs` / `vpxs_manual` pair against the current README state.
 *
 * Running this after every Wizard import means section changes (a game moving
 * from `wizard_auto` to `wizard_manual` in the README, or vice versa) update on
 * the next sync without a data-cleanup migration. Reconciling rather than
 * union-merging is the whole point: `GlobalGameService.upsert` only ever ADDS,
 * so a game that left the auto section would keep claiming `vpxs` forever.
 *
 * ADR 0016 catalogue phase §5 — the pair now lives in `features`, not
 * `platforms`. "Installs automatically" versus "install it yourself" is an
 * availability fact about a table; on the score axis both are the `vpx` engine
 * (ADR 0016 §"VPX Standalone is the VPX engine"). So this reconciles the two
 * FEATURE tokens and, additionally, strips any stale `vpxs*` still sitting in
 * `platforms` — rows written before migration 129, or by an older importer
 * build, converge on the next sync instead of needing a second migration.
 *
 * Everything else on both columns (`vpx`, `fp`, `has_puppack`, `fps_*`, the
 * AtGames cabinet variants) is left alone.
 */
const WIZARD_FEATURES = ['vpxs', 'vpxs_manual'];

export async function reconcileWizardPlatformTags(
    flagsById: Map<string, { auto: boolean; manual: boolean }>,
): Promise<void> {
    if (flagsById.size === 0) return;
    const { getDatabase } = await import('../database/database.js');
    const db = await getDatabase();

    const parseArray = (raw: string | null | undefined): string[] => {
        try {
            const parsed = JSON.parse(raw || '[]');
            return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
        } catch {
            return [];
        }
    };

    for (const [id, flags] of flagsById) {
        const row = await db.get(
            `SELECT platforms, features FROM global_games WHERE id = ?`,
            id,
        ) as { platforms: string | null; features: string | null } | undefined;
        if (!row) continue;

        // Platforms: drop any stale wizard id. The engine (`vpx`) is added by
        // the upsert above and is not a wizard tag, so it survives.
        const platforms = parseArray(row.platforms)
            .filter(p => !WIZARD_FEATURES.includes(p.trim().toLowerCase()));

        // Features: reconcile the pair, preserve the rest in place.
        const features = parseArray(row.features)
            .filter(fv => !WIZARD_FEATURES.includes(fv.trim().toLowerCase()));
        if (flags.auto) features.push('vpxs');
        if (flags.manual) features.push('vpxs_manual');

        await db.run(
            `UPDATE global_games SET platforms = ?, features = ? WHERE id = ?`,
            JSON.stringify([...new Set(platforms)]), JSON.stringify([...new Set(features)]), id,
        );
    }
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
 * Fetches the images/ folder listing from GitHub and builds a slug→filename map.
 * Matches both `{slug}.{ext}` and `{slug}-preview.{ext}` patterns found in the repo.
 * Returns an empty map on failure so the importer still runs (image_url stays null).
 */
async function fetchWizardImageMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
        const resp = await fetch(IMAGES_API);
        if (!resp.ok) {
            logError(`Wizard image listing failed: HTTP ${resp.status}`);
            return map;
        }
        const files: Array<{ name: string }> = await resp.json();
        for (const f of files) {
            const m = f.name.match(/^(.+?)(-preview)?\.(webp|png|jpg|jpeg)$/i);
            if (!m?.[1]) continue;
            // Prefer non-preview over preview when both exist.
            const slug = m[1];
            const existing = map.get(slug);
            if (!existing || !m[2]) map.set(slug, f.name);
        }
        logInfo(`Wizard image map: ${map.size} unique slugs from ${files.length} files`);
    } catch (err) {
        logError('Wizard image listing error:', err);
    }
    return map;
}

/**
 * Derives the slug (leaf folder name) from a README table path like `external/vpx-samba`.
 */
function extractWizardSlug(tablePath: string | null): string | null {
    if (!tablePath) return null;
    const clean = tablePath.replace(/^\.\//, '').replace(/\/+$/, '');
    const parts = clean.split('/');
    return parts[parts.length - 1] || null;
}

/**
 * Resolves the image URL for a wizard table, trying two sources in order:
 *   1. /images/{slug}.{ext} or /images/{slug}-preview.{ext} — from the images folder listing
 *   2. /external/{slug}/launcher.png — per-table fallback (existence not verified here)
 * Returns the URL candidate or undefined if nothing can be constructed.
 */
function resolveWizardImageUrl(
    tablePath: string | null,
    imageMap: Map<string, string>
): string | undefined {
    const slug = extractWizardSlug(tablePath);
    if (!slug) return undefined;
    const mapped = imageMap.get(slug);
    if (mapped) return `${RAW_BASE}/images/${mapped}`;
    // Fallback: every vpx-* folder tends to have a launcher.png
    return `${RAW_BASE}/external/${slug}/launcher.png`;
}

/**
 * Downloads a wizard image to local disk. Skips if already present. Returns the
 * relative DB path, or undefined on HTTP failure (including 404 for the launcher
 * fallback on tables that don't ship one).
 */
async function downloadWizardImage(url: string, slug: string): Promise<string | undefined> {
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'wizard');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const ext = path.extname(url.split('?')[0] || '') || '.png';
        const safe = slug.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const filePath = path.join(dir, `${safe}${ext}`);
        const relPath = `data/catalogue-images/wizard/${safe}${ext}`;

        if (fs.existsSync(filePath)) return relPath;

        const resp = await fetch(url);
        if (!resp.ok) return undefined;
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return relPath;
    } catch {
        return undefined;
    }
}

/**
 * Background image download pass for wizard tables. Mirrors the VPS importer's
 * pattern — runs after the metadata import returns so API responses stay fast.
 */
async function downloadWizardImagesInBackground(
    tables: WizardTable[],
    imageMap: Map<string, string>
): Promise<void> {
    const CONCURRENCY = 8;
    let processed = 0;
    let successes = 0;

    const tasks = tables.map(t => async () => {
        try {
            const slug = extractWizardSlug(t.path);
            if (!slug) return;
            const url = resolveWizardImageUrl(t.path, imageMap);
            if (!url) return;
            const localPath = await downloadWizardImage(url, slug);
            if (!localPath) return;
            await GlobalGameService.updateBySourceUrl(
                `${GITHUB_BASE}/tree/main/${(t.path || '').replace(/^\.\//, '')}`,
                { image_url: url, local_image_path: localPath }
            );
            successes++;
        } catch (err) {
            logError(`Wizard image download failed for "${t.name}":`, err);
        } finally {
            processed++;
            if (processed % 100 === 0) {
                logInfo(`Wizard image downloads: ${processed}/${tables.length} processed (${successes} successful)`);
            }
        }
    });

    const running: Set<Promise<void>> = new Set();
    for (const task of tasks) {
        const p = task().then(() => { running.delete(p); });
        running.add(p);
        if (running.size >= CONCURRENCY) {
            await Promise.race(running);
        }
    }
    await Promise.all(running);

    logInfo(`Wizard image downloads: complete — ${processed} processed, ${successes} successful.`);
}

/**
 * Strips a community team-attribution prefix from a manufacturer string when
 * the underlying value is just "Original" or "MOD". The README writes things
 * like "VPW Original" or "VPDB MOD" to credit the team that built the digital
 * recreation, but VPS stores the same machine with manufacturer="Original" /
 * "MOD". The mismatch was preventing dedup from collapsing vpx + vpxs_manual
 * variants of the same game.
 *
 * Restricts to short all-caps initialisms (2-5 chars) followed by Original or
 * MOD so real manufacturer names like "Williams" or "Stern" are untouched.
 */
function stripTeamPrefix(mfg: string | undefined): string | undefined {
    if (!mfg) return mfg;
    const m = mfg.trim().match(/^[A-Z]{2,5}\s+(Original|MOD)$/i);
    return m ? m[1] : mfg;
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
    const rawMfg = parens.replace(/\d{4}/, '').replace(/,\s*$/, '').replace(/^\s*,/, '').trim() || undefined;
    const manufacturer = stripTeamPrefix(rawMfg);

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
    }> {
        const syncLogId = await SyncLogService.start('wizard');
        const errors: string[] = [];

        try {
            logInfo('Wizard Import: fetching README from GitHub...');
            const resp = await fetch(README_URL);
            if (!resp.ok) throw new Error(`GitHub returned ${resp.status}`);
            const markdown = await resp.text();

            // Build the image filename map up-front — one API call, used for every row.
            const imageMap = await fetchWizardImageMap();

            const tables = parseAllSections(markdown);
            const wizardCount = tables.filter(t => t.section === 'wizard_auto').length;
            const manualCount = tables.filter(t => t.section === 'wizard_manual').length;
            logInfo(`Wizard Import: found ${wizardCount} Wizard Tables + ${manualCount} Manual Install Tables = ${tables.length} total`);

            if (tables.length === 0) {
                throw new Error('No tables found in README — format may have changed');
            }

            // v2.4.13: tag by section so tournaments can require the more
            // reliable `vpxs` (Wizard Tables, auto-install) while excluding
            // `vpxs_manual` (Manual Install — hit-or-miss, low fps). Games
            // listed in BOTH README sections get both tags.
            //
            // ADR 0016 catalogue phase §5: the ENGINE is `vpx` for both — a
            // standalone build is a port of a VPX table with identical physics,
            // so the scores are comparable and the install method is not a
            // property of a score. The section becomes an availability feature.
            // (The upsert folds `vpxs` to exactly this anyway; emitting it
            // directly keeps the importer's intent readable, and the
            // reconcile pass below is what handles REMOVAL, which a union
            // merge can never do.)
            const platformsForTable = (_t: WizardTable): string[] => ['vpx'];
            const wizardFeature = (t: WizardTable): string =>
                t.section === 'wizard_auto' ? 'vpxs' : 'vpxs_manual';

            // Aggregate per-game section flags so the reconcile pass below
            // can strip stale wizard tags (e.g. a game that was in auto last
            // week and moved to manual-only in this README needs vpxs → vpxs_manual).
            const sectionsByIdentity = new Map<string, { auto: boolean; manual: boolean }>();
            const identityKey = (baseName: string, mfg: string | undefined, year: number | undefined) =>
                `${baseName.toLowerCase()}|${(mfg ?? '').toLowerCase()}|${year ?? 0}`;
            for (const t of tables) {
                const { baseName, manufacturer, year } = parseNameParts(t.name);
                const k = identityKey(baseName, manufacturer, year);
                const flags = sectionsByIdentity.get(k) ?? { auto: false, manual: false };
                if (t.section === 'wizard_auto') flags.auto = true;
                if (t.section === 'wizard_manual') flags.manual = true;
                sectionsByIdentity.set(k, flags);
            }

            // Global catalogue import with rich metadata
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            const touchedIds = new Map<string, { auto: boolean; manual: boolean }>();

            for (const table of tables) {
                try {
                    const { baseName, manufacturer, year } = parseNameParts(table.name);
                    const imageUrl = resolveWizardImageUrl(table.path, imageMap);
                    const sourceUrl = table.path
                        ? `${GITHUB_BASE}/tree/main/${table.path.replace(/^\.\//, '')}`
                        : undefined;
                    // v2.12.0: also emit the GitHub tree URL as a structured
                    // download entry. Without this, the wizard's source link
                    // only lived in `external_url` and got dropped on merge
                    // when the target row already had its own `external_url`
                    // (e.g. VPS database link). Tag with format='wizard' so
                    // the FE can label the link as "Wizard source" rather
                    // than a generic download.
                    const tableDownloadUrls = sourceUrl
                        ? [{ format: 'wizard', url: sourceUrl }]
                        : undefined;
                    const input: GlobalGameInput = {
                        name: baseName,
                        manufacturer,
                        year,
                        type: 'pinball',
                        platforms: platformsForTable(table),
                        features: [...buildFeatures(table), wizardFeature(table)],
                        image_url: imageUrl,
                        external_url: sourceUrl,
                        table_download_urls: tableDownloadUrls,
                        imported_from: 'wizard',
                    };

                    const result = await GlobalGameService.upsert(input);
                    if (result.action === 'inserted') inserted++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                    // Remember which row was touched + its overall section flags.
                    const flags = sectionsByIdentity.get(identityKey(baseName, manufacturer, year))!;
                    touchedIds.set(result.id, flags);
                } catch (err) {
                    const msg = `Failed to import Wizard table "${table.name}": ${err}`;
                    logError(msg);
                    errors.push(msg);
                    skipped++;
                }
            }

            // Reconcile wizard tags: strip stale `vpxs` / `vpxs_manual` from
            // each touched row (both columns), add back only the ones matching
            // the current README state. Other tags are left alone.
            await reconcileWizardPlatformTags(touchedIds);

            logInfo(`Wizard Import: metadata pass complete. Starting background image downloads...`);

            // Background image download pass — same non-blocking pattern as VPS.
            void downloadWizardImagesInBackground(tables, imageMap);

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
