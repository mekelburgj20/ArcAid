import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';

/**
 * Extracts the numeric IPDB machine ID from an IPDB URL.
 * Accepts both "http://" and "https://" schemes.
 * Returns null if the URL is missing or unparseable.
 */
function extractIpdbMachineId(url: string | null | undefined): string | null {
    if (!url) return null;
    const match = url.match(/ipdb\.org\/machine\.cgi\?id=(\d+)/i);
    return match ? match[1]! : null;
}

export interface GlobalGame {
    id: string;
    name: string;
    display_name: string | null;
    manufacturer: string | null;
    year: number | null;
    type: string;
    subtype: string | null;
    platforms: string;
    themes: string;
    designers: string;
    players: number | null;
    image_url: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    opdb_id: string | null;
    vps_id: string | null;
    igdb_id: number | null;
    ipdb_url: string | null;
    external_url: string | null;
    table_authors: string;
    table_download_urls: string | null;
    tutorial_urls: string | null;
    rules_urls: string | null;
    description: string | null;
    source_rating: number | null;
    features: string;
    status: string;
    submitted_by: string | null;
    reviewed_by: string | null;
    global_leaderboard: number;
    imported_from: string | null;
    imported_at: string | null;
    source_updated_at: string | null;
    created_at: string;
}

export interface GlobalGameInput {
    name: string;
    display_name?: string | null;
    manufacturer?: string | null;
    year?: number | null;
    type?: string;
    subtype?: string | null;
    platforms?: string[];
    themes?: string[];
    designers?: string[];
    players?: number | null;
    image_url?: string | null;
    local_image_path?: string | null;
    wheel_image_path?: string | null;
    opdb_id?: string | null;
    vps_id?: string | null;
    igdb_id?: number | null;
    ipdb_url?: string | null;
    external_url?: string | null;
    table_authors?: string[];
    table_download_urls?: Array<{ format: string; url: string; version?: string }>;
    tutorial_urls?: Array<{ title?: string; youtubeId?: string; url?: string }>;
    rules_urls?: Array<{ url: string; version?: string }>;
    description?: string | null;
    source_rating?: number | null;
    features?: string[];
    status?: string;
    submitted_by?: string | null;
    reviewed_by?: string | null;
    global_leaderboard?: boolean;
    imported_from?: string | null;
    source_updated_at?: string | null;
}

