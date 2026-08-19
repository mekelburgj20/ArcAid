import https from 'https';
import zlib from 'zlib';
import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';
import { getDatabase } from '../database/database.js';
import { PACK_CONTENTS, SW_VR_SEED_TABLES } from './steamPinballPackContents.js';
import { foldCataloguePlatforms } from '../utils/scoreProvenance.js';

/**
 * v2.5.0 — Steam Pinball catalogue importer.
 *
 * Pulls the DLC list for each of Zen / Zaccaria's six Steam pinball products,
 * then for each DLC either:
 *   - Expands a pack into its constituent table names (curated PACK_CONTENTS map), OR
 *   - Strips the publisher prefix and upserts the single table as a global_games row.
 *
 * Star Wars Pinball VR (parent app 1530770) has no DLC list — its tables are
 * baked into the base game — so we seed from the curated SW_VR_SEED_TABLES list.
 *
 * Steam app IDs verified live on 2026-04-25; pack contents extracted from the
 * user-curated tmp/pack-contents-draft.md. See steamPinballPackContents.ts for
 * the data source-of-truth.
 *
 * Mirrors VpsImportService's lifecycle: SyncLogService.start → per-product loop
 * → SyncLogService.complete with metrics + Discord alert on failure/partial.
 */

interface SteamProduct {
    appId: number;
    platformId: string;
    label: string;
    /** Zaccaria Pinball is a single Steam SKU but VR mode is a built-in entitlement. */
    zaccariaVrTwin?: boolean;
}

const STEAM_PINBALL_PRODUCTS: SteamProduct[] = [
    { appId: 442120,  platformId: 'pinball_fx_classic',     label: 'Pinball FX Classic' },     // formerly Pinball FX3
    { appId: 2328760, platformId: 'pinball_fx',             label: 'Pinball FX' },             // current Pinball FX (2023)
    { appId: 547590,  platformId: 'pinball_fx_classic_vr',  label: 'Pinball FX Classic VR' },  // formerly Pinball FX 2 VR
    { appId: 2337640, platformId: 'pinball_fx_midnight',    label: 'Pinball FX Midnight' },    // formerly Pinball M
    { appId: 444930,  platformId: 'zaccaria',               label: 'Zaccaria Pinball', zaccariaVrTwin: true },
    { appId: 1530770, platformId: 'star_wars_pinball_vr',   label: 'Star Wars Pinball VR' },   // tables built-in
];

/**
 * Per-product publisher-prefix strippers. Run in array order; first match wins.
 * Includes pre-rebrand prefixes (FX3, FX2 VR, Pinball M) so DLCs Steam hasn't
 * renamed yet still strip cleanly.
 */
const PREFIX_STRIPPERS: Record<number, RegExp[]> = {
    442120: [
        /^Pinball FX Classic\s*[-–—:]\s*/i,
        /^Pinball FX3\s*[-–—:]\s*/i,
        /^Pinball FX2\s*[-–—:]\s*/i,
    ],
    2328760: [/^Pinball FX\s*[-–—:]\s*/i],
    547590: [
        /^Pinball FX Classic VR\s*[-–—:]\s*/i,
        /^Pinball FX2 VR\s*[-–—:]\s*/i,
        /^Pinball FX 2 VR\s*[-–—:]\s*/i,
    ],
    2337640: [
        /^Pinball FX Midnight\s*[-–—:]\s*/i,
        /^Pinball M\s*[-–—:]\s*/i,
    ],
    444930: [/^Zaccaria Pinball\s*[-–—:]\s*/i],
    1530770: [/^Star Wars(™)?\s*Pinball VR\s*[-–—:]\s*/i],
};

/**
 * Skip rules (case-insensitive) — applied to the *stripped* DLC name. Anything
 * that matches is rejected before upsert. The Soundtrack/Editor/Mode rule
 * catches the four Zaccaria non-table DLCs flagged during the dry-run review
 * (Original Soundtrack, Artwork Editor, Campaign Mode, Zombie Invasion Mode).
 */
/**
 * `packish` marks a skip reason that MIGHT still hide tables worth importing.
 * A pack can be expanded from its own store description (see extractPackTables);
 * a soundtrack or an artwork editor never can, so those are skipped outright and
 * never raise a maintenance warning.
 */
