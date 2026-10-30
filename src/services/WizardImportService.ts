import fs from 'fs';
import path from 'path';
import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';

/**
 * Legends Unchained publishes the Table Manager's catalogue as ONE JSON file on
 * a dedicated `manifest` branch ("Catalog data as of release vX.Y.Z"). It is
 * what vpxtablemanager.com/catalog renders and what the cabinet's Table
 * Manager installs from, so it is the authoritative "which tables can a VPXS
 * cabinet install" list.
 *
 * v2.195.0: this replaced the README scrape. On 2026-10-28 the README's
 * "Wizard Tables" / "Manual Install Tables" sections were removed upstream
 * (the README now just links to the catalog site), so `parseAllSections` found
 * zero rows and every sync failed with "No tables found in README". The
 * manifest is also a far better source: every entry carries the VPS game id
 * (`vpsdbId`), so a Wizard row is a STEP-1 external-id match in
 * `GlobalGameService.upsert` instead of a name walk — the dedup can no longer
 * fork a "Lost In Space Comic Book Edition" off the VPS "Lost in Space" row.
 */
const MANIFEST_URL = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/refs/heads/manifest/manifest.json';

const GITHUB_BASE = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k';
/**
 * The `manifest` branch also publishes `boxart/<slug>.webp` — each table's
 * `launcher.png` re-encoded (~145 KB against ~1.2 MB, same picture, every
 * manifest slug covered on 2026-10-30). It is what vpxstats.legendsunchained.com
 * serves too. v2.201.0 (C12): the importer reads art from here, not from
 * `tables/<slug>/launcher.png` on `main`.
 */
const MANIFEST_RAW_BASE = 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/manifest';
/** Per-table page on the Table Manager catalog site — the link each table's own README carries. */
const CATALOG_BASE = 'https://vpxtablemanager.com/catalog/#table=';

/** The manifest fields this importer reads. Everything else is ignored. */
export interface WizardManifestEntry {
    name?: unknown;
    manufacturer?: unknown;
    year?: unknown;
    fps?: unknown;
    /** VPS GAME id — `global_games.vps_id`. */
    vpsdbId?: unknown;
    players?: unknown;
    /** VPS machine type: SS / EM / "" */
    type?: unknown;
    /** `enabled: false` in table.yml hides a table from the wizard. */
    enabled?: unknown;
    romVpsId?: unknown;
    romFileUrl?: unknown;
    romBundled?: unknown;
    backglassVpsId?: unknown;
    backglassFileUrl?: unknown;
    backglassBundled?: unknown;
    pupVpsId?: unknown;
    pupFileUrl?: unknown;
    pupRequired?: unknown;
    pupBundled?: unknown;
}

export interface WizardTable {
    /** Repo folder under `tables/`, e.g. `vpx-cactuscanyon`. */
    slug: string;
    /** Base name with the "(Manufacturer Year)" parenthetical removed. */
    name: string;
    manufacturer?: string;
    year?: number;
    /** VPS game id, when the entry carries one. */
    vpsId: string | null;
    subtype?: string;
    players?: number;
    fps: number | null;
    hasBackglass: boolean;
    requiresRom: boolean;
    hasPuppack: boolean;
}

/**
 * Reconcile the `vpxs` / `vpxs_manual` pair against the current catalogue state.
 *
 * Running this after every Wizard import means section changes update on the
 * next sync without a data-cleanup migration. Reconciling rather than
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
 * As of v2.195.0 the manifest has NO manual-install section (every listed
 * table installs through the Table Manager), so every touched row resolves to
 * `{ auto: true, manual: false }` and a stale `vpxs_manual` is stripped from
 * it. Rows the manifest no longer lists are deliberately NOT touched — the
 * old README's ~700-row manual list has no successor upstream, so there is
 * nothing to reconcile them against.
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
 * Builds feature tags from table metadata. `has_dmd` (a column of the old
 * README table) has no equivalent in the manifest and is no longer emitted.
 */
function buildFeatures(table: WizardTable): string[] {
    const features: string[] = ['wizard_auto'];
    if (table.hasBackglass) features.push('has_backglass');
    if (table.requiresRom) features.push('requires_rom');
    if (table.hasPuppack) features.push('has_puppack');
    if (table.fps !== null) features.push(`fps_${table.fps}`);
    return features;
}

/**
 * The launcher art the Table Manager shows for a table. `launcher.png` is a
 * REQUIRED file of every table folder (the repo's own validation enforces it),
 * so there is nothing to look up — the URL is a function of the slug.
 */
