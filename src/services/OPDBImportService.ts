import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';

/** OPDB nested manufacturer object */
interface OPDBManufacturer {
    manufacturer_id?: number;
    name?: string;
    full_name?: string;
}

/** OPDB nested feature object */
interface OPDBFeature {
    feature_id?: number;
    name?: string;
    description?: string;
}

/** OPDB nested image object */
interface OPDBImage {
    title?: string;
    primary?: boolean;
    type?: string;
    urls?: {
        large?: string;
        medium?: string;
        small?: string;
    };
    sizes?: {
        large?: string;
        medium?: string;
        small?: string;
    };
}

interface OPDBMachine {
    opdb_id?: string;
    id?: string;
    name: string;
    common_name?: string | null;
    shortname?: string | null;
    manufacturer?: OPDBManufacturer | string | null;
    manufacture_date?: string | null;
    year?: number;
    type?: string;                    // SS, EM, etc.
    display?: string;                 // dmd, alpha, score_reels, lcd
    ipdb_id?: number | null;
    players?: number;
    image_url?: string;
    images?: OPDBImage[];
    features?: Array<OPDBFeature | string>;
    keywords?: string[];
    description?: string | null;
    [key: string]: any;               // Additional fields from bulk export
}

/** Extract manufacturer name from nested object or string */
function extractManufacturerName(mfg: OPDBManufacturer | string | null | undefined): string | undefined {
    if (!mfg) return undefined;
    if (typeof mfg === 'string') return mfg;
    return mfg.name || mfg.full_name || undefined;
}

/** Extract feature names from nested objects or strings */
function extractFeatureNames(features: Array<OPDBFeature | string> | undefined): string[] {
    if (!features) return [];
    return features
        .map(f => typeof f === 'string' ? f : f.name)
        .filter((n): n is string => !!n);
}

/** Pick the primary (or first available) image URL from OPDB's images array */
function extractImageUrl(machine: OPDBMachine): string | undefined {
    if (machine.image_url) return machine.image_url;
    if (!machine.images?.length) return undefined;
    const primary = machine.images.find(i => i.primary) || machine.images[0];
    return primary?.urls?.large || primary?.urls?.medium || primary?.sizes?.large || primary?.sizes?.medium;
}

/**
 * Downloads an image to local disk. Returns local path or undefined on failure.
 */
async function downloadImage(url: string, filename: string | undefined): Promise<string | undefined> {
    if (!filename) return undefined;
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'opdb');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const resp = await fetch(url);
        if (!resp.ok) return undefined;

        const buffer = Buffer.from(await resp.arrayBuffer());
        const ext = path.extname(url.split('?')[0] || '') || '.jpg';
        const safeName = filename.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
        const filePath = path.join(dir, `${safeName}${ext}`);
        fs.writeFileSync(filePath, buffer);
        return `data/catalogue-images/opdb/${safeName}${ext}`;
    } catch {
        return undefined;
    }
}

export class OPDBImportService {
    /**
     * Imports machines from the OPDB bulk export endpoint.
     * Requires OPDB_API_KEY to be set in environment/settings.
     */
    static async importFromOPDB(): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        total: number;
    }> {
        const apiKey = process.env.OPDB_API_KEY;
        if (!apiKey) {
            throw new Error('OPDB_API_KEY is not configured. Register at https://opdb.org to get an API key.');
        }

        const syncLogId = await SyncLogService.start('opdb');
        const errors: string[] = [];

        try {
            logInfo('OPDB Import: fetching bulk export...');
            // OPDB bulk export uses api_token as a query parameter (not Bearer header)
            // Rate limit: once per hour per key
            const resp = await fetch(`https://opdb.org/api/export?api_token=${encodeURIComponent(apiKey)}`, {
                headers: { 'Accept': 'application/json' },
            });

            if (!resp.ok) {
                throw new Error(`OPDB API returned ${resp.status}: ${await resp.text()}`);
            }

            const machines: OPDBMachine[] = await resp.json();
            logInfo(`OPDB Import: received ${machines.length} machines`);

            let inserted = 0;
            let updated = 0;
            let skipped = 0;

            for (const machine of machines) {
                try {
                    const opdbId = machine.opdb_id || machine.id || '';
                    if (!machine.name || !opdbId) {
                        skipped++;
                        continue;
                    }

                    // Parse year from manufacture_date or year field
                    let year = machine.year;
                    if (!year && machine.manufacture_date) {
                        const match = machine.manufacture_date.match(/(\d{4})/);
                        if (match?.[1]) year = parseInt(match[1], 10);
                    }

                    // Build features from display type + nested feature objects
                    const features: string[] = [];
                    if (machine.display) features.push(`display_${machine.display}`);
                    features.push(...extractFeatureNames(machine.features));
                    if (machine.keywords) features.push(...machine.keywords);

                    const imageUrl = extractImageUrl(machine);

                    const input: GlobalGameInput = {
                        name: machine.name,
                        manufacturer: extractManufacturerName(machine.manufacturer),
                        year,
                        type: 'pinball',
                        subtype: machine.type, // SS, EM, etc.
                        platforms: ['real'],
                        players: machine.players,
                        opdb_id: opdbId,
                        ipdb_url: machine.ipdb_id ? `https://www.ipdb.org/machine.cgi?id=${machine.ipdb_id}` : undefined,
                        description: machine.description ?? undefined,
                        features,
                        imported_from: 'opdb',
                        image_url: imageUrl,
                    };

                    // Download image locally
                    if (imageUrl) {
                        const localPath = await downloadImage(imageUrl, opdbId);
                        if (localPath) input.local_image_path = localPath;
                    }

                    const result = await GlobalGameService.upsert(input);
                    if (result.action === 'inserted') inserted++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;
                } catch (err) {
                    const msg = `Failed to import OPDB machine "${machine.name}": ${err}`;
                    logError(msg);
                    errors.push(msg);
                    skipped++;
                }
            }

            logInfo(`OPDB Import: inserted ${inserted}, updated ${updated}, skipped ${skipped}`);

            await SyncLogService.complete(syncLogId, {
                status: errors.length > 0 ? 'partial' : 'success',
                records_imported: inserted,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length > 0 ? errors : undefined,
            });

            return { imported: inserted, updated, skipped, total: machines.length };
        } catch (err) {
            logError('OPDB Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }

    /**
     * Searches OPDB typeahead (unauthenticated). Used for "Did you mean?" suggestions.
     */
    static async typeaheadSearch(query: string): Promise<Array<{
        id: string;
        name: string;
        supplementary: string;
        display: string;
    }>> {
        const resp = await fetch(
            `https://opdb.org/api/search/typeahead?q=${encodeURIComponent(query)}`
        );
        if (!resp.ok) {
            logError(`OPDB typeahead returned ${resp.status}`);
            return [];
        }
        return resp.json();
    }
}