const SKIP_RULES: Array<[RegExp, string, boolean]> = [
    [/\bVolume\s*\d+\b/i,           'Volume pack', true],
    [/\bVol\.?\s*\d+\b/i,           'Volume pack', true],
    [/\bSeason\s*\d+(\s*Pack)?\b/i, 'Season pack', true],
    [/\bSeason\s+Pass\b/i,          'Season Pass', true],
    [/\bPack\b/i,                    'multi-table pack', true],
    [/\bBundle\b/i,                  'bundle', true],
    [/\bTables\b/i,                  'plural Tables (likely a pack)', true],
    [/^VR$/i,                        'VR mode entitlement', false],
    [/\bAdd-?on\b/i,                 'add-on', false],
    [/\bDLC\b/i,                     'generic DLC label', false],
    [/\b(Soundtrack|Editor|Mode)\b/i, 'non-table DLC (soundtrack/editor/game mode)', false],
];

const STEAM_API_BASE = 'https://store.steampowered.com/api/appdetails';
/**
 * Steam's anonymous appdetails endpoint rate-limits at roughly 200 requests
 * per 5-minute window. 1100ms between calls keeps a full Zaccaria scan
 * (118 DLCs × ~1.1s = ~130s) comfortably inside the limit.
 */
const FETCH_DELAY_MS = 1100;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

interface SteamFetchResult {
    status: number;
    payload: Record<string, {
        success?: boolean;
        data?: {
            name?: string;
            dlc?: number[];
            header_image?: string;
            /** Pack DLCs list their constituent tables in here — see extractPackTables. */
            detailed_description?: string;
            about_the_game?: string;
        };
    }> | null;
}

/**
 * Fetches a Steam appdetails payload with explicit gzip handling. Steam
 * frequently sends gzip-compressed responses without honoring Accept-Encoding,
 * so we always check the body's magic bytes. Returns the raw response status
 * and parsed JSON; doesn't throw on 4xx/5xx — the caller decides.
 */