function wizardImageUrl(slug: string): string {
    return `${MANIFEST_RAW_BASE}/boxart/${slug}.webp`;
}

/**
 * The row's `external_url` — the table's page on the Table Manager catalog
 * site (v2.201.0, C12; it was the repo folder before). Also the key the
 * background image pass updates by (`updateBySourceUrl`).
 */
function wizardSourceUrl(slug: string): string {
    return `${CATALOG_BASE}${slug}`;
}

/** The table's folder in the repo — kept as the `wizard` download entry. */
function wizardRepoUrl(slug: string): string {
    return `${GITHUB_BASE}/tree/main/tables/${slug}`;
}

/**
 * Downloads a wizard image to local disk. Skips if already present. Returns the
 * relative DB path, or undefined on HTTP failure.
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
        // v2.201.0: the art moved from launcher.png to the manifest branch's
        // WebP re-encode; the PNG this slug downloaded before is dead weight
        // (~1.2 MB each) once the row points at the WebP, which the caller
        // does in the same pass.
        if (ext !== '.png') {
            const stalePng = path.join(dir, `${safe}.png`);
            if (fs.existsSync(stalePng)) fs.unlinkSync(stalePng);
        }
        return relPath;
    } catch {
        return undefined;
    }
}

/**
 * Background image download pass for wizard tables. Mirrors the VPS importer's
 * pattern — runs after the metadata import returns so API responses stay fast.
 */
