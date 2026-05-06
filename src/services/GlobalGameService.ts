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
    /**
     * v2.5.0: read-only dedup walker. Returns the same `existing` candidate
     * that `upsert` would resolve to (via the 4-step hierarchy), plus the full
     * set of normalized-name matches so callers (e.g. the per-room proposal
     * preview) can surface a "did you mean one of these?" list to the user.
     *
     * Mirrors `upsert`'s dedup semantics exactly — pulled out so both the
     * write path and the new read-only proposal path consult the same logic.
     * Keep in sync with `upsert`'s remaining lines.
     */
    private static async resolveDedupCandidates(input: GlobalGameInput): Promise<{
        existing: GlobalGame | undefined;
        nameMatches: GlobalGame[];
    }> {
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
                `dedup: external ID match but type differs (existing=${existing.type}, input=${inputType}, name="${input.name}"). Refusing to merge across types.`
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
        const nameMatches = (await this.findByNormalizedName(input.name))
            .filter(g => g.type === inputType);
        if (!existing) {
            const nonConflicting = nameMatches.filter(g => !this.hasExternalIdConflict(input, g));

            const inputMfg = (input.manufacturer || '').trim().toLowerCase();
            const inputYear = input.year ?? null;
            // v2.4.11: exact year match (not ±1 tolerance). The loose
            // tolerance let "Breaking Bad (Original, 2021)" and "Breaking
            // Bad (Original, 2022)" both count as concrete matches for a
            // 2022 input, forcing a fall-through to INSERT on what was
            // really one of the two rich rows.
            //
            // v2.4.15: concrete match runs against the FULL nameMatches set,
            // not just `nonConflicting`. The Frankenstein-prevention guard
            // (hasExternalIdConflict) is too strict when canonical identity
            // already agrees — a pinball machine has a single (name, mfg,
            // year) identity by physical reality, so a divergent vps_id /
            // opdb_id / igdb_id just means the source re-indexed its own
            // database (VPS does this occasionally). Accept the merge; the
            // COALESCE-based UPDATE replaces the stale external ID with the
            // new authoritative one.
            const concrete = nameMatches.filter(g => {
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
                if (loose.length === 1) {
                    existing = loose[0]!;
                } else if (loose.length > 1) {
                    // v2.4.13: when multiple loose-matches exist (e.g.
                    // Wizard input has NULL mfg/year and the catalogue has
                    // a rich row + a thin backfill residue that both pass
                    // NULL-tolerant agreement), prefer the richest. Keeps
                    // the import from falling through to INSERT when a
                    // usable counterpart exists. SpongeBob's Bikini Bottom
                    // Pinball was the canary — no parens in the Wizard
                    // name so parseNameParts returns no mfg/year, and both
                    // rich (Original, 2021) and thin (NULL, NULL) rows
                    // loose-matched.
                    loose.sort((a, b) => {
                        const aScore = (a.opdb_id ? 1 : 0) + (a.vps_id ? 1 : 0) + (a.igdb_id ? 1 : 0)
                            + (a.manufacturer ? 1 : 0) + (a.year ? 1 : 0);
                        const bScore = (b.opdb_id ? 1 : 0) + (b.vps_id ? 1 : 0) + (b.igdb_id ? 1 : 0)
                            + (b.manufacturer ? 1 : 0) + (b.year ? 1 : 0);
                        if (aScore !== bScore) return bScore - aScore;
                        return (a.created_at ?? '').localeCompare(b.created_at ?? '');
                    });
                    existing = loose[0]!;
                }
            }
        }

        return { existing, nameMatches };
    }

    /**
     * v2.5.0: public read-only dedup preview. Used by the per-room proposal
     * flow to show a user "did this game already exist?" before they commit
     * a write. Returns the same `existing` candidate `upsert` would resolve
     * to (the "exact" match) plus all *other* same-type name-normalized
     * matches as `possible` for the user to review.
     *
     * No writes. Safe to call from public-facing proposal preview routes.
     */
    static async findCandidates(input: GlobalGameInput): Promise<{
        exact: GlobalGame | null;
        possible: GlobalGame[];
    }> {
        const { existing, nameMatches } = await this.resolveDedupCandidates(input);
        const exact = existing ?? null;
        const possible = exact
            ? nameMatches.filter(g => g.id !== exact.id)
            : nameMatches;
        return { exact, possible };
    }

    static async upsert(input: GlobalGameInput): Promise<{ id: string; action: 'inserted' | 'updated' | 'skipped' }> {
        const db = await getDatabase();
        const inputType = input.type || 'pinball';

        const { existing } = await this.resolveDedupCandidates(input);

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
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
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
     * Merges source game into target game. Cascades all FK references across
     * related tables, unions the source's content (themes, designers, table
     * authors, features, download/tutorial/rules URLs) into the target, fills
     * scalar content gaps on the target (description, images, source_rating),
     * then deletes the source row.
     *
     * Identity fields (name, display_name, manufacturer, year, subtype,
     * players) are NEVER pulled from source — the target keeps its identity.
     * External IDs (opdb_id, vps_id, igdb_id, ipdb_url) are filled when the
     * target is missing one and the source has it.
     *
     * Object-array merges (table_download_urls, tutorial_urls, rules_urls)
     * dedup by `.url` so re-running the merge is idempotent and you don't
     * accumulate duplicate links.
     */
    static async merge(targetId: string, sourceId: string): Promise<{ scoresMoved: number }> {
        const db = await getDatabase();
        let scoresMoved = 0;

        await db.exec('BEGIN TRANSACTION');
        try {
            // --- FK cascades ---

            // global_scores: move to target.
            const scoreResult = await db.run(
                `UPDATE global_scores SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );
            scoresMoved = scoreResult.changes ?? 0;

            // global_leaderboard_cache: drop source's entry (rebuilds on next read).
            await db.run(
                `DELETE FROM global_leaderboard_cache WHERE global_game_id = ?`,
                sourceId
            );

            // game_room_game_library / games: simple FK updates.
            await db.run(
                `UPDATE game_room_game_library SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );
            await db.run(
                `UPDATE games SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );

            // global_game_ratings has UNIQUE(global_game_id, discord_user_id).
            // OR IGNORE moves rows where the user hasn't already rated the
            // target; the leftover source rows (where they had) are dropped
            // with a follow-up DELETE so the source is fully cleared.
            await db.run(
                `UPDATE OR IGNORE global_game_ratings SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );
            await db.run(
                `DELETE FROM global_game_ratings WHERE global_game_id = ?`,
                sourceId
            );

            // global_game_comments has no UNIQUE constraint — plain move.
            await db.run(
                `UPDATE global_game_comments SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );

            // room_game_tags has PRIMARY KEY (game_room_id, global_game_id, tag).
            // Same pattern as ratings — OR IGNORE then sweep.
            await db.run(
                `UPDATE OR IGNORE room_game_tags SET global_game_id = ? WHERE global_game_id = ?`,
                targetId, sourceId
            );
            await db.run(
                `DELETE FROM room_game_tags WHERE global_game_id = ?`,
                sourceId
            );

            // --- Data union onto target ---

            const source = await db.get('SELECT * FROM global_games WHERE id = ?', sourceId) as GlobalGame;
            if (source) {
                const target = await db.get('SELECT * FROM global_games WHERE id = ?', targetId) as GlobalGame;
                if (target) {
                    const updates: string[] = [];
                    const updateParams: any[] = [];

                    // External IDs — fill gaps only.
                    if (!target.opdb_id && source.opdb_id) { updates.push('opdb_id = ?'); updateParams.push(source.opdb_id); }
                    if (!target.vps_id && source.vps_id) { updates.push('vps_id = ?'); updateParams.push(source.vps_id); }
                    if (!target.igdb_id && source.igdb_id) { updates.push('igdb_id = ?'); updateParams.push(source.igdb_id); }
                    if (!target.ipdb_url && source.ipdb_url) { updates.push('ipdb_url = ?'); updateParams.push(source.ipdb_url); }
                    if (!target.external_url && source.external_url) { updates.push('external_url = ?'); updateParams.push(source.external_url); }

                    // String arrays — union.
                    const unionStrings = (a: string | null | undefined, b: string | null | undefined): string => {
                        const ax: string[] = JSON.parse(a || '[]');
                        const bx: string[] = JSON.parse(b || '[]');
                        return JSON.stringify([...new Set([...ax, ...bx])]);
                    };
                    updates.push('platforms = ?');     updateParams.push(unionStrings(target.platforms, source.platforms));
                    updates.push('themes = ?');       updateParams.push(unionStrings(target.themes, source.themes));
                    updates.push('designers = ?');    updateParams.push(unionStrings(target.designers, source.designers));
                    updates.push('table_authors = ?'); updateParams.push(unionStrings(target.table_authors, source.table_authors));
                    updates.push('features = ?');     updateParams.push(unionStrings(target.features, source.features));

                    // Object arrays — append source items whose .url isn't
                    // already on target. Idempotent: re-merging the same pair
                    // doesn't accumulate duplicates.
                    const appendByUrl = (a: string | null | undefined, b: string | null | undefined): string | null => {
                        const ax: Array<{ url?: string }> = a ? JSON.parse(a) : [];
                        const bx: Array<{ url?: string }> = b ? JSON.parse(b) : [];
                        const seen = new Set(ax.map(x => x.url).filter(Boolean));
                        const merged = [...ax];
                        for (const item of bx) {
                            if (item.url && !seen.has(item.url)) { merged.push(item); seen.add(item.url); }
                            else if (!item.url) merged.push(item);
                        }
                        return merged.length > 0 ? JSON.stringify(merged) : null;
                    };
                    updates.push('table_download_urls = ?'); updateParams.push(appendByUrl(target.table_download_urls, source.table_download_urls));
                    updates.push('tutorial_urls = ?');       updateParams.push(appendByUrl(target.tutorial_urls, source.tutorial_urls));
                    updates.push('rules_urls = ?');          updateParams.push(appendByUrl(target.rules_urls, source.rules_urls));

                    // Scalar content — fill gaps only. Identity fields (name,
                    // display_name, manufacturer, year, subtype, players)
                    // intentionally excluded; target keeps its identity.
                    if (!target.description && source.description) { updates.push('description = ?'); updateParams.push(source.description); }
                    if (!target.image_url && source.image_url) { updates.push('image_url = ?'); updateParams.push(source.image_url); }
                    if (!target.local_image_path && source.local_image_path) { updates.push('local_image_path = ?'); updateParams.push(source.local_image_path); }
                    if (!target.wheel_image_path && source.wheel_image_path) { updates.push('wheel_image_path = ?'); updateParams.push(source.wheel_image_path); }
                    if (target.source_rating == null && source.source_rating != null) { updates.push('source_rating = ?'); updateParams.push(source.source_rating); }
                    if (!target.source_updated_at && source.source_updated_at) { updates.push('source_updated_at = ?'); updateParams.push(source.source_updated_at); }

                    if (updates.length > 0) {
                        updateParams.push(targetId);
                        await db.run(
                            `UPDATE global_games SET ${updates.join(', ')} WHERE id = ?`,
                            ...updateParams
                        );
                    }
                }
            }

            // Delete the source row.
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
