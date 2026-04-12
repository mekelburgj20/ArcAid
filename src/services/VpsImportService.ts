import { GameLibraryService } from './GameLibraryService.js';
import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { VPS_FORMAT_MAP } from '../utils/platformMapping.js';
import { logInfo, logError } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

interface VpsTable {
    id: string;
    name: string;
    manufacturer?: string;
    year?: number;
    type?: string;          // SS, EM, PM, OG
    theme?: string[];
    designers?: string[];
    players?: number;
    ipdbUrl?: string;
    imgUrl?: string;
    updatedAt?: number;     // Unix timestamp
    lastCreatedAt?: number;
    broken?: boolean;
    features?: string[];
    tableFiles?: VpsTableFile[];
    b2sFiles?: VpsFile[];
    wheelArtFiles?: VpsFile[];
    romFiles?: VpsFile[];
    topperFiles?: VpsFile[];
    pupPackFiles?: VpsFile[];
    povFiles?: VpsFile[];
    altColorFiles?: VpsFile[];
    altSoundFiles?: VpsFile[];
    mediaPackFiles?: VpsFile[];
    tutorialFiles?: VpsTutorialFile[];
    ruleFiles?: VpsFile[];
}

interface VpsTableFile {
    id: string;
    tableFormat?: string;
    features?: string[];
    authors?: string[];
    version?: string;
    edition?: string;
    imgUrl?: string;
    comment?: string;
    urls?: Array<{ url: string; broken?: boolean }>;
}

interface VpsFile {
    id?: string;
    urls?: Array<{ url: string; broken?: boolean }>;
    imgUrl?: string;
    version?: string;
}

interface VpsTutorialFile {
    id?: string;
    title?: string;
    youtubeId?: string;
    urls?: Array<{ url: string; broken?: boolean }>;
}

/**
 * Extracts unique table format platforms from a VPS game entry,
 * normalized to canonical platform IDs.
 */