function fetchAppDetails(appId: number): Promise<SteamFetchResult> {
    return new Promise((resolve, reject) => {
        const opts = {
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'identity',
                'User-Agent': 'ArcAid-SteamPinballImporter/1.0',
            },
        };
        https.get(`${STEAM_API_BASE}?appids=${appId}`, opts, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                try {
                    let buf = Buffer.concat(chunks);
                    const enc = (res.headers['content-encoding'] || '').toString().toLowerCase();
                    if (enc === 'gzip' || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
                        buf = zlib.gunzipSync(buf);
                    } else if (enc === 'br') {
                        buf = zlib.brotliDecompressSync(buf);
                    } else if (enc === 'deflate') {
                        buf = zlib.inflateSync(buf);
                    }
                    const text = buf.toString('utf8');
                    let payload = null;
                    try { payload = JSON.parse(text); } catch { /* leave null on rate-limit / null body */ }
                    resolve({ status: res.statusCode || 0, payload });
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

function stripPrefix(rawName: string, appId: number): string {
    const strippers = PREFIX_STRIPPERS[appId] || [];
    for (const rx of strippers) {
        if (rx.test(rawName)) return rawName.replace(rx, '').trim();
    }
    return rawName.trim();
}

/**
 * Table names hidden inside a pack DLC's own Steam store description.
 *
 * The curated `PACK_CONTENTS` map only ever covered 78 hand-listed packs and had
 * "no defined go-forward path" — so every pack Zen or Zaccaria shipped after
 * v2.5.0 was silently skipped. On the Zaccaria app alone that lost 40 Retro
 * tables (one DLC) and seven EM+ packs, plus the POSTAL / Primal Carnage /
 * Chernobylite / Fallen Aces / Blood West licensed packs.
 *
 * Steam lists the contents in the description, so they can be read rather than
 * transcribed. The formats observed live (2026-08-18):
 *
 *   "This DLC unlocks the following contents:"          -> Time Machine Retro Table
 *   "This table pack contains the following pinball..."  -> Combat EM+ table
 *   "Purchase this DLC unlocks the following content:"   -> POSTAL 2 Retro Table (Sweet Home)
 *
 * DELIBERATELY CONSERVATIVE. A marker phrase must appear, and only lines that
 * literally end in "Table"/"Tables" are taken. That means:
 *
 *   - "Bronze Pack", which says "Does NOT include any table unlocks" and then
 *     lists "Ball size", "Table texture options", yields NOTHING. A looser
 *     parser would import cosmetics as pinball tables.
 *   - "Achievement Table Pack" (19 bare names, no suffix) and "Pinball Champ
 *     Table Pack" (names inline in a sentence) also yield nothing, and are
 *     reported by the caller so they can be curated into PACK_CONTENTS by hand.
 *
 * Skipping an ambiguous pack keeps today's behaviour; guessing at one would put
 * junk in the catalogue that the dedup hierarchy would then faithfully preserve.
 */
export function extractPackTables(description: string | undefined): string[] {
    if (!description) return [];

    // Strip tags to lines. Steam wraps each entry in its own element, so the
    // tag boundaries ARE the line boundaries — splitting on <br>/<li> only
    // would miss the plain-<div> variants.
    const lines = description
        .replace(/<[^>]+>/g, '\n')
        .replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

    const markerIdx = lines.findIndex(l => MARKER.test(l));
    if (markerIdx < 0) return [];

    const out: string[] = [];
    const seen = new Set<string>();
    for (const line of lines.slice(markerIdx + 1)) {
        // Per-table detail blocks repeat the name as a heading further down;
        // stop before them rather than relying on dedup alone.
        if (/^(Information|Features)\s*:?$/i.test(line)) break;

        const m = line.match(TABLE_LINE);
        if (!m) continue;
        const name = (m[1] ?? '').trim();
        if (!name || NON_TABLE.test(name)) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(name);
    }
    return out;
}

/** Phrases that introduce a contents list. Anchored loosely — Steam copy varies. */
const MARKER = /(unlocks?|contains?|includes?)\s+the\s+following/i;

/**
 * A contents line naming a table: "<name> Table" or "<name> Tables", with an
 * optional theme parenthetical on EITHER side of the suffix. Steam is not
 * consistent about which — "POSTAL 2 Retro Table (Sweet Home)" but "POSTAL
 * Brain Damaged Retro (Suburbia) Table" — and handling only one position made
 * the same product family import under two naming conventions, which is the
 * drift that forks a catalogue row later. The parenthetical is decoration, not
 * identity: each description’s detail block gives "Name: POSTAL 2 Retro"
 * without it. Same call the AtGames importer makes about storefront labels.
 */
const TABLE_LINE = /^(.+?)\s*(?:\([^)]*\))?\s+Tables?\s*(?:\([^)]*\))?$/i;

/**
 * Cosmetics and entitlements that happen to end in "Table". Without this,
 * "1 Table Lockdown Bar" is safe (wrong suffix) but a future "Bonus Table"
 * skin would not be.
 */
const NON_TABLE = /\b(skin|sticker|cabinet|panorama|cup holder|leg|bar|picture|soundtrack|wallpaper)s?\b/i;

function checkSkip(stripped: string): { reason: string; packish: boolean } | null {
    for (const [rx, reason, packish] of SKIP_RULES) {
        if (rx.test(stripped)) return { reason, packish };
    }
    return null;
}

/**
 * Strip trademark / copyright symbols + wrapping straight-or-smart quotes from
 * a curated or fetched table name. Whitespace introduced by removal is
 * collapsed. User preference: catalogue stays clean of TM/R/C/SM symbols
 * regardless of source feed.
 */
export function cleanTableName(s: string): string {
    let out = s.replace(/[™®©℠]/g, '').replace(/\s+/g, ' ').trim();
    if (out.length >= 2) {
        const first = out[0];
        const last = out[out.length - 1];
        const matchedPair =
            (first === '"' && last === '"') ||
            (first === "'" && last === "'") ||
            (first === '“' && last === '”') ||  // curly double
            (first === '‘' && last === '’');     // curly single
        if (matchedPair) out = out.slice(1, -1).trim();
    }

    // Zaccaria names a great many of its DLCs "<table> Table" or "<table>
    // Deluxe Pinball Table", and the suffix was landing in the catalogue: a
    // 2026-08-18 dry run against a copy of prod found 19 rows named
    // "Blackbelt Table", "Combat Deluxe Pinball Table", "Strike Table" and so
    // on — the last of which is a THIRD copy of a table already held twice.
    //
    // This is NOT a pack-expansion problem; those rows arrive through the
    // single-DLC path and always have. The skip list only catches the plural
    // "Tables", so the singular sails straight through.
    //
    // Trade-off accepted: a table genuinely named "... Table" would lose the
    // word. No such row exists in the Steam feed, and the catalogue's existing
    // "King Arthur and his Round Table" is a VPX row that never passes through
    // here. Worth revisiting only if Steam ships a counter-example.
    out = out.replace(/\s+(?:Pinball\s+)?Table$/i, '').trim() || out;

    return out;
}

export class SteamPinballImportService {
    /**
     * Run a full sync across all six Steam pinball products. Returns aggregate
     * counts. SyncLogService entry is created at start, completed at end with
     * status `success` (no errors), `partial` (some product failed), or
     * `error` (catastrophic failure before any product processed).
     */
    static async importAll(): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        packsExpanded: number;
        errors: string[];
    }> {
        const syncLogId = await SyncLogService.start('steam-pinball');
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        let packsExpanded = 0;
        const errors: string[] = [];

        try {
            for (const product of STEAM_PINBALL_PRODUCTS) {
                try {
                    const r = await this.importProduct(product);
                    imported += r.imported;
                    updated += r.updated;
                    skipped += r.skipped;
                    packsExpanded += r.packsExpanded;
                } catch (err) {
                    const msg = `Product ${product.label} (${product.appId}) failed: ${(err as Error).message}`;
                    errors.push(msg);
                    logError(msg, err);
                }
            }

            const status = errors.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: imported,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length ? errors : undefined,
            });

            logInfo(
                `SteamPinball: imported=${imported} updated=${updated} skipped=${skipped} ` +
                `packsExpanded=${packsExpanded} errors=${errors.length}`,
            );
        } catch (err) {
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [(err as Error).message],
            });
            throw err;
        }

        return { imported, updated, skipped, packsExpanded, errors };
    }

    /**
     * Import a single Steam product. Returns per-product metrics so importAll
     * can aggregate.
     */
    /** Exposed for the dry-run harness; importAll is the production entry point. */
    public static async importProduct(product: SteamProduct): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        packsExpanded: number;
    }> {
        let imported = 0;
        let updated = 0;
        let skipped = 0;
        let packsExpanded = 0;

        // SW VR — no DLC API, seed from the curated list.
        if (product.appId === 1530770) {
            for (const tableName of SW_VR_SEED_TABLES) {
                const r = await this.upsertTable(tableName, product, undefined, undefined);
                if (r === 'imported') imported++;
                else if (r === 'updated') updated++;
                else skipped++;
            }
            logInfo(`SteamPinball: ${product.label} — seeded ${SW_VR_SEED_TABLES.length} built-in tables`);
            return { imported, updated, skipped, packsExpanded };
        }

        // Fetch the parent's DLC list.
        const parent = await fetchAppDetails(product.appId);
        if (parent.status === 429) {
            throw new Error(`Steam rate-limited on parent ${product.appId} (HTTP 429)`);
        }
        const data = parent.payload?.[String(product.appId)]?.data;
        if (!data) {
            throw new Error(`Parent app ${product.appId} returned no data (status=${parent.status})`);
        }
        const dlcIds: number[] = data.dlc || [];
        logInfo(`SteamPinball: ${product.label} — ${dlcIds.length} DLC entries to process`);

        const unexpandedPacks: string[] = [];
        for (let i = 0; i < dlcIds.length; i++) {
            const dlcId = dlcIds[i];
            if (dlcId === undefined) continue;  // tsconfig noUncheckedIndexedAccess
            // Pack expansion path — no Steam fetch needed for known packs.
            const packTables = PACK_CONTENTS[dlcId];
            if (packTables) {
                for (const tableName of packTables) {
                    const r = await this.upsertTable(tableName, product, undefined, `https://store.steampowered.com/app/${dlcId}/`);
                    if (r === 'imported') imported++;
                    else if (r === 'updated') updated++;
                    else skipped++;
                }
                packsExpanded++;
                continue;
            }

            // Single-table DLC path — fetch + skip-list + upsert.
            await sleep(FETCH_DELAY_MS);
            try {
                const dlc = await fetchAppDetails(dlcId);
                if (dlc.status === 429) {
                    // Rate-limit hit mid-product. Log + back off; don't crash the whole run.
                    logWarn(`SteamPinball: rate-limited on DLC ${dlcId}, backing off 30s`);
                    skipped++;
                    await sleep(30_000);
                    continue;
                }
                const dd = dlc.payload?.[String(dlcId)]?.data;
                if (!dd?.name) {
                    skipped++;
                    continue;
                }
                const stripped = stripPrefix(dd.name, product.appId);
                const skipReason = checkSkip(stripped);
                if (skipReason) {
                    // AUTO-EXPANSION (2026-08-18). A pack-ish skip may still be
                    // hiding real tables; Steam lists them in the DLC's own
                    // description, so read them rather than require a curated
                    // PACK_CONTENTS entry that nobody has a process to maintain.
                    //
                    // Curated entries still win — they are checked before the
                    // fetch above — so the 78 hand-listed packs are untouched.
                    if (skipReason.packish) {
                        const found = extractPackTables(dd.detailed_description || dd.about_the_game);
                        if (found.length > 0) {
                            for (const tableName of found) {
                                const r = await this.upsertTable(
                                    tableName, product, dd.header_image,
                                    `https://store.steampowered.com/app/${dlcId}/`,
                                );
                                if (r === 'imported') imported++;
                                else if (r === 'updated') updated++;
                                else skipped++;
                            }
                            packsExpanded++;
                            logInfo(`SteamPinball: auto-expanded "${stripped}" -> ${found.length} table(s)`);
                            continue;
                        }
                        // Marker absent or nothing parseable. Skipping matches
                        // today's behaviour; the WARN is the maintenance trigger
                        // (same doctrine as the AtGames importer's unattributed
                        // -tables warning) for adding a PACK_CONTENTS entry by
                        // hand. Known cases: "Achievement Table Pack" lists 19
                        // bare names with no "Table" suffix, and "Pinball Champ
                        // Table Pack" names its two inline in a sentence.
                        unexpandedPacks.push(stripped);
                        logWarn(`SteamPinball: pack "${stripped}" (${dlcId}) could not be auto-expanded — curate it into PACK_CONTENTS if it holds tables.`);
                    }
                    skipped++;
                    continue;
                }
                const r = await this.upsertTable(
                    stripped,
                    product,
                    dd.header_image,
                    `https://store.steampowered.com/app/${dlcId}/`,
                );
                if (r === 'imported') imported++;
                else if (r === 'updated') updated++;
                else skipped++;
            } catch (err) {
                skipped++;
                logWarn(`SteamPinball: DLC ${dlcId} failed: ${(err as Error).message}`);
            }
        }

        if (unexpandedPacks.length > 0) {
            logWarn(`SteamPinball: ${product.label} — ${unexpandedPacks.length} pack(s) still need curating: ${unexpandedPacks.join(', ')}`);
        }
        return { imported, updated, skipped, packsExpanded };
    }

    /**
     * Upsert a single table into global_games via GlobalGameService.upsert,
     * cleaning TM/R/C/SM symbols and pre-resolving any "X" vs "X Pinball"
     * suffix-variant collision so duplicate rows don't get created.
     *
     * Returns `imported` (new row inserted), `updated` (existing row's
     * platforms/metadata extended), or `skipped` (empty name / no-op).
     */
    private static async upsertTable(
        rawName: string,
        product: SteamProduct,
        headerImage: string | undefined,
        externalUrl: string | undefined,
    ): Promise<'imported' | 'updated' | 'skipped'> {
        const name = cleanTableName(rawName);
        if (!name) return 'skipped';

        // The curated map still speaks legacy ids (`pinball_fx_classic`,
        // `zaccaria_vr`) because that is what the Steam pack data was authored
        // against. The fold turns them into engines + availability so the
        // catalogue stays consistent without re-curating 220 tables
        // (ADR 0016 catalogue phase §5).
        const legacyPlatforms = [product.platformId];
        if (product.zaccariaVrTwin) legacyPlatforms.push('zaccaria_vr');
        const fold = foldCataloguePlatforms(legacyPlatforms);
        const platforms = [...fold.engines, ...fold.dropped];

        // "X" vs "X Pinball" suffix dedup pre-pass — see findSuffixVariantMatch.
        const altName = await this.findSuffixVariantMatch(name);
        const upsertName = altName || name;

        const input: GlobalGameInput = {
            name: upsertName,
            type: 'pinball',
            platforms,
            features: fold.features,
            external_url: externalUrl,
            image_url: headerImage,
        };

        const result = await GlobalGameService.upsert(input);
        return result.action === 'inserted' ? 'imported'
             : result.action === 'updated'  ? 'updated'
             : 'skipped';
    }

    /**
     * "X" vs "X Pinball" suffix dedup. The user's catalogue has cross-source
     * duplicates where one importer records "Tomb Raider" and another records
     * "Tomb Raider Pinball" — same physical table. `normalizeGameName` doesn't
     * fold the suffix, so we check directly: if the catalogue already contains
     * a row matching either the bare name or the +" Pinball" variant of the
     * input, return that row's canonical name so `GlobalGameService.upsert`
     * appends platforms instead of forking a new row.
     *
     * Case-insensitive match. Returns null when no variant exists.
     */
    private static async findSuffixVariantMatch(name: string): Promise<string | null> {
        const db = await getDatabase();

        const variants: string[] = [];
        if (/\s+Pinball$/i.test(name)) {
            variants.push(name.replace(/\s+Pinball$/i, '').trim());
        } else {
            variants.push(`${name} Pinball`);
        }

        for (const v of variants) {
            if (!v || v.toLowerCase() === name.toLowerCase()) continue;
            const row = await db.get(
                'SELECT name FROM global_games WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1',
                v, 'pinball',
            );
            if (row) return row.name as string;
        }
        return null;
    }
}