export class GlobalGameService {
    /**
     * Returns a single game by ID.
     */
    static async getById(id: string): Promise<GlobalGame | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM global_games WHERE id = ?', id);
    }

    /**
     * Finds a game by external ID (opdb_id, vps_id, or igdb_id).
     */
    static async findByExternalId(source: 'opdb' | 'vps' | 'igdb', externalId: string | number): Promise<GlobalGame | undefined> {
        const db = await getDatabase();
        const col = source === 'opdb' ? 'opdb_id' : source === 'vps' ? 'vps_id' : 'igdb_id';
        return db.get(`SELECT * FROM global_games WHERE ${col} = ?`, externalId);
    }

    /**
     * Finds games by normalized name match (for dedup flagging).
     *
     * v2.4.12: dropped the SQL `LIKE '%firstword%'` prefilter. It was
     * fragile — for inputs like "Gilligan's Island" the normalizer strips
     * apostrophes so the first-word fragment becomes "gilligans", but the
     * stored name retains the apostrophe ("Gilligan's Island"), and SQL
     * LIKE can't match across that gap. Catalogue rows with apostrophes,
     * periods, commas, or accented characters were invisible to upsert's
     * step-4 dedup and fell through to INSERT → UNIQUE collisions.
     *
     * At ~5k catalogue rows, full-scan + JS normalize compare runs in
     * milliseconds; negligible for admin-triggered catalogue imports.
     */
    static async findByNormalizedName(name: string): Promise<GlobalGame[]> {
        const db = await getDatabase();
        const normalized = normalizeGameName(name);
        if (!normalized) return [];
        const candidates = await db.all<GlobalGame[]>(`SELECT * FROM global_games`);
        return candidates.filter(
            (g: GlobalGame) => normalizeGameName(g.name) === normalized
        );
    }

    /**
     * True if input and candidate have mismatching IDs on the same source.
     * e.g. input.vps_id='abc' and candidate.vps_id='xyz' → conflict (distinct VPS games).
     * Empty fields on either side never create a conflict.
     */
    private static hasExternalIdConflict(input: GlobalGameInput, candidate: GlobalGame): boolean {
        if (input.opdb_id && candidate.opdb_id && candidate.opdb_id !== input.opdb_id) return true;
        if (input.vps_id && candidate.vps_id && candidate.vps_id !== input.vps_id) return true;
        if (input.igdb_id && candidate.igdb_id && candidate.igdb_id !== input.igdb_id) return true;
        return false;
    }

    /**
     * True if manufacturer and year agree closely enough to treat input/candidate as
     * the same game. Empty manufacturer on either side is a pass. Year tolerance ±1
     * because sources sometimes disagree on release date by a year.
     */
    private static manufacturerYearAgree(input: GlobalGameInput, candidate: GlobalGame): boolean {
        const inputMfg = (input.manufacturer || '').trim().toLowerCase();
        const candidateMfg = (candidate.manufacturer || '').trim().toLowerCase();
        if (inputMfg && candidateMfg && inputMfg !== candidateMfg) return false;

        if (input.year != null && candidate.year != null && Math.abs(input.year - candidate.year) > 1) return false;

        return true;
    }

    /**
     * Upserts a game into the catalogue.
     *
     * Dedup rules (post-Frankenstein fix, 2026-04-10):
     *   1. External ID match (same source ID = same game) — authoritative.
     *   2. Cross-type guard — if external ID matches but types differ (pinball vs
     *      video_game), refuse to merge. This shouldn't normally happen, but guards
     *      against future regressions.
     *   3. IPDB URL cross-reference (pinball only) — when VPS provides an ipdbUrl and
     *      an existing pinball row has the same ipdb_url, merge. This is how OPDB
     *      "real machine" rows correctly merge with their VPS "VPX recreation".
     *   4. Normalized name match — only when ALL of:
     *        • Exactly one candidate with the same normalized name
     *        • Same `type` (pinball/arcade/video_game)
     *        • No conflicting external IDs from the same source
     *        • Manufacturer agrees (case-insensitive; empty on either side is OK)
     *        • Year agrees within ±1 (null on either side is OK)
     *      Anything else → insert a new row. Normalized-name alone is never sufficient.
     */
    static async upsert(input: GlobalGameInput): Promise<{ id: string; action: 'inserted' | 'updated' | 'skipped' }> {
        const db = await getDatabase();
        const inputType = input.type || 'pinball';

        // 1. External ID match (authoritative)
        let existing: GlobalGame | undefined;
        if (input.opdb_id) existing = await this.findByExternalId('opdb', input.opdb_id);
        if (!existing && input.vps_id) existing = await this.findByExternalId('vps', input.vps_id);
        if (!existing && input.igdb_id) existing = await this.findByExternalId('igdb', input.igdb_id);

        // 2. Cross-type guard
        if (existing && existing.type !== inputType) {
            logWarn(
                `upsert: external ID match but type differs (existing=${existing.type}, input=${inputType}, name="${input.name}"). Refusing to merge across types — inserting new row.`
            );
            existing = undefined;
        }

        // 3. IPDB URL cross-reference (pinball only)
        //    Match on the IPDB machine ID extracted from the URL — ignore http/https
        //    scheme differences that sometimes differ between VPS and OPDB.
        if (!existing && inputType === 'pinball' && input.ipdb_url) {
            const inputIpdbId = extractIpdbMachineId(input.ipdb_url);
            if (inputIpdbId) {
                const pinballRows = await db.all(
                    `SELECT * FROM global_games WHERE type = 'pinball' AND ipdb_url LIKE ?`,
                    `%id=${inputIpdbId}`
                ) as GlobalGame[];

                const ipdbMatches = pinballRows.filter(
                    g => extractIpdbMachineId(g.ipdb_url) === inputIpdbId
                );

                if (ipdbMatches.length === 1) {
                    const candidate = ipdbMatches[0]!;
                    if (!this.hasExternalIdConflict(input, candidate) && this.manufacturerYearAgree(input, candidate)) {
                        existing = candidate;
                    }
                }
            }
        }

        // 4. Normalized name match with strict secondary confirmation.
        //
        // v2.4.10: two-tier match to defeat thin-duplicate interference.
        // `manufacturerYearAgree` treats NULL mfg/year as "pass," which
        // makes thin duplicates (NULL mfg + NULL year backfill leftovers)
        // blend into the candidate set and prevent single-hit resolution.
        //
        // First, prefer candidates that CONCRETELY agree on both mfg AND
        // year with the input (non-null on both sides, case-insensitive mfg
        // match, year within ±1). That's the specific machine. Only if no
        // concrete match exists do we fall back to the NULL-tolerant check
        // — keeps "sole thin candidate" merges working without letting a
        // thin row shadow a real rich row.
        if (!existing) {
            const nameMatches = (await this.findByNormalizedName(input.name))
                .filter(g => g.type === inputType);

            const nonConflicting = nameMatches.filter(g => !this.hasExternalIdConflict(input, g));

            const inputMfg = (input.manufacturer || '').trim().toLowerCase();
            const inputYear = input.year ?? null;
            // v2.4.11: exact year match (not ±1 tolerance). The loose
            // tolerance let "Breaking Bad (Original, 2021)" and "Breaking
            // Bad (Original, 2022)" both count as concrete matches for a
            // 2022 input, forcing a fall-through to INSERT on what was
            // really one of the two rich rows.
            const concrete = nonConflicting.filter(g => {
                const cMfg = (g.manufacturer || '').trim().toLowerCase();
                const cYear = g.year ?? null;
                if (!inputMfg || !cMfg || !inputYear || !cYear) return false;
                if (inputMfg !== cMfg) return false;
                if (cYear !== inputYear) return false;
                return true;
            });

            if (concrete.length === 1) {
                existing = concrete[0]!;
            } else if (concrete.length > 1) {
                // v2.4.11: same (mfg, year) matched by >1 row usually means
                // two source-import variants with slightly different `name`
                // strings that both normalize to the same key (e.g. VPS
                // "Transformers (Pro)" and Wizard "Transformers Pro" for
                // Stern 2011). Pick the richest one — most external IDs
                // first, oldest created_at as tiebreak — and UPDATE into it.
                // The other variant stays; admin can merge via the catalogue
                // UI if desired. Better than failing the whole import.
                concrete.sort((a, b) => {
                    const aScore = (a.opdb_id ? 1 : 0) + (a.vps_id ? 1 : 0) + (a.igdb_id ? 1 : 0);
                    const bScore = (b.opdb_id ? 1 : 0) + (b.vps_id ? 1 : 0) + (b.igdb_id ? 1 : 0);
                    if (aScore !== bScore) return bScore - aScore;
                    return (a.created_at ?? '').localeCompare(b.created_at ?? '');
                });
                existing = concrete[0]!;
            } else {
                // No concrete (mfg, year) match — fall back to NULL-tolerant
                // agreement so a single thin-but-solo candidate can still merge.
                const loose = nonConflicting.filter(g => this.manufacturerYearAgree(input, g));
                if (loose.length === 1) existing = loose[0]!;
            }
        }

        if (existing) {
            // Update: merge platforms, fill missing fields
            const existingPlatforms: string[] = JSON.parse(existing.platforms || '[]');
            const newPlatforms = input.platforms || [];
            const mergedPlatforms = [...new Set([...existingPlatforms, ...newPlatforms])];

            const existingThemes: string[] = JSON.parse(existing.themes || '[]');
            const newThemes = input.themes || [];
            const mergedThemes = [...new Set([...existingThemes, ...newThemes])];

            const existingDesigners: string[] = JSON.parse(existing.designers || '[]');
            const newDesigners = input.designers || [];
            const mergedDesigners = [...new Set([...existingDesigners, ...newDesigners])];

            const existingFeatures: string[] = JSON.parse(existing.features || '[]');
            const newFeatures = input.features || [];
            const mergedFeatures = [...new Set([...existingFeatures, ...newFeatures])];

            const existingAuthors: string[] = JSON.parse(existing.table_authors || '[]');
            const newAuthors = input.table_authors || [];
            const mergedAuthors = [...new Set([...existingAuthors, ...newAuthors])];

            await db.run(
                `UPDATE global_games SET
                    display_name = COALESCE(?, display_name),
                    manufacturer = COALESCE(?, manufacturer),
                    year = COALESCE(?, year),
                    subtype = COALESCE(?, subtype),
                    platforms = ?,
                    themes = ?,
                    designers = ?,
                    players = COALESCE(?, players),
                    image_url = COALESCE(?, image_url),
                    local_image_path = COALESCE(?, local_image_path),
                    wheel_image_path = COALESCE(?, wheel_image_path),
                    opdb_id = COALESCE(?, opdb_id),
                    vps_id = COALESCE(?, vps_id),
                    igdb_id = COALESCE(?, igdb_id),
                    ipdb_url = COALESCE(?, ipdb_url),
                    external_url = COALESCE(?, external_url),
                    table_authors = ?,
                    table_download_urls = COALESCE(?, table_download_urls),
                    tutorial_urls = COALESCE(?, tutorial_urls),
                    rules_urls = COALESCE(?, rules_urls),
                    description = COALESCE(?, description),
                    source_rating = COALESCE(?, source_rating),
                    features = ?,
                    source_updated_at = COALESCE(?, source_updated_at)
                WHERE id = ?`,
                input.display_name ?? null,
                input.manufacturer ?? null,
                input.year ?? null,
                input.subtype ?? null,
                JSON.stringify(mergedPlatforms),
                JSON.stringify(mergedThemes),
                JSON.stringify(mergedDesigners),
                input.players ?? null,
                input.image_url ?? null,
                input.local_image_path ?? null,
                input.wheel_image_path ?? null,
                input.opdb_id ?? null,
                input.vps_id ?? null,
                input.igdb_id ?? null,
                input.ipdb_url ?? null,
                input.external_url ?? null,
                JSON.stringify(mergedAuthors),
                input.table_download_urls ? JSON.stringify(input.table_download_urls) : null,
                input.tutorial_urls ? JSON.stringify(input.tutorial_urls) : null,
                input.rules_urls ? JSON.stringify(input.rules_urls) : null,
                input.description ?? null,
                input.source_rating ?? null,
                JSON.stringify(mergedFeatures),
                input.source_updated_at ?? null,
                existing.id
            );
            return { id: existing.id, action: 'updated' };
        }

        // Insert new game
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await db.run(
            `INSERT INTO global_games (
                id, name, display_name, manufacturer, year, type, subtype,
                platforms, themes, designers, players,
                image_url, local_image_path, wheel_image_path,
                opdb_id, vps_id, igdb_id, ipdb_url, external_url,
                table_authors, table_download_urls, tutorial_urls, rules_urls,
                description, source_rating, features,
                status, submitted_by, reviewed_by, global_leaderboard,
                imported_from, imported_at, source_updated_at
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?
            )`,
            id, input.name, input.display_name ?? null,
            input.manufacturer ?? null, input.year ?? null,
            input.type || 'pinball', input.subtype ?? null,
            JSON.stringify(input.platforms || []),
            JSON.stringify(input.themes || []),
            JSON.stringify(input.designers || []),
            input.players ?? null,
            input.image_url ?? null, input.local_image_path ?? null, input.wheel_image_path ?? null,
            input.opdb_id ?? null, input.vps_id ?? null, input.igdb_id ?? null,
            input.ipdb_url ?? null, input.external_url ?? null,
            JSON.stringify(input.table_authors || []),
            input.table_download_urls ? JSON.stringify(input.table_download_urls) : null,
            input.tutorial_urls ? JSON.stringify(input.tutorial_urls) : null,
            input.rules_urls ? JSON.stringify(input.rules_urls) : null,
            input.description ?? null, input.source_rating ?? null,
            JSON.stringify(input.features || []),
            input.status || 'approved',
            input.submitted_by ?? null, input.reviewed_by ?? null,
            input.global_leaderboard !== false ? 1 : 0,
            input.imported_from ?? null, now,
            input.source_updated_at ?? null
        );
        return { id, action: 'inserted' };
    }

    /**
     * Searches the catalogue by name (partial, case-insensitive).
     */
    static async search(query: string, options?: {
        type?: string;
        platforms?: string[];
        status?: string;
        limit?: number;
        cursor?: string;
    }): Promise<{ data: GlobalGame[]; nextCursor?: string; hasMore: boolean }> {
        const db = await getDatabase();
        const limit = options?.limit || 20;
        const conditions: string[] = ['1=1'];
        const params: any[] = [];

        if (query) {
            conditions.push('name LIKE ? COLLATE NOCASE');
            params.push(`%${query}%`);
        }
        if (options?.type) {
            conditions.push('type = ?');
            params.push(options.type);
        }
        if (options?.status) {
            conditions.push('status = ?');
            params.push(options.status);
        }
        // v2.4.x: the public catalogue browse should only surface rows with
        // at least one usable image source. The v2.4.0 backfill inserted
        // thin library-derived rows that otherwise render as empty cards on
        // the All Games tab — we'd rather omit them than show them blank.
        // Admin catalogue editing uses a different service method and isn't
        // affected by this filter.
        if (options?.status === 'approved') {
            conditions.push(
                '(local_image_path IS NOT NULL OR wheel_image_path IS NOT NULL OR image_url IS NOT NULL)',
            );
        }
        if (options?.cursor) {
            conditions.push('id > ?');
            params.push(options.cursor);
        }

        params.push(limit + 1);

        const rows: GlobalGame[] = await db.all(
            `SELECT * FROM global_games WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ?`,
            ...params
        );

        // Platform filtering (post-query since platforms is JSON)
        let filtered = rows;
        if (options?.platforms?.length) {
            filtered = rows.filter(g => {
                const gamePlatforms: string[] = JSON.parse(g.platforms || '[]');
                return options.platforms!.some(p => gamePlatforms.includes(p));
            });
        }

        const hasMore = filtered.length > limit;
        const data = filtered.slice(0, limit);
        return {
            data,
            nextCursor: hasMore ? data[data.length - 1]?.id : undefined,
            hasMore,
        };
    }

    /**
     * Returns paginated games (admin view).
     */
    static async getAll(options?: {
        status?: string;
        type?: string;
        source?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ data: GlobalGame[]; total: number; hasMore: boolean }> {
        const db = await getDatabase();
        const conditions: string[] = ['1=1'];
        const params: any[] = [];

        if (options?.status) {
            conditions.push('status = ?');
            params.push(options.status);
        }
        if (options?.type) {
            conditions.push('type = ?');
            params.push(options.type);
        }
        if (options?.source) {
            // Filter by "is this game in source X" rather than "where was it first imported from".
            // A game can exist in multiple sources (e.g. a VPS entry enriched with an OPDB ID),
            // so we filter by the presence of that source's external ID / marker.
            switch (options.source) {
                case 'opdb':
                    conditions.push('opdb_id IS NOT NULL');
                    break;
                case 'vps':
                    conditions.push('vps_id IS NOT NULL');
                    break;
                case 'igdb':
                    conditions.push('igdb_id IS NOT NULL');
                    break;
                case 'wizard':
                    // Wizard import tags games with 'wizard_auto' / 'wizard_manual' in features
                    conditions.push(`(features LIKE '%"wizard_auto"%' OR features LIKE '%"wizard_manual"%' OR imported_from = 'wizard')`);
                    break;
                case 'manual':
                    conditions.push(`(imported_from = 'manual' OR imported_from IS NULL)`);
                    break;
                default:
                    conditions.push('imported_from = ?');
                    params.push(options.source);
            }
        }

        const whereClause = conditions.join(' AND ');
        const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);
        const offset = Math.max(options?.offset ?? 0, 0);

        const countRow = await db.get(
            `SELECT COUNT(*) as c FROM global_games WHERE ${whereClause}`,
            ...params
        );
        const total = countRow?.c ?? 0;

        const data = await db.all(
            `SELECT * FROM global_games WHERE ${whereClause} ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
            ...params, limit, offset
        );

        return { data, total, hasMore: offset + data.length < total };
    }

    /**
     * Returns count of games by status.
     */
    static async getCounts(): Promise<{ total: number; approved: number; pending: number; rejected: number }> {
        const db = await getDatabase();
        const row = await db.get(`
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) as approved,
                COALESCE(SUM(CASE WHEN status = 'pending_review' THEN 1 ELSE 0 END), 0) as pending,
                COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) as rejected
            FROM global_games
        `);
        return row || { total: 0, approved: 0, pending: 0, rejected: 0 };
    }

    /**
     * Updates a game's status (approve/reject).
     */
    static async updateStatus(id: string, status: string, reviewedBy?: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE global_games SET status = ?, reviewed_by = COALESCE(?, reviewed_by) WHERE id = ?`,
            status, reviewedBy ?? null, id
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Updates a game's fields.
     */
    static async update(id: string, fields: Partial<GlobalGameInput>): Promise<boolean> {
        const db = await getDatabase();
        const sets: string[] = [];
        const params: any[] = [];

        const stringFields = ['name', 'display_name', 'manufacturer', 'type', 'subtype',
            'image_url', 'local_image_path', 'wheel_image_path',
            'opdb_id', 'vps_id', 'ipdb_url', 'external_url',
            'description', 'status', 'submitted_by', 'reviewed_by',
            'imported_from', 'source_updated_at'] as const;

        for (const f of stringFields) {
            if (f in fields) {
                sets.push(`${f} = ?`);
                params.push((fields as any)[f] ?? null);
            }
        }
        if ('year' in fields) { sets.push('year = ?'); params.push(fields.year ?? null); }
        if ('igdb_id' in fields) { sets.push('igdb_id = ?'); params.push(fields.igdb_id ?? null); }
        if ('players' in fields) { sets.push('players = ?'); params.push(fields.players ?? null); }
        if ('source_rating' in fields) { sets.push('source_rating = ?'); params.push(fields.source_rating ?? null); }
        if ('global_leaderboard' in fields) { sets.push('global_leaderboard = ?'); params.push(fields.global_leaderboard ? 1 : 0); }

        const jsonFields = ['platforms', 'themes', 'designers', 'features', 'table_authors'] as const;
        for (const f of jsonFields) {
            if (f in fields) {
                sets.push(`${f} = ?`);
                params.push(JSON.stringify((fields as any)[f] || []));
            }
        }
        const jsonObjFields = ['table_download_urls', 'tutorial_urls', 'rules_urls'] as const;
        for (const f of jsonObjFields) {
            if (f in fields) {
                sets.push(`${f} = ?`);
                params.push((fields as any)[f] ? JSON.stringify((fields as any)[f]) : null);
            }
        }

        if (sets.length === 0) return false;
        params.push(id);

        const result = await db.run(
            `UPDATE global_games SET ${sets.join(', ')} WHERE id = ?`,
            ...params
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Updates specific fields on a game identified by source + external ID.
     * Used by background image downloaders to set local_image_path / wheel_image_path
     * after the initial metadata import has returned.
     */
    static async updateBySourceId(
        source: 'opdb' | 'vps' | 'igdb',
        externalId: string | number,
        fields: { local_image_path?: string; wheel_image_path?: string }
    ): Promise<boolean> {
        const db = await getDatabase();
        const col = source === 'opdb' ? 'opdb_id' : source === 'vps' ? 'vps_id' : 'igdb_id';
        const sets: string[] = [];
        const params: any[] = [];

        if (fields.local_image_path !== undefined) {
            sets.push('local_image_path = ?');
            params.push(fields.local_image_path);
        }
        if (fields.wheel_image_path !== undefined) {
            sets.push('wheel_image_path = ?');
            params.push(fields.wheel_image_path);
        }
        if (sets.length === 0) return false;

        params.push(externalId);
        const result = await db.run(
            `UPDATE global_games SET ${sets.join(', ')} WHERE ${col} = ?`,
            ...params
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Updates image fields on a game identified by its external_url. Used by the
     * Wizard importer, which has no external ID column — the GitHub folder URL
     * is the stable identifier.
     */
    static async updateBySourceUrl(
        externalUrl: string,
        fields: { image_url?: string; local_image_path?: string; wheel_image_path?: string }
    ): Promise<boolean> {
        const db = await getDatabase();
        const sets: string[] = [];
        const params: any[] = [];

        if (fields.image_url !== undefined) {
            sets.push('image_url = COALESCE(image_url, ?)');
            params.push(fields.image_url);
        }
        if (fields.local_image_path !== undefined) {
            sets.push('local_image_path = ?');
            params.push(fields.local_image_path);
        }
        if (fields.wheel_image_path !== undefined) {
            sets.push('wheel_image_path = ?');
            params.push(fields.wheel_image_path);
        }
        if (sets.length === 0) return false;

        params.push(externalUrl);
        const result = await db.run(
            `UPDATE global_games SET ${sets.join(', ')} WHERE external_url = ?`,
            ...params
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Merges source game into target game, cascading across all related tables.
     * The source game is deleted after merge.
     */
    static async merge(targetId: string, sourceId: string): Promise<{ scoresMoved: number }> {
        const db = await getDatabase();
        let scoresMoved = 0;

        await db.exec('BEGIN TRANSACTION');
        try {
            // Move global_scores from source to target
            const scoreResult = await db.run(
                `UPDATE global_scores SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );
            scoresMoved = scoreResult.changes ?? 0;

            // Move score_reports (via score_id — indirect, but update if score references change)

            // Move global_leaderboard_cache
            await db.run(
                `DELETE FROM global_leaderboard_cache WHERE global_game_id = ?`,
                sourceId
            );

            // Update game_room_game_library links
            await db.run(
                `UPDATE game_room_game_library SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );

            // v2.4.x: also repoint game_library.global_game_id. Prior to this,
            // merge cascaded games + room-library + scores but forgot the
            // canonical library table, leaving library rows pointing at the
            // about-to-be-deleted source ID.
            await db.run(
                `UPDATE game_library SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );

            // Update games table links
            await db.run(
                `UPDATE games SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );

            // Merge external IDs from source into target (fill gaps)
            const source = await db.get('SELECT * FROM global_games WHERE id = ?', sourceId) as GlobalGame;
            if (source) {
                const target = await db.get('SELECT * FROM global_games WHERE id = ?', targetId) as GlobalGame;
                if (target) {
                    const updates: string[] = [];
                    const updateParams: any[] = [];

                    if (!target.opdb_id && source.opdb_id) { updates.push('opdb_id = ?'); updateParams.push(source.opdb_id); }
                    if (!target.vps_id && source.vps_id) { updates.push('vps_id = ?'); updateParams.push(source.vps_id); }
                    if (!target.igdb_id && source.igdb_id) { updates.push('igdb_id = ?'); updateParams.push(source.igdb_id); }
                    if (!target.ipdb_url && source.ipdb_url) { updates.push('ipdb_url = ?'); updateParams.push(source.ipdb_url); }

                    // Merge platform arrays
                    const targetPlatforms: string[] = JSON.parse(target.platforms || '[]');
                    const sourcePlatforms: string[] = JSON.parse(source.platforms || '[]');
                    const merged = [...new Set([...targetPlatforms, ...sourcePlatforms])];
                    updates.push('platforms = ?');
                    updateParams.push(JSON.stringify(merged));

                    if (updates.length > 0) {
                        updateParams.push(targetId);
                        await db.run(
                            `UPDATE global_games SET ${updates.join(', ')} WHERE id = ?`,
                            ...updateParams
                        );
                    }
                }
            }

            // Delete the source game
            await db.run('DELETE FROM global_games WHERE id = ?', sourceId);

            await db.exec('COMMIT');
            logInfo(`Merged game ${sourceId} into ${targetId}. Scores moved: ${scoresMoved}`);
        } catch (err) {
            await db.exec('ROLLBACK');
            logError('Game merge failed:', err);
            throw err;
        }

        return { scoresMoved };
    }

    /**
     * Deletes a game from the catalogue (hard delete).
     */
    static async delete(id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run('DELETE FROM global_games WHERE id = ?', id);
        return (result.changes ?? 0) > 0;
    }
}