async function downloadWizardImagesInBackground(tables: WizardTable[]): Promise<void> {
    const CONCURRENCY = 8;
    let processed = 0;
    let successes = 0;

    const tasks = tables.map(t => async () => {
        try {
            const url = wizardImageUrl(t.slug);
            const localPath = await downloadWizardImage(url, t.slug);
            if (!localPath) return;
            await GlobalGameService.updateBySourceUrl(
                wizardSourceUrl(t.slug),
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
 * the underlying value is just "Original" or "MOD". The upstream data writes
 * things like "VPW Original" or "VPDB MOD" to credit the team that built the
 * digital recreation, but VPS stores the same machine with manufacturer=
 * "Original" / "MOD". The mismatch was preventing dedup from collapsing vpx +
 * vpxs_manual variants of the same game.
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
 * The manifest carries `manufacturer` / `year` as their own fields, so this is
 * only the fallback for an entry that lacks them.
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

const nonEmptyString = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
const truthy = (v: unknown): boolean => v === true || nonEmptyString(v) !== undefined;

/**
 * Turns the manifest object (`{ "<slug>": { ...entry } }`) into the importer's
 * flat table list. Pure, so a test can feed it a fixture.
 *
 *  - an entry with no string `name` is skipped (and counted by the caller);
 *  - `enabled: false` is skipped — the Table Manager hides it, so a tournament
 *    must not be able to require it either;
 *  - `manufacturer` / `year` prefer the entry's own fields and fall back to the
 *    "(Manufacturer Year)" parenthetical of the name; the team-prefix strip
 *    applies either way.
 */
export function parseWizardManifest(raw: unknown): { tables: WizardTable[]; skippedNoName: number; disabled: number } {
    const tables: WizardTable[] = [];
    let skippedNoName = 0;
    let disabled = 0;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { tables, skippedNoName, disabled };
    }
    for (const [slug, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object') { skippedNoName++; continue; }
        const e = value as WizardManifestEntry;
        const fullName = nonEmptyString(e.name);
        if (!fullName) { skippedNoName++; continue; }
        if (e.enabled === false) { disabled++; continue; }

        const parsed = parseNameParts(fullName);
        const manufacturer = stripTeamPrefix(nonEmptyString(e.manufacturer)) ?? parsed.manufacturer;
        const year = typeof e.year === 'number' && Number.isInteger(e.year) ? e.year : parsed.year;
        const fps = typeof e.fps === 'number' && Number.isFinite(e.fps) ? Math.round(e.fps) : null;
        const players = typeof e.players === 'number' && Number.isInteger(e.players) && e.players > 0 ? e.players : undefined;

        tables.push({
            slug,
            name: parsed.baseName,
            manufacturer,
            year,
            vpsId: nonEmptyString(e.vpsdbId) ?? null,
            subtype: nonEmptyString(e.type),
            players,
            fps,
            hasBackglass: truthy(e.backglassVpsId) || truthy(e.backglassFileUrl) || e.backglassBundled === true,
            requiresRom: truthy(e.romVpsId) || truthy(e.romFileUrl) || e.romBundled === true,
            hasPuppack: truthy(e.pupVpsId) || truthy(e.pupFileUrl) || e.pupRequired === true || e.pupBundled === true,
        });
    }
    return { tables, skippedNoName, disabled };
}

export class WizardImportService {
    /** Exposed for tests. */
    static readonly MANIFEST_URL = MANIFEST_URL;

    /**
     * Fetches the Legends Unchained Table Manager manifest and imports every
     * enabled table into the global catalogue.
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
            logInfo('Wizard Import: fetching Table Manager manifest from GitHub...');
            const resp = await fetch(MANIFEST_URL);
            if (!resp.ok) throw new Error(`GitHub returned ${resp.status}`);
            const raw: unknown = await resp.json();

            const { tables, skippedNoName, disabled } = parseWizardManifest(raw);
            logInfo(
                `Wizard Import: manifest lists ${tables.length} enabled table(s)` +
                (disabled > 0 ? `, ${disabled} disabled` : '') +
                (skippedNoName > 0 ? `, ${skippedNoName} unnamed` : ''),
            );

            if (tables.length === 0) {
                throw new Error('No tables found in manifest — format may have changed');
            }

            const withoutVps = tables.filter(t => !t.vpsId);
            if (withoutVps.length > 0) {
                logWarn(`Wizard Import: ${withoutVps.length} table(s) carry no VPS id and match by name only: ${withoutVps.map(t => t.slug).join(', ')}`);
            }

            // ADR 0016 catalogue phase §5: the ENGINE is `vpx` — a standalone
            // build is a port of a VPX table with identical physics, so the
            // scores are comparable and the install method is not a property
            // of a score. "Installs through the Table Manager" is the `vpxs`
            // availability feature. (The upsert folds `vpxs` to exactly this
            // anyway; emitting it directly keeps the importer's intent
            // readable, and the reconcile pass below is what handles REMOVAL,
            // which a union merge can never do.)
            let inserted = 0;
            let updated = 0;
            let skipped = 0;
            const touchedIds = new Map<string, { auto: boolean; manual: boolean }>();

            for (const table of tables) {
                try {
                    const sourceUrl = wizardSourceUrl(table.slug);
                    const input: GlobalGameInput = {
                        name: table.name,
                        manufacturer: table.manufacturer,
                        year: table.year,
                        type: 'pinball',
                        subtype: table.subtype,
                        players: table.players,
                        platforms: ['vpx'],
                        features: [...buildFeatures(table), 'vpxs'],
                        vps_id: table.vpsId,
                        image_url: wizardImageUrl(table.slug),
                        external_url: sourceUrl,
                        // v2.12.0: also emit the GitHub tree URL as a structured
                        // download entry so the wizard's source link survives a
                        // merge onto a row that already has its own
                        // `external_url` (e.g. the VPS database link) — and,
                        // since v2.199.0 (C9), a later cross-source sync too.
                        table_download_urls: [{ format: 'wizard', url: wizardRepoUrl(table.slug) }],
                        imported_from: 'wizard',
                    };

                    const result = await GlobalGameService.upsert(input);
                    if (result.action === 'inserted') inserted++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                    touchedIds.set(result.id, { auto: true, manual: false });
                } catch (err) {
                    const msg = `Failed to import Wizard table "${table.name}" (${table.slug}): ${err}`;
                    logError(msg);
                    errors.push(msg);
                    skipped++;
                }
            }

            // Reconcile wizard tags: strip stale `vpxs` / `vpxs_manual` from
            // each touched row (both columns), add back `vpxs`. Other tags are
            // left alone.
            await reconcileWizardPlatformTags(touchedIds);

            logInfo(`Wizard Import: metadata pass complete. Starting background image downloads...`);

            // Background image download pass — same non-blocking pattern as VPS.
            void downloadWizardImagesInBackground(tables);

            logInfo(`Wizard Import: global catalogue — inserted ${inserted}, updated ${updated}, skipped ${skipped}`);

            await SyncLogService.complete(syncLogId, {
                status: errors.length > 0 ? 'partial' : 'success',
                records_imported: inserted,
                records_updated: updated,
                records_skipped: skipped,
                records_fetched: tables.length,
                errors: errors.length > 0 ? errors : undefined,
            });

            return {
                imported: inserted,
                updated,
                skipped,
                total: tables.length,
                wizardCount: tables.length,
                manualCount: 0,
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