function extractPlatforms(table: VpsTable): string[] {
    const platforms = new Set<string>();
    if (!table.tableFiles) return [];
    for (const tf of table.tableFiles) {
        if (tf.tableFormat) {
            const canonical = VPS_FORMAT_MAP[tf.tableFormat] || tf.tableFormat.toLowerCase();
            platforms.add(canonical);
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

/**
 * Extracts unique table authors across all table files.
 */
function extractAuthors(table: VpsTable): string[] {
    const authors = new Set<string>();
    if (!table.tableFiles) return [];
    for (const tf of table.tableFiles) {
        if (tf.authors) {
            for (const a of tf.authors) {
                if (a) authors.add(a);
            }
        }
    }
    return [...authors].sort();
}

/**
 * Extracts the best non-broken download URL per table format.
 */
function extractDownloadUrls(table: VpsTable): Array<{ format: string; url: string; version?: string }> {
    if (!table.tableFiles) return [];
    const downloads: Array<{ format: string; url: string; version?: string }> = [];

    for (const tf of table.tableFiles) {
        if (!tf.tableFormat || !tf.urls?.length) continue;
        const format = VPS_FORMAT_MAP[tf.tableFormat] || tf.tableFormat.toLowerCase();
        const validUrl = tf.urls.find(u => !u.broken);
        if (validUrl) {
            downloads.push({
                format,
                url: validUrl.url,
                version: tf.version,
            });
        }
    }
    return downloads;
}

/**
 * Extracts unique feature tags across all table files.
 */
function extractFeatures(table: VpsTable): string[] {
    const features = new Set<string>();
    if (table.features) {
        for (const f of table.features) features.add(f);
    }
    if (table.tableFiles) {
        for (const tf of table.tableFiles) {
            if (tf.features) {
                for (const f of tf.features) features.add(f);
            }
        }
    }
    return [...features].sort();
}

/**
 * Extracts tutorial URLs from VPS tutorialFiles.
 */
function extractTutorials(table: VpsTable): Array<{ title?: string; youtubeId?: string; url?: string }> {
    if (!table.tutorialFiles?.length) return [];
    return table.tutorialFiles
        .filter(t => t.youtubeId || t.urls?.length)
        .map(t => ({
            title: t.title,
            youtubeId: t.youtubeId,
            url: t.urls?.find(u => !u.broken)?.url,
        }));
}

/**
 * Extracts rules document URLs from VPS ruleFiles.
 */
function extractRulesUrls(table: VpsTable): Array<{ url: string; version?: string }> {
    if (!table.ruleFiles?.length) return [];
    const urls: Array<{ url: string; version?: string }> = [];
    for (const rf of table.ruleFiles) {
        if (rf.urls) {
            const validUrl = rf.urls.find(u => !u.broken);
            if (validUrl) {
                urls.push({ url: validUrl.url, version: rf.version });
            }
        }
    }
    return urls;
}

/**
 * Gets the first non-broken wheel art URL from VPS wheelArtFiles.
 */
function getWheelArtUrl(table: VpsTable): string | undefined {
    if (!table.wheelArtFiles?.length) return undefined;
    for (const wf of table.wheelArtFiles) {
        if (wf.urls) {
            const validUrl = wf.urls.find(u => !u.broken);
            if (validUrl) return validUrl.url;
        }
        if (wf.imgUrl) return wf.imgUrl;
    }
    return undefined;
}

/**
 * Resolves the best available primary image URL for a VPS table.
 * Many VPS entries (~60%) lack a top-level `imgUrl` but still have a usable
 * image on one of their tableFiles or b2sFiles. Fall back through them so
 * the catalogue shows art wherever VPS has any image at all.
 */
function getPrimaryImageUrl(table: VpsTable): string | undefined {
    if (table.imgUrl) return table.imgUrl;
    if (table.tableFiles?.length) {
        const tf = table.tableFiles.find(f => f.imgUrl);
        if (tf?.imgUrl) return tf.imgUrl;
    }
    if (table.b2sFiles?.length) {
        const bf = table.b2sFiles.find(f => f.imgUrl);
        if (bf?.imgUrl) return bf.imgUrl;
    }
    return undefined;
}

/**
 * Downloads an image to local disk. Returns local path or undefined on failure.
 * Skips download if the file already exists (idempotent re-runs).
 */
async function downloadImage(url: string, destDir: string, filename: string): Promise<string | undefined> {
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', destDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const ext = path.extname(url.split('?')[0] || '') || '.jpg';
        const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const filePath = path.join(dir, `${safeName}${ext}`);
        const relPath = `data/catalogue-images/${destDir}/${safeName}${ext}`;

        // Skip if already downloaded
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
 * Background task: downloads images for all VPS games with concurrency limiting.
 * Updates global_games rows with local_image_path / wheel_image_path as they complete.
 * Silent — errors are logged but don't throw.
 */
async function downloadImagesInBackground(tables: VpsTable[]): Promise<void> {
    const CONCURRENCY = 10;
    let processed = 0;
    let successes = 0;

    const tasks = tables.map(table => async () => {
        try {
            const updates: { local_image_path?: string; wheel_image_path?: string } = {};

            const primaryImgUrl = getPrimaryImageUrl(table);
            if (primaryImgUrl) {
                const localPath = await downloadImage(primaryImgUrl, 'vps', table.id);
                if (localPath) updates.local_image_path = localPath;
            }

            const wheelUrl = getWheelArtUrl(table);
            if (wheelUrl) {
                const localPath = await downloadImage(wheelUrl, 'vps/wheels', table.id);
                if (localPath) updates.wheel_image_path = localPath;
            }

            if (Object.keys(updates).length > 0) {
                await GlobalGameService.updateBySourceId('vps', table.id, updates);
                successes++;
            }
        } catch (err) {
            logError(`Image download failed for VPS game "${table.name}":`, err);
        } finally {
            processed++;
            if (processed % 200 === 0) {
                logInfo(`VPS image downloads: ${processed}/${tables.length} processed (${successes} successful)`);
            }
        }
    });

    // Run tasks with a concurrency pool
    const running: Set<Promise<void>> = new Set();
    for (const task of tasks) {
        const p = task().then(() => { running.delete(p); });
        running.add(p);
        if (running.size >= CONCURRENCY) {
            await Promise.race(running);
        }
    }
    await Promise.all(running);

    logInfo(`VPS image downloads: complete — ${processed} processed, ${successes} successful.`);
}

export class VpsImportService {
    /**
     * Fetches the VPS database JSON and imports games that have table files.
     * Writes to both legacy game_library (for existing room flows) and
     * global_games (for global catalogue).
     */
    static async importFromVps(): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        total: number;
        names: string[];
        autoMerged: Array<{ imported: string; existing: string }>;
    }> {
        const syncLogId = await SyncLogService.start('vps');
        const errors: string[] = [];

        try {
            logInfo('VPS Import: fetching database...');
            const resp = await fetch('https://virtualpinballspreadsheet.github.io/vps-db/db/vpsdb.json');
            if (!resp.ok) throw new Error(`VPS API returned ${resp.status}`);
            const tables: VpsTable[] = await resp.json();
            logInfo(`VPS Import: received ${tables.length} entries`);

            // Skip broken entries, only import entries with playable table files
            const playable = tables.filter(t => t.name && !t.broken && t.tableFiles && t.tableFiles.length > 0);
            logInfo(`VPS Import: ${playable.length} games with table files`);

            // Legacy import for game_library (backward compat)
            const legacyGames = playable.map(t => ({
                name: buildGameName(t),
                aliases: t.name !== buildGameName(t) ? t.name : '',
                style_id: '',
                mode: 'pinball' as const,
                css_title: '', css_initials: '', css_scores: '', css_box: '', bg_color: '',
                platforms: JSON.stringify(extractPlatforms(t)),
                external_url: `https://virtualpinballspreadsheet.github.io/games?game=${t.id}`,
            }));

            const legacyResult = await GameLibraryService.importGames(legacyGames);

            // Global catalogue import with rich metadata
            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            // Process games without image downloads first (fast path, ~10-20s for 2500 games)
            // Image downloads happen in a separate background pass after metadata is imported.
            for (const table of playable) {
                try {
                    const input: GlobalGameInput = {
                        name: table.name,
                        manufacturer: table.manufacturer,
                        year: table.year,
                        type: 'pinball',
                        subtype: table.type || undefined, // SS, EM, PM, OG
                        platforms: extractPlatforms(table),
                        themes: table.theme || [],
                        designers: table.designers || [],
                        players: table.players,
                        vps_id: table.id,
                        ipdb_url: table.ipdbUrl,
                        external_url: `https://virtualpinballspreadsheet.github.io/games?game=${table.id}`,
                        image_url: getPrimaryImageUrl(table),
                        table_authors: extractAuthors(table),
                        table_download_urls: extractDownloadUrls(table),
                        tutorial_urls: extractTutorials(table),
                        rules_urls: extractRulesUrls(table),
                        features: extractFeatures(table),
                        imported_from: 'vps',
                        source_updated_at: table.updatedAt
                            ? new Date(table.updatedAt).toISOString()
                            : undefined,
                    };

                    const result = await GlobalGameService.upsert(input);
                    if (result.action === 'inserted') inserted++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                } catch (err) {
                    const msg = `Failed to import VPS game "${table.name}": ${err}`;
                    logError(msg);
                    errors.push(msg);
                    skipped++;
                }
            }

            logInfo(`VPS Import: metadata pass complete. Starting background image downloads...`);

            // Background image download pass — parallelized with concurrency limit.
            // This runs after the main import returns so the API responds quickly.
            void downloadImagesInBackground(playable);

            const names = legacyGames.map(g => g.name);
            logInfo(`VPS Import: global catalogue — inserted ${inserted}, updated ${updated}, skipped ${skipped}`);

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
                names,
                autoMerged: legacyResult.autoMerged,
            };
        } catch (err) {
            logError('VPS Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }
}
