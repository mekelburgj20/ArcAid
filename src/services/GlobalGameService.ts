import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { catalogueMatchTokens } from '../utils/platformRules.js';
import { foldCataloguePlatforms } from '../utils/scoreProvenance.js';
import { nameRankSqlCase, nameRankSqlParams } from '../utils/searchRank.js';

/**
 * Fold an inbound catalogue payload so `platforms` is an ENGINE list and
 * availability facts land in `features` (ADR 0016 catalogue phase §5).
 *
 * Applied at the ONE place every importer converges on, plus the admin PUT, so
 * migration 129's work cannot be undone by the next sync (hazard H-F) and a
 * stale client posting legacy ids upgrades rather than pollutes.
 *
 * Unrecognised tokens are KEPT on the engine axis. That is the VPS importer's
 * historical behaviour — an unmapped `tableFormat` becomes a verbatim
 * lower-cased platform id — and dropping it here would silently delete the only
 * record that a game exists in some format the taxonomy has not learnt yet.
 * (Migration 129 does drop them, deliberately and with logging; the asymmetry
 * is documented there. A one-time clean is a different act from permanently
 * refusing to record something.)
 *
 * Idempotent, because the fold is: re-folding an already-folded payload returns
 * the same engines and adds no features.
 */
function foldCatalogueInput<T extends { platforms?: string[]; features?: string[] }>(input: T): T {
    if (!input.platforms) return input;
    const fold = foldCataloguePlatforms(input.platforms);
    const platforms = [...fold.engines, ...fold.dropped];
    const features = [...new Set([
        ...(input.features ?? []).map(f => String(f).trim().toLowerCase()).filter(Boolean),
        ...fold.features,
    ])];
    return { ...input, platforms, features };
}
import { logInfo, logWarn, logError, logDebug } from '../utils/logger.js';

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

/**
 * True when a manufacturer value is virtual-only or "Original", or is
 * missing entirely — the curated dedup discriminator from the 2026-07-02
 * prod dup review. A row with one of these manufacturers is a DIFFERENT
 * game from a real-manufacturer row that happens to share an IPDB link;
 * the link is a thematic reference, not an identity claim. Exported as the
 * single source of truth so the dedup guard, upsert's IPDB routing, and any
 * future audit/strip tooling all agree on the same predicate.
 */
/**
 * Manufacturer spellings that are the SAME company, for identity comparison.
 *
 * Deliberately narrow: misspellings and punctuation variants only, never two
 * companies that merely relate to each other. A wrong entry here silently
 * merges two different machines, so each one needs a reason.
 *
 *   zacarria — a typo in the VPXS Wizard README, so it arrives on every wizard
 *              sync and cannot be fixed at the source. Without this, the wizard
 *              row for Zaccaria's Time Machine re-forks from the correctly
 *              spelled row every time the importer runs. Harmless if upstream
 *              ever fixes it: the correct spelling maps to itself.
 *
 * Applied to identity comparison only. It never rewrites a stored value — the
 * row keeps whatever its source said.
 */
const MFG_SPELLING_ALIASES: Record<string, string> = {
    zacarria: 'zaccaria',
    zacaria: 'zaccaria',
};

/** Canonical form of a manufacturer for comparison. Never for storage. */
export function canonicalManufacturer(manufacturer: string | null | undefined): string {
    const m = (manufacturer || '').trim().toLowerCase();
    return MFG_SPELLING_ALIASES[m] ?? m;
}

export function isVirtualOnlyManufacturer(manufacturer: string | null | undefined): boolean {
    const mfg = (manufacturer || '').trim().toLowerCase();
    if (!mfg) return true;
    return mfg === 'zen studios' || mfg === 'original';
}

/**
 * Translates a `source=...` admin filter into a SQL WHERE clause + params.
 * Mutates the passed arrays. The clause matches the row-level evidence
 * approach the FE display now uses (deriveSources): a row counts as "in
 * VPS" if it has vps_id, "in Wizard" if it has the wizard_auto/_manual
 * feature, etc., independently of where it was first imported. Shared by
 * `search` (with-query path) and `getAll` (no-query path) so both filter
 * the same way.
 */
function applySourceFilter(
    source: string | undefined,
    conditions: string[],
    params: unknown[],
): void {
    if (!source) return;
    switch (source) {
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
            conditions.push(`(features LIKE '%"wizard_auto"%' OR features LIKE '%"wizard_manual"%' OR imported_from = 'wizard')`);
            break;
        case 'atgames':
            // Evidence, not provenance — same rule the FE badge uses. The
            // default branch below (`imported_from = 'atgames'`) would return
            // only the rows this importer CREATED: on the first real run that
            // was 71 of 279, so filtering the catalogue by AtGames hid 208
            // rows that are demonstrably on the platform.
            conditions.push(`(atgames_id IS NOT NULL OR imported_from = 'atgames')`);
            break;
        case 'manual':
            // v2.13.0: tighten so the filter matches the FE display logic
            // (deriveSources). A row with NULL imported_from but a populated
            // vps_id / opdb_id / igdb_id / wizard feature shows VPS/OPDB/etc.
            // in the source column — it's not "manual," it's just untagged.
            // True manual rows have no external evidence.
            conditions.push(`
                (imported_from = 'manual' OR imported_from IS NULL)
                AND vps_id IS NULL
                AND opdb_id IS NULL
                AND igdb_id IS NULL
                AND atgames_id IS NULL
                AND features NOT LIKE '%"wizard_auto"%'
                AND features NOT LIKE '%"wizard_manual"%'
            `);
            break;
        default:
            conditions.push('imported_from = ?');
            params.push(source);
    }
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
    /** Search-only synonyms of unknown provenance (community acronyms and the
     *  like). NOT usable for identity — see `dedup_aliases`. */
    aliases: string | null;
    /** JSON array of alternate spellings this row answers to for DEDUP.
     *  Written only by `merge`, so every entry means "an admin decided these
     *  two rows are the same game". Read by `findByAlias`. */
    dedup_aliases: string | null;
    /** RetroAchievements game id (RA on-demand import). Joins the step-1
     *  external-id set below. Partial-UNIQUE indexed; migration 133. */
    ra_id: number | null;
    /** AtGames game id, from their public catalogue feed. Joins the step-1
     *  external-id set below. Partial-UNIQUE indexed; migration 148. */
    atgames_id: number | null;
    /** Publishing studio on the AtGames Legends platform ('Zen Studios',
     *  'Magic Pixel', 'FarSight Studios', 'AtGames Originals'). Distinct from
     *  `manufacturer` — FarSight publishes Gottlieb machines, Magic Pixel
     *  publishes Zaccaria, Zen publishes Williams. Migration 148. */
    studio: string | null;
    /** Classifier verdict at import time — a HINT for admin surfaces and the
     *  "not score-eligible" review flow, never an enforcement gate. */
    score_eligibility: string | null;
    /** How many RA boards the game had at import time (verdict evidence). */
    ra_leaderboard_count: number | null;
    /** Who triggered the RA import — players can, so a junk add needs an
     *  attributable actor. Nullable; every non-RA row has none. */
    ra_imported_by: string | null;
    ipdb_url: string | null;
    /** v2.x (catalogue-dedup-hardening): thematic IPDB reference for a
     *  virtual-only-manufacturer row (e.g. a Zen Studios or "Original" fan
     *  table referencing the real machine it's based on). Distinct from
     *  `ipdb_url`, which is reserved for identity-bearing links between
     *  real-manufacturer rows. See `isVirtualOnlyManufacturer`. */
    based_on_ipdb_url: string | null;
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
    /** v2.12.0: JSON array of additional source names whose data has been
     *  folded onto this row via merge or cross-source upsert. */
    merged_from_sources: string | null;
    /** v2.25.0: per-field source stamp JSON ('{}' = legacy/unknown). */
    field_sources?: string | null;
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
    ra_id?: number | null;
    atgames_id?: number | null;
    studio?: string | null;
    /**
     * Alternate name to run the step-4 normalized-name walk against, when the
     * source's own name carries decoration the catalogue doesn't use.
     *
     * AtGames sells "Williams™ Pinball: FunHouse™" and "Africa (Natural
     * History)"; the catalogue holds "Funhouse" and "Africa". `normalizeGameName`
     * strips edition suffixes and manufacturer parentheticals but knows nothing
     * about a brand prefix or a series label, so those names matched nothing and
     * inserted duplicates — 82 of them on the first production sync.
     *
     * The row is still STORED under `name`. This only widens what step 4 looks
     * up, so it can never change the row's identity, only which existing row it
     * recognises.
     */
    dedup_name?: string | null;
    /**
     * True when this input is an ORIGINAL digital table rather than a
     * recreation of a physical machine. Such a row must never merge onto a
     * real-manufacturer row.
     *
     * Two production incidents, both caught by the owner: AtGames' own
     * "Teenage Mutant Ninja Turtles" (an AtGames original) landed on the Data
     * East 1991 machine, and "Space Invaders (Pinball)" would have landed on
     * Bally's 1980 machine. AtGames also marks this distinction in its own
     * naming — "(Pinball)" separates its pinball TABLE from its emulated
     * arcade ROM of the same licence, which are different games on different
     * engines.
     */
    original_work?: boolean;
    score_eligibility?: string | null;
    ra_leaderboard_count?: number | null;
    ra_imported_by?: string | null;
    ipdb_url?: string | null;
    based_on_ipdb_url?: string | null;
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

/**
 * Report-a-problem (v2.25.0) — per-field source stamping.
 *
 * `global_games.field_sources` is a JSON object mapping report-relevant field
 * keys to the source label that last wrote them ('vps' | 'opdb' | 'igdb' |
 * 'wizard' | ... | 'manual'). Stamped at the upsert/update chokepoints going
 * forward; legacy rows carry '{}' (= unknown). Used by the admin feedback
 * queue to answer "is this field ours to fix or upstream's?" (ADR 0014).
 */
const STAMPABLE_SCALARS = ['display_name', 'manufacturer', 'year', 'subtype', 'players', 'description'] as const;
const STAMPABLE_ARRAYS = ['platforms', 'themes', 'designers'] as const;
const ARTWORK_KEYS = ['image_url', 'local_image_path', 'wheel_image_path'] as const;

/**
 * Merge new stamps into an existing field_sources JSON. `presenceBased`
 * matches GlobalGameService.update's `'key' in fields` write semantics
 * (an explicit null = deliberate clear, still a manual write); the default
 * non-null semantics match upsert's COALESCE writes (null = "didn't supply").
 */
function stampFieldSources(
    existingJson: string | null | undefined,
    input: Partial<GlobalGameInput>,
    opts: { isInsert?: boolean; sourceLabel?: string | null; presenceBased?: boolean },
): string {
    let out: Record<string, string>;
    try {
        const parsed = JSON.parse(existingJson || '{}');
        out = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        out = {};
    }
    const src = opts.sourceLabel || 'manual';
    const wrote = (key: string): boolean => opts.presenceBased
        ? key in input
        : (input as Record<string, unknown>)[key] != null;
    if (opts.isInsert) {
        out['name'] = src;
        out['type'] = src;
    } else if (opts.presenceBased && 'name' in input) {
        out['name'] = src;
    }
    for (const k of STAMPABLE_SCALARS) if (wrote(k)) out[k] = src;
    for (const k of STAMPABLE_ARRAYS) {
        const v = (input as Record<string, unknown>)[k];
        if (opts.presenceBased ? k in input : Array.isArray(v) && (v as unknown[]).length > 0) out[k] = src;
    }
    if (ARTWORK_KEYS.some(k => opts.presenceBased ? k in input : (input as Record<string, unknown>)[k] != null)) {
        out['artwork'] = src;
    }
    return JSON.stringify(out);
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
     * Finds a game by external ID (opdb_id, vps_id, igdb_id, ra_id, or atgames_id).
     */
    static async findByExternalId(source: 'opdb' | 'vps' | 'igdb' | 'ra' | 'atgames', externalId: string | number): Promise<GlobalGame | undefined> {
        const db = await getDatabase();
        const col = source === 'opdb' ? 'opdb_id'
            : source === 'vps' ? 'vps_id'
            : source === 'igdb' ? 'igdb_id'
            : source === 'ra' ? 'ra_id'
            : 'atgames_id';
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
     * igdb-import-hardening (2026-08): the v2.4.12 note also claimed the
     * resulting full scan was "negligible for admin-triggered catalogue
     * imports." That held for a 5k-row catalogue and a few hundred incoming
     * games; it does not hold for a bulk import, where `upsert` calls this
     * once per row and turns a run of N games into N full-table `SELECT *`
     * scans. The IGDB bulk seed is the case that proved it — it never
     * finished a single run.
     *
     * `normalizeGameName` is a pure function of the name string, so the key
     * is now persisted in `global_games.normalized_name` (migration 130) and
     * indexed. Matching is unchanged — same normalizer, same equality — but
     * the candidate set arrives via an index seek instead of a scan.
     *
     * The NULL branch is the correctness guarantee, not a fallback for
     * convenience: rows written before migration 130, and any raw INSERT
     * that bypasses this service (the two room-proposal routes in rooms.ts,
     * test fixtures), can still have no stored key. Those rows are scanned
     * and normalized exactly as before, so this method's RESULT never
     * depends on the backfill having reached a given row — only its speed
     * does. After the backfill the NULL set is empty and the scan costs one
     * indexed lookup returning nothing.
     */
    static async findByNormalizedName(name: string): Promise<GlobalGame[]> {
        const db = await getDatabase();
        const normalized = normalizeGameName(name);
        if (!normalized) return [];

        const indexed = await db.all<GlobalGame[]>(
            `SELECT * FROM global_games WHERE normalized_name = ?`,
            normalized,
        );

        const unkeyed = await db.all<GlobalGame[]>(
            `SELECT * FROM global_games WHERE normalized_name IS NULL`,
        );
        if (unkeyed.length === 0) return indexed;

        return [
            ...indexed,
            ...unkeyed.filter((g: GlobalGame) => normalizeGameName(g.name) === normalized),
        ];
    }

    /**
     * Rows whose `aliases` array contains a value that normalizes to `name`.
     *
     * Catalogue sources disagree about spelling in ways `normalizeGameName`
     * cannot bridge: it strips punctuation and leading articles and folds
     * edition suffixes, but it does NOT collapse internal spaces or hyphens.
     * So AtGames' "JunkYard" never meets VPS's "Junk Yard", "TX Sector" never
     * meets "TX-Sector", and "Blackbelt" never meets "Black Belt" — each pair
     * is one physical machine that arrived as two catalogue rows
     * (owner-reported, 2026-08-16). An alias is how a row says "I am also
     * known as this", so the next import under the other spelling lands on it
     * instead of forking again.
     *
     * READS `dedup_aliases`, NOT `aliases`. A dry run against production
     * proved that distinction is load-bearing: `aliases` is a search/synonym
     * field of unknown provenance holding community acronyms, and several are
     * attached to the WRONG row — "TZ" sits on "Tropical EM+" while Twilight
     * Zone exists separately, "WCS" on "Wood's Queen 2019" while World Cup
     * Soccer exists separately, "WH2O" on "Whirlwind" while White Water exists
     * separately. Reading that column here would have routed imports onto
     * unrelated machines — the exact failure this change exists to prevent.
     *
     * `dedup_aliases` is written only by `merge`, so every entry carries a
     * provenance: an admin decided those two rows were the same game.
     */
    static async findByAlias(name: string): Promise<GlobalGame[]> {
        const db = await getDatabase();
        const normalized = normalizeGameName(name);
        if (!normalized) return [];

        // No SQL JSON search: `aliases` is a JSON string column with no index,
        // and each entry needs `normalizeGameName` applied — which SQLite
        // cannot do. So the scan happens in JS.
        //
        // Two columns, not `SELECT *`. This runs once per import row whose
        // name matched nothing, which during a bulk VPS/IGDB pull is most of
        // them — thousands of times per run. Pulling the full 40-column row
        // (description included) for ~2,500 alias-carrying rows each time is
        // the difference between a few seconds and a few minutes. Hits are
        // rare, so fetch the whole row only for those.
        const candidates = await db.all<Array<{ id: string; dedup_aliases: string | null }>>(
            `SELECT id, dedup_aliases FROM global_games WHERE dedup_aliases IS NOT NULL AND dedup_aliases NOT IN ('', '[]')`,
        );

        const hitIds = candidates.filter(c => {
            let parsed: unknown;
            try {
                parsed = JSON.parse(c.dedup_aliases || '[]');
            } catch {
                return false;
            }
            if (!Array.isArray(parsed)) return false;
            return parsed.some(a => typeof a === 'string' && normalizeGameName(a) === normalized);
        }).map(c => c.id);

        if (hitIds.length === 0) return [];

        const placeholders = hitIds.map(() => '?').join(', ');
        return db.all<GlobalGame[]>(
            `SELECT * FROM global_games WHERE id IN (${placeholders})`,
            ...hitIds,
        );
    }

    /**
     * Dedup resolution for TAG-ONLY callers — importers that want to add a
     * feature to a row that already exists and must never author one.
     *
     * The AtGames catalogue API supplies a name and nothing else: no
     * manufacturer, no year, no console, no external id. That is not enough
     * to pick between same-named rows, and this catalogue has plenty — 362
     * normalized names shared by 2+ rows, covering 828 rows (~19%), with
     * `star wars` at 8 and `circus` at 6. Letting the ordinary dedup walk
     * adjudicate a bare name means the populatedness tie-break picks the
     * RICHEST same-named row, which is exactly how the v2.108.1 "Aliens"
     * incident re-tagged the wrong table on every sync.
     *
     * So this refuses to choose. Exactly one candidate is a match; two or
     * more is `ambiguous` and the caller must report it rather than write.
     * Callers that legitimately author rows (VPS, OPDB, IGDB, RA — all of
     * which carry real metadata) keep using `upsert` and are unaffected.
     */
    static async resolveForTagging(input: GlobalGameInput): Promise<{
        match: GlobalGame | null;
        candidates: GlobalGame[];
        ambiguous: boolean;
    }> {
        const inputType = input.type || 'pinball';

        const byName = (await this.findByNormalizedName(input.name)).filter(g => g.type === inputType);

        // Alias lookup is a FALLBACK, never an addition: if the name already
        // matched something, adding alias hits could only change which row
        // wins — and changing existing import outcomes is not what this is
        // for. Consulted only when the name matched nothing.
        const candidates = byName.length > 0
            ? byName
            : (await this.findByAlias(input.name)).filter(g => g.type === inputType);

        if (candidates.length === 1) {
            return { match: candidates[0]!, candidates, ambiguous: false };
        }
        return { match: null, candidates, ambiguous: candidates.length > 1 };
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
        if (input.ra_id && candidate.ra_id && candidate.ra_id !== input.ra_id) return true;
        if (input.atgames_id && candidate.atgames_id && candidate.atgames_id !== input.atgames_id) return true;
        return false;
    }

    /**
     * True if manufacturer and year agree closely enough to treat input/candidate as
     * the same game. Empty manufacturer on either side is a pass. Year tolerance ±1
     * because sources sometimes disagree on release date by a year.
     */
    private static manufacturerYearAgree(input: GlobalGameInput, candidate: GlobalGame): boolean {
        const inputMfg = canonicalManufacturer(input.manufacturer);
        const candidateMfg = canonicalManufacturer(candidate.manufacturer);
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
     *
     * igdb-import-hardening (2026-08): `opts.includeNameMatches` controls
     * whether the step-4 name walk runs even when steps 1–3 already resolved
     * a row. Step 4 itself is guarded by `if (!existing)` and always was, so
     * the walk's only remaining purpose in that case is populating the
     * returned `nameMatches` — which `upsert` discards and only
     * `findCandidates` (one interactive call, rendering a "did you mean?"
     * list) actually reads. The write path therefore opts out and skips a
     * query per upsert; `findCandidates` opts in and behaves exactly as
     * before. The resolved `existing` is identical either way — this cannot
     * change which row an import merges into.
     */
    private static async resolveDedupCandidates(
        input: GlobalGameInput,
        opts?: { includeNameMatches?: boolean },
    ): Promise<{
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
        // RA joins the external-id set as a peer, NOT a special case: a
        // re-import must land on the row it created last time, and the
        // cross-type guard below applies to it exactly as it does to the
        // others (an `ra_id` match onto a `pinball` row is refused).
        if (!existing && input.ra_id) existing = await this.findByExternalId('ra', input.ra_id);
        // AtGames joins the same set, and is the reason the AtGames importer
        // exists in its current form: its predecessor had no id at all, so
        // every sync re-derived identity from the name via step 4. Four
        // Zaccaria designs of one machine ("Locomotion" / "Locomotion 2018" /
        // "Locomotion Deluxe" / "Locomotion Retro") are distinct games with
        // distinct ids here, and only the id keeps them apart reliably —
        // `normalizeGameName` strips "Remake" as an edition suffix, so the
        // legacy "Locomotion Remake" spelling collides with plain "Locomotion".
        if (!existing && input.atgames_id) existing = await this.findByExternalId('atgames', input.atgames_id);

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
                    // catalogue-dedup-hardening: a shared IPDB link is only an
                    // identity signal between two REAL-manufacturer rows. A
                    // virtual-only manufacturer (Zen Studios, Original) or a
                    // missing manufacturer on either side means the IPDB link
                    // is a thematic reference, not a claim that this row IS
                    // that physical machine — refuse the match here (mirrors
                    // the cross-type guard above) and fall through to the
                    // name-match step instead of returning early.
                    if (isVirtualOnlyManufacturer(input.manufacturer) || isVirtualOnlyManufacturer(candidate.manufacturer)) {
                        logWarn(
                            `dedup: IPDB match but virtual-only/missing manufacturer on one side ` +
                            `(input manufacturer="${input.manufacturer ?? ''}", candidate manufacturer="${candidate.manufacturer ?? ''}", name="${input.name}"). ` +
                            `Refusing to treat shared IPDB link as identity match.`
                        );
                    } else if (!this.hasExternalIdConflict(input, candidate) && this.manufacturerYearAgree(input, candidate)) {
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
        //
        // Skip the walk entirely when an earlier step already resolved a row
        // and the caller has no use for the match list — see the opts note on
        // this method. `existing` is unaffected; step 4 was already inert in
        // that case.
        // `dedup_name` only widens the lookup — see its doc on GlobalGameInput.
        const lookupName = (input.dedup_name || '').trim() || input.name;
        let nameMatches = (existing && !opts?.includeNameMatches)
            ? []
            : (await this.findByNormalizedName(lookupName)).filter(g => g.type === inputType);

        // An original digital table is not the physical machine it shares a
        // name with, and it is not somebody else's fan-made table of that name
        // either. It may only land on a row that claims NO maker at all — the
        // thin, name-only rows a tag-import leaves behind.
        //
        // The first version of this guard used `isVirtualOnlyManufacturer`,
        // which treats 'Original' as virtual-only. That let AtGames' own
        // Teenage Mutant Ninja Turtles skip past both real machines and land on
        // "Teenage Mutant Ninja Turtles (Stern / Data East remix)" (Original,
        // 2024), a VPX community table — the same mis-attachment one row over.
        // 'Original' is a real answer to "who made this"; blank is not.
        if (input.original_work) {
            const dropped = nameMatches.filter(g => (g.manufacturer || '').trim() !== '');
            if (dropped.length > 0) {
                logInfo(
                    `dedup: "${input.name}" is an original work — refusing ${dropped.length} ` +
                    `candidate(s) that claim a maker (${dropped.map(g => `"${g.name}" (${g.manufacturer})`).join(', ')})`
                );
                nameMatches = nameMatches.filter(g => (g.manufacturer || '').trim() === '');
            }
        }

        // Alias FALLBACK, deliberately subordinate. Consulted only when the
        // normalized name matched nothing at all — never merged into a
        // non-empty candidate set, because adding candidates there could only
        // change which row an existing import already resolves to, and this
        // change is not allowed to move any of those. With the set empty,
        // every alias hit is strictly new reach: previously this import
        // INSERTED a duplicate.
        //
        // What it buys: `normalizeGameName` collapses neither internal spaces
        // nor hyphens, so "JunkYard"/"Junk Yard", "TX Sector"/"TX-Sector" and
        // "Blackbelt"/"Black Belt" each arrived as two rows for one machine.
        // Recording the other spelling as an alias (see `merge`) stops the
        // next import re-forking them.
        if (!existing && nameMatches.length === 0) {
            const aliasMatches = (await this.findByAlias(lookupName))
                .filter(g => g.type === inputType)
                .filter(g => !input.original_work || (g.manufacturer || '').trim() === '');
            if (aliasMatches.length > 0) {
                logInfo(
                    `dedup: name "${input.name}" matched ${aliasMatches.length} row(s) by ALIAS ` +
                    `(${aliasMatches.map(g => `"${g.name}"`).join(', ')})`
                );
                nameMatches = aliasMatches;
            }
        }
        if (!existing) {
            const nonConflicting = nameMatches.filter(g => !this.hasExternalIdConflict(input, g));

            // v2.108.1 — exact-literal-name precedence. `normalizeGameName`
            // strips leading articles, so "The Aliens" and "Aliens" collide on
            // the same normalized key, and the populatedness tie-breaks below
            // then funnel a name-only import onto the WRONG row whenever the
            // article-less cousin carries more metadata. Prod incident
            // 2026-08-14: every "Sync AtGames" click re-tagged the VPX
            // "Aliens (Original, 2020)" with the Zaccaria "The Aliens" row's
            // AtGames platforms — the community sheet was accurate the whole
            // time. When the incoming name matches one or more candidates'
            // LITERAL names exactly (case-insensitive, trimmed), the walk is
            // restricted to those candidates: an article-stripped cousin can
            // no longer outrank an exact hit. With no literal match (e.g.
            // input "Addams Family" against "The Addams Family"), the walk is
            // unchanged — article-stripping keeps doing its job.
            const inputLiteral = (input.name || '').trim().toLowerCase();
            const literal = nameMatches.filter(g => (g.name || '').trim().toLowerCase() === inputLiteral);
            const concreteBase = literal.length > 0 ? literal : nameMatches;
            const looseBase = literal.length > 0
                ? nonConflicting.filter(g => literal.includes(g))
                : nonConflicting;

            const inputMfg = canonicalManufacturer(input.manufacturer);
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
            const concrete = concreteBase.filter(g => {
                const cMfg = canonicalManufacturer(g.manufacturer);
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
                const loose = looseBase.filter(g => this.manufacturerYearAgree(input, g));
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
        const { existing, nameMatches } = await this.resolveDedupCandidates(input, {
            includeNameMatches: true,
        });
        const exact = existing ?? null;
        const possible = exact
            ? nameMatches.filter(g => g.id !== exact.id)
            : nameMatches;
        return { exact, possible };
    }

    static async upsert(input: GlobalGameInput): Promise<{ id: string; action: 'inserted' | 'updated' | 'skipped' }> {
        const db = await getDatabase();

        // catalogue-dedup-hardening: normalize the input BEFORE the dedup walk
        // so this one chokepoint covers every importer/entry point. A
        // virtual-only-manufacturer (or missing-manufacturer) row's ipdb_url
        // is a thematic reference to the real machine it's based on, not an
        // identity claim — route it to based_on_ipdb_url and clear ipdb_url
        // so it never enters the IPDB identity cross-reference (step 3 of
        // resolveDedupCandidates) or gets persisted as this row's own
        // identity link. Reassigns the local `input` (does not mutate the
        // caller's object).
        // v2.21.1: drop unparseable IPDB values at the door — VPS ships a
        // literal "Not Available" placeholder in its ipdbUrl field, which is
        // junk, not a link (it can't participate in dedup and must not be
        // preserved as a "reference" either). Applies to both columns.
        if (input.ipdb_url && !extractIpdbMachineId(input.ipdb_url)) {
            input = { ...input, ipdb_url: null };
        }
        if (input.based_on_ipdb_url && !extractIpdbMachineId(input.based_on_ipdb_url)) {
            input = { ...input, based_on_ipdb_url: null };
        }

        if (isVirtualOnlyManufacturer(input.manufacturer) && input.ipdb_url) {
            logDebug(
                `upsert: routing thematic ipdb_url to based_on_ipdb_url (name="${input.name}", manufacturer="${input.manufacturer ?? ''}")`
            );
            input = { ...input, based_on_ipdb_url: input.ipdb_url, ipdb_url: null };
        }

        // ADR 0016 catalogue phase §5 — engines in, availability to features.
        // Here rather than in each of the seven importers: this is the single
        // point they all pass through, so they cannot drift from each other or
        // from migration 129. Importers that emit a NON-obvious shape still say
        // so at their own call site (Wizard's feature pair, AtGames' native
        // engine); the ones whose ids are already engines are identity-folded.
        input = foldCatalogueInput(input);

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

            // v2.12.0: cross-source detection. When the input is from a
            // different source than the row's recorded imported_from, we're
            // doing a cross-source upsert (e.g. Wizard data landing on a row
            // first imported from VPS). In that case, union the URL object-
            // arrays by .url instead of the previous COALESCE-overwrite, and
            // append the input's source name to merged_from_sources so the
            // admin catalogue can render "vps, wizard". Same-source re-imports
            // (the common case) keep overwrite semantics so source-side
            // updates can prune stale entries.
            const isCrossSource = !!(
                input.imported_from && existing.imported_from &&
                input.imported_from !== existing.imported_from
            );

            const appendByUrl = (existingJson: string | null, newItems?: Array<{ url?: string }>): string | null => {
                if (!isCrossSource) {
                    return newItems && newItems.length > 0 ? JSON.stringify(newItems) : null;
                }
                const ax: Array<{ url?: string }> = existingJson ? JSON.parse(existingJson) : [];
                const bx = newItems || [];
                if (bx.length === 0) return existingJson;
                const seen = new Set(ax.map(x => x.url).filter(Boolean));
                const out = [...ax];
                for (const item of bx) {
                    if (item.url && !seen.has(item.url)) { out.push(item); seen.add(item.url); }
                    else if (!item.url) out.push(item);
                }
                return out.length > 0 ? JSON.stringify(out) : null;
            };

            const mergedDownloadJson = appendByUrl(existing.table_download_urls, input.table_download_urls);
            const mergedTutorialsJson = appendByUrl(existing.tutorial_urls, input.tutorial_urls);
            const mergedRulesJson = appendByUrl(existing.rules_urls, input.rules_urls);

            const existingMergedSources: string[] = JSON.parse(existing.merged_from_sources || '[]');
            let mergedSources = existingMergedSources;
            if (isCrossSource && input.imported_from && !existingMergedSources.includes(input.imported_from)) {
                mergedSources = [...existingMergedSources, input.imported_from];
            }

            // v2.25.0: per-field source stamp — fields this input supplies
            // (non-null, mirroring the COALESCE writes below) get attributed
            // to the input's source. `existing` may predate the column, so
            // read it fresh.
            const fsRow = await db.get<{ field_sources: string | null }>(
                'SELECT field_sources FROM global_games WHERE id = ?', existing.id,
            );
            const stampedFieldSources = stampFieldSources(fsRow?.field_sources, input, {
                sourceLabel: input.imported_from,
            });

            const updateSql = `UPDATE global_games SET
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
                    ra_id = COALESCE(?, ra_id),
                    atgames_id = COALESCE(?, atgames_id),
                    -- Supplied-wins, so a re-sync picks up a re-filing at the
                    -- source (AtGames moving a pack between publisher
                    -- collections). Only the AtGames importer ever supplies
                    -- this, and a null input keeps whatever is there, so no
                    -- other import path can wipe it. The trade is that an
                    -- admin correction is reverted by the next sync — fix the
                    -- attribution upstream, not in the row.
                    studio = COALESCE(?, studio),
                    -- Supplied-wins, so a re-import refreshes the verdict and
                    -- the board count from RA's current answer.
                    score_eligibility = COALESCE(?, score_eligibility),
                    ra_leaderboard_count = COALESCE(?, ra_leaderboard_count),
                    -- Reversed on purpose: the FIRST importer keeps the
                    -- credit. This is moderation provenance ("who put this
                    -- here"), and a later re-import must not overwrite it.
                    ra_imported_by = COALESCE(ra_imported_by, ?),
                    ipdb_url = COALESCE(?, ipdb_url),
                    based_on_ipdb_url = COALESCE(?, based_on_ipdb_url),
                    external_url = COALESCE(?, external_url),
                    table_authors = ?,
                    table_download_urls = ?,
                    tutorial_urls = ?,
                    rules_urls = ?,
                    description = COALESCE(?, description),
                    source_rating = COALESCE(?, source_rating),
                    features = ?,
                    source_updated_at = COALESCE(?, source_updated_at),
                    merged_from_sources = ?,
                    field_sources = ?
                WHERE id = ?`;
            const updateParams = [
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
                input.ra_id ?? null,
                input.atgames_id ?? null,
                input.studio ?? null,
                input.score_eligibility ?? null,
                input.ra_leaderboard_count ?? null,
                input.ra_imported_by ?? null,
                input.ipdb_url ?? null,
                input.based_on_ipdb_url ?? null,
                input.external_url ?? null,
                JSON.stringify(mergedAuthors),
                mergedDownloadJson,
                mergedTutorialsJson,
                mergedRulesJson,
                input.description ?? null,
                input.source_rating ?? null,
                JSON.stringify(mergedFeatures),
                input.source_updated_at ?? null,
                JSON.stringify(mergedSources),
                stampedFieldSources,
                existing.id,
            ];

            try {
                await db.run(updateSql, ...updateParams);
                return { id: existing.id, action: 'updated' };
            } catch (e: unknown) {
                const err = e as { code?: string };
                if (err?.code !== 'SQLITE_CONSTRAINT') throw e;

                // v2.12.3: the would-be UPDATE shifts this row's identity
                // tuple (LOWER(name), type, LOWER(mfg), year) to one that
                // another row already owns. By the schema's UNIQUE INDEX
                // these two rows are the same machine — typically a
                // year/manufacturer correction landing across a VPS row and
                // an OPDB row that already agree on identity. Find the
                // colliding row, merge `existing` into it (the merge
                // primitive unions data and cascades FK refs), then retry
                // the upsert against the consolidated target.
                const newName = input.name || existing.name;
                const newMfg = input.manufacturer ?? existing.manufacturer ?? '';
                const newYear = input.year ?? existing.year ?? 0;
                const colliding = await db.get(
                    `SELECT id FROM global_games
                     WHERE LOWER(name) = LOWER(?)
                       AND type = ?
                       AND LOWER(COALESCE(manufacturer, '')) = LOWER(?)
                       AND COALESCE(year, 0) = ?
                       AND id != ?`,
                    newName, inputType, newMfg, newYear, existing.id,
                ) as { id: string } | undefined;

                if (!colliding) throw e;

                logInfo(
                    `upsert: identity collision on "${newName}" (${newMfg}, ${newYear}). ` +
                    `Merging ${existing.id} -> ${colliding.id} and retrying.`
                );
                await GlobalGameService.merge(colliding.id, existing.id);
                return await GlobalGameService.upsert(input);
            }
        }

        // Insert new game
        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        await db.run(
            `INSERT INTO global_games (
                id, name, normalized_name, display_name, manufacturer, year, type, subtype,
                platforms, themes, designers, players,
                image_url, local_image_path, wheel_image_path,
                opdb_id, vps_id, igdb_id, ra_id, atgames_id, studio,
                score_eligibility, ra_leaderboard_count, ra_imported_by,
                ipdb_url, based_on_ipdb_url, external_url,
                table_authors, table_download_urls, tutorial_urls, rules_urls,
                description, source_rating, features,
                status, submitted_by, reviewed_by, global_leaderboard,
                imported_from, imported_at, source_updated_at, field_sources
            ) VALUES (
                ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?,
                ?, ?, ?, ?,
                ?, ?, ?, ?
            )`,
            // migration 130: the dedup key is written with the row it belongs
            // to. The UPDATE branch above never touches `name`, so a row's key
            // can only ever be set here or by `update()` below.
            id, input.name, normalizeGameName(input.name || ''), input.display_name ?? null,
            input.manufacturer ?? null, input.year ?? null,
            input.type || 'pinball', input.subtype ?? null,
            JSON.stringify(input.platforms || []),
            JSON.stringify(input.themes || []),
            JSON.stringify(input.designers || []),
            input.players ?? null,
            input.image_url ?? null, input.local_image_path ?? null, input.wheel_image_path ?? null,
            input.opdb_id ?? null, input.vps_id ?? null, input.igdb_id ?? null,
            input.ra_id ?? null, input.atgames_id ?? null, input.studio ?? null,
            input.score_eligibility ?? null, input.ra_leaderboard_count ?? null,
            input.ra_imported_by ?? null,
            input.ipdb_url ?? null, input.based_on_ipdb_url ?? null, input.external_url ?? null,
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
            input.source_updated_at ?? null,
            stampFieldSources('{}', input, { isInsert: true, sourceLabel: input.imported_from })
        );
        return { id, action: 'inserted' };
    }

    /**
     * Fills `manufacturer` on a row that has none, and does nothing otherwise.
     *
     * Exists so an importer can contribute a manufacturer WITHOUT putting it in
     * the upsert input. `manufacturerYearAgree` compares the input's
     * manufacturer against each candidate's, so supplying one changes which row
     * an import resolves to: an AtGames table sent as "Zaccaria" would stop
     * loose-matching the VPX recreation carrying "Original" and INSERT beside
     * it instead. Routing the value here keeps dedup behaviour byte-identical
     * to what it was before the field was known, and still lands the fact.
     *
     * Returns true when it wrote. Stamps `field_sources` with the caller's
     * source label rather than 'manual' — an importer did this, not an admin.
     */
    static async fillMissingManufacturer(
        id: string,
        manufacturer: string,
        sourceLabel: string,
    ): Promise<boolean> {
        if (!manufacturer.trim()) return false;
        const db = await getDatabase();
        const row = await db.get<{ manufacturer: string | null; field_sources: string | null }>(
            'SELECT manufacturer, field_sources FROM global_games WHERE id = ?', id,
        );
        if (!row || (row.manufacturer || '').trim()) return false;

        try {
            const result = await db.run(
                `UPDATE global_games SET manufacturer = ?, field_sources = ?
                  WHERE id = ? AND (manufacturer IS NULL OR TRIM(manufacturer) = '')`,
                manufacturer,
                stampFieldSources(row.field_sources, { manufacturer }, { sourceLabel }),
                id,
            );
            return (result.changes ?? 0) > 0;
        } catch (e: unknown) {
            // `idx_global_games_identity` covers (name, type, manufacturer,
            // year), so filling a manufacturer moves the row onto a tuple
            // another row may already own. That means the two rows are the
            // same machine and want merging — a judgement call for the admin
            // catalogue UI, not something a backfill should force. Leave the
            // manufacturer null and say so.
            if ((e as { code?: string })?.code !== 'SQLITE_CONSTRAINT') throw e;
            logWarn(
                `fillMissingManufacturer: "${manufacturer}" on ${id} collides with an existing ` +
                `(name, type, manufacturer, year) row — left unset, merge the pair manually.`,
            );
            return false;
        }
    }

    /**
     * Searches the catalogue by name (partial, case-insensitive).
     */
    static async search(query: string, options?: {
        type?: string;
        platforms?: string[];
        status?: string;
        /** v2.12.2: align with `getAll` so admin search-with-source-filter
         *  doesn't silently drop the source filter. */
        source?: string;
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
        applySourceFilter(options?.source, conditions, params);
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

        // Search-relevance work package (2026-08-13): nearest-exact-match
        // first when the caller supplied search text; untouched `ORDER BY id`
        // otherwise (empty query → existing default order, per contract).
        let orderClause = 'id';
        const orderParams: any[] = [];
        if (query) {
            orderClause = `${nameRankSqlCase('name')}, name COLLATE NOCASE`;
            orderParams.push(...nameRankSqlParams(query));
        }

        params.push(...orderParams, limit + 1);

        const rows: GlobalGame[] = await db.all(
            `SELECT * FROM global_games WHERE ${conditions.join(' AND ')} ORDER BY ${orderClause} LIMIT ?`,
            ...params
        );

        // Platform filtering (post-query since platforms is JSON).
        //
        // ADR 0016 catalogue phase §4 / hazard H-D: this used a raw
        // `includes(p)` while `GlobalLeaderboardService.buildCatalogueFilters`
        // alias-folded, so the SAME chip returned different games depending on
        // which surface asked. Both now resolve through `catalogueMatchTokens`,
        // which additionally answers a request in either vocabulary — a legacy
        // id from a stale client and the engine id from a current one both find
        // the row, whichever era it was written in.
        let filtered = rows;
        if (options?.platforms?.length) {
            const tokens = new Set<string>();
            for (const p of options.platforms) {
                for (const t of catalogueMatchTokens(p)) tokens.add(t);
            }
            filtered = rows.filter(g => {
                const gamePlatforms: string[] = JSON.parse(g.platforms || '[]');
                return gamePlatforms.some(p => tokens.has(String(p).trim().toLowerCase()));
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
        // Filter by "is this game in source X" rather than "where was it first imported from".
        // A game can exist in multiple sources (e.g. a VPS entry enriched with an OPDB ID),
        // so we filter by the presence of that source's external ID / marker.
        applySourceFilter(options?.source, conditions, params);

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
        // Fold the admin PUT the same way an import is folded, so an edit form
        // rendering legacy ids (or a stale tab) upgrades the row instead of
        // reverting it. Only when `platforms` is actually part of the payload —
        // `update` is a PARTIAL, so an absent field must stay absent or the
        // `f in fields` writers below would overwrite a column nobody touched.
        //
        // Features specifically: the fold can produce them from platforms, but
        // this payload may not carry `features` at all, and writing only the
        // derived ones would wipe the row's cabinet variants. So they are
        // union-merged onto whatever the row (or the payload) already has, and
        // the key is only introduced when the fold actually derived something.
        if ('platforms' in fields) {
            const fold = foldCataloguePlatforms(fields.platforms ?? []);
            const next: Partial<GlobalGameInput> = {
                ...fields,
                platforms: [...fold.engines, ...fold.dropped],
            };
            if (fold.features.length > 0) {
                let base = fields.features;
                if (!base) {
                    const row = await db.get('SELECT features FROM global_games WHERE id = ?', id);
                    try {
                        const parsed = JSON.parse(row?.features || '[]');
                        base = Array.isArray(parsed) ? parsed.filter((v: unknown) => typeof v === 'string') : [];
                    } catch { base = []; }
                }
                next.features = [...new Set([
                    ...base.map(v => String(v).trim().toLowerCase()).filter(Boolean),
                    ...fold.features,
                ])];
            }
            fields = next;
        }
        const sets: string[] = [];
        const params: any[] = [];

        const stringFields = ['name', 'display_name', 'manufacturer', 'type', 'subtype',
            'image_url', 'local_image_path', 'wheel_image_path',
            'opdb_id', 'vps_id', 'ipdb_url', 'external_url', 'studio',
            'description', 'status', 'submitted_by', 'reviewed_by',
            'imported_from', 'source_updated_at'] as const;

        for (const f of stringFields) {
            if (f in fields) {
                sets.push(`${f} = ?`);
                params.push((fields as any)[f] ?? null);
            }
        }
        // migration 130: an admin rename moves the row's dedup key with it.
        // Without this the index would keep pointing the row at its old name
        // and step-4 dedup would match the renamed row on a name it no longer
        // has. Only written when `name` is actually part of this partial.
        if ('name' in fields) {
            sets.push('normalized_name = ?');
            params.push(normalizeGameName(fields.name || ''));
        }
        if ('year' in fields) { sets.push('year = ?'); params.push(fields.year ?? null); }
        if ('igdb_id' in fields) { sets.push('igdb_id = ?'); params.push(fields.igdb_id ?? null); }
        if ('atgames_id' in fields) { sets.push('atgames_id = ?'); params.push(fields.atgames_id ?? null); }
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

        // v2.25.0: admin/manual edits stamp 'manual' — but only on fields whose
        // value actually CHANGES. A full-object PUT (standard edit-form shape)
        // must not wipe upstream attribution on fields the admin never touched;
        // an explicit clear (null over a value) IS a change, still stamped.
        const current = await db.get<Record<string, unknown> & { field_sources: string | null }>(
            `SELECT field_sources, name, display_name, manufacturer, year, subtype, players,
                    description, platforms, themes, designers,
                    image_url, local_image_path, wheel_image_path
               FROM global_games WHERE id = ?`,
            id,
        );
        const changed: Partial<GlobalGameInput> = {};
        if (current) {
            const scalarKeys = ['name', 'display_name', 'manufacturer', 'year', 'subtype', 'players', 'description',
                'image_url', 'local_image_path', 'wheel_image_path'] as const;
            for (const k of scalarKeys) {
                if (k in fields && ((fields as Record<string, unknown>)[k] ?? null) !== (current[k] ?? null)) {
                    (changed as Record<string, unknown>)[k] = (fields as Record<string, unknown>)[k] ?? null;
                }
            }
            const arrayKeys = ['platforms', 'themes', 'designers'] as const;
            for (const k of arrayKeys) {
                if (k in fields && JSON.stringify((fields as Record<string, unknown>)[k] || []) !== (current[k] || '[]')) {
                    (changed as Record<string, unknown>)[k] = (fields as Record<string, unknown>)[k];
                }
            }
        }
        sets.push('field_sources = ?');
        params.push(stampFieldSources(current?.field_sources, changed, { presenceBased: true }));
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

        // v2.25.0: the background image pass knows its source — stamp artwork.
        sets.push(`field_sources = json_set(COALESCE(field_sources, '{}'), '$.artwork', ?)`);
        params.push(source);

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

        // v2.25.0: only the Wizard importer keys by external_url — stamp
        // artwork, but ONLY when this call actually writes it: the local/wheel
        // paths always overwrite, while image_url is COALESCE-kept (existing
        // wins), so an image_url-only call stamps only when the row had none.
        if (fields.local_image_path !== undefined || fields.wheel_image_path !== undefined) {
            sets.push(`field_sources = json_set(COALESCE(field_sources, '{}'), '$.artwork', 'wizard')`);
        } else if (fields.image_url !== undefined) {
            sets.push(`field_sources = CASE WHEN image_url IS NULL
                THEN json_set(COALESCE(field_sources, '{}'), '$.artwork', 'wizard')
                ELSE field_sources END`);
        }

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

                    // `atgames_id` must survive the merge or the next AtGames
                    // sync re-INSERTS the row it just absorbed: the id would no
                    // longer resolve to anything, dropping that import back to
                    // name matching — the failure this arc removes.
                    //
                    // It carries a partial UNIQUE index, and the target UPDATE
                    // below runs while the source row still exists, so the id
                    // has to be released from the source FIRST. The other
                    // external ids need no such step (none of them is UNIQUE).
                    if (!target.atgames_id && source.atgames_id) {
                        await db.run('UPDATE global_games SET atgames_id = NULL WHERE id = ?', sourceId);
                        updates.push('atgames_id = ?');
                        updateParams.push(source.atgames_id);
                    }
                    if (!target.studio && source.studio) { updates.push('studio = ?'); updateParams.push(source.studio); }

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

                    // The source's NAME becomes an alias on the survivor.
                    //
                    // Without this a merge is undone by the next import: the
                    // source row's spelling no longer exists anywhere, so an
                    // importer using it matches nothing and INSERTS the
                    // duplicate straight back. That is precisely what would
                    // have happened to the Zaccaria/AtGames repair — 84 rows
                    // recreated on the next Steam sync — and to
                    // "JunkYard"/"Junk Yard" on the next AtGames sync.
                    //
                    // Only recorded when it differs from the survivor's own
                    // name AND from its existing aliases, both compared on the
                    // NORMALIZED form: an alias that normalizes to the name is
                    // dead weight, since `findByAlias` is only consulted after
                    // the name walk has already come up empty.
                    const existingAliases: string[] = (() => {
                        try {
                            const parsed = JSON.parse(target.dedup_aliases || '[]');
                            return Array.isArray(parsed) ? parsed.filter(a => typeof a === 'string') : [];
                        } catch {
                            return [];
                        }
                    })();
                    const targetKey = normalizeGameName(target.name);
                    const sourceKey = normalizeGameName(source.name);
                    const alreadyKnown = sourceKey === targetKey
                        || existingAliases.some(a => normalizeGameName(a) === sourceKey);
                    if (source.name && sourceKey && !alreadyKnown) {
                        updates.push('dedup_aliases = ?');
                        updateParams.push(JSON.stringify([...existingAliases, source.name]));
                    }

                    // v2.12.0: when source has an external_url that target
                    // doesn't already have (different URL, and not already in
                    // target's table_download_urls), fold it into target's
                    // table_download_urls as a labeled entry. Without this,
                    // a vpx + vpxs_manual merge dropped the wizard GitHub
                    // link entirely because target's external_url was the
                    // VPS database URL.
                    const labelForSource = (s: GlobalGame): string => s.imported_from || 'merged';
                    const sourceDownloads: Array<{ format?: string; url: string; version?: string }> =
                        source.table_download_urls ? JSON.parse(source.table_download_urls) : [];
                    if (
                        source.external_url &&
                        target.external_url &&
                        source.external_url !== target.external_url &&
                        !sourceDownloads.some(d => d.url === source.external_url)
                    ) {
                        sourceDownloads.push({ format: labelForSource(source), url: source.external_url });
                    }

                    // Object arrays — append source items whose .url isn't
                    // already on target. Idempotent: re-merging the same pair
                    // doesn't accumulate duplicates.
                    const appendByUrl = (a: string | null | undefined, items: Array<{ url?: string }>): string | null => {
                        const ax: Array<{ url?: string }> = a ? JSON.parse(a) : [];
                        const seen = new Set(ax.map(x => x.url).filter(Boolean));
                        const merged = [...ax];
                        for (const item of items) {
                            if (item.url && !seen.has(item.url)) { merged.push(item); seen.add(item.url); }
                            else if (!item.url) merged.push(item);
                        }
                        return merged.length > 0 ? JSON.stringify(merged) : null;
                    };
                    const sourceTutorials: Array<{ url?: string }> = source.tutorial_urls ? JSON.parse(source.tutorial_urls) : [];
                    const sourceRules: Array<{ url?: string }> = source.rules_urls ? JSON.parse(source.rules_urls) : [];
                    updates.push('table_download_urls = ?'); updateParams.push(appendByUrl(target.table_download_urls, sourceDownloads));
                    updates.push('tutorial_urls = ?');       updateParams.push(appendByUrl(target.tutorial_urls, sourceTutorials));
                    updates.push('rules_urls = ?');          updateParams.push(appendByUrl(target.rules_urls, sourceRules));

                    // v2.12.0: track absorbed sources. Carry forward target's
                    // existing merged_from_sources, plus source's own
                    // merged_from_sources (it may itself have absorbed others
                    // before this merge), plus source's imported_from when it
                    // differs from target's. Excludes target's imported_from
                    // (that's the base).
                    const targetMergedSources: string[] = JSON.parse(target.merged_from_sources || '[]');
                    const sourceMergedSources: string[] = JSON.parse(source.merged_from_sources || '[]');
                    const mergedSourcesSet = new Set([...targetMergedSources, ...sourceMergedSources]);
                    if (source.imported_from && source.imported_from !== target.imported_from) {
                        mergedSourcesSet.add(source.imported_from);
                    }
                    updates.push('merged_from_sources = ?');
                    updateParams.push(JSON.stringify([...mergedSourcesSet]));

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
        // FK enforcement (S3): global_game_ratings/comments cascade, but
        // global_scores.global_game_id is NOT NULL + NO ACTION (can't unlink) and
        // global_leaderboard_cache has no declared FK — remove both before the
        // parent. Hard delete is destructive by design; use merge() to preserve
        // scores. One transaction.
        await db.exec('BEGIN');
        try {
            await db.run('DELETE FROM global_scores WHERE global_game_id = ?', id);
            await db.run('DELETE FROM global_leaderboard_cache WHERE global_game_id = ?', id);
            const result = await db.run('DELETE FROM global_games WHERE id = ?', id);
            await db.exec('COMMIT');
            return (result.changes ?? 0) > 0;
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
    }

    /**
     * v2.13.0: bulk-merge IPDB-shared duplicate pinball rows.
     *
     * Same IPDB ID across two rows means the same physical machine. The
     * tool merges only the safe cases: same IPDB + same year + compatible
     * manufacturers (same after stripping company-name suffixes like
     * "Electronics", "& Co", "Industries", "do Brasil", and collapsing
     * spaces/punctuation). Skips groups with year disagreements,
     * incompatible manufacturers, or community/digital markers (a row
     * tagged manufacturer="Original" or containing "Zen Studios" / "JP's"
     * is almost certainly a fan recreation that shouldn't merge with the
     * physical machine).
     *
     * Picks the richest row (most external IDs, oldest created_at as
     * tiebreak) as merge target so iScored sync hooks survive. Each merge
     * runs through the existing merge primitive — data unioned, FK refs
     * cascaded.
     */
    static async mergeIpdbDuplicates(opts?: { dryRun?: boolean }): Promise<{
        totalDupGroups: number;
        merged: number;
        skipped: number;
        log: Array<{
            ipdb: string;
            action: 'merged' | 'skipped';
            reason?: string;
            targetId?: string;
            sourceIds?: string[];
            rows: Array<{ id: string; name: string; manufacturer: string | null; year: number | null; imported_from: string | null }>;
        }>;
    }> {
        const db = await getDatabase();
        const dryRun = opts?.dryRun ?? false;

        const allRows = await db.all<Array<{
            id: string;
            name: string;
            manufacturer: string | null;
            year: number | null;
            ipdb_url: string;
            vps_id: string | null;
            opdb_id: string | null;
            igdb_id: number | null;
            imported_from: string | null;
            created_at: string | null;
        }>>(
            `SELECT id, name, manufacturer, year, ipdb_url, vps_id, opdb_id, igdb_id, imported_from, created_at
             FROM global_games WHERE ipdb_url IS NOT NULL AND type = 'pinball'`
        );

        const groups = new Map<string, typeof allRows>();
        for (const r of allRows) {
            const m = (r.ipdb_url || '').match(/id=(\d+)/i);
            if (!m) continue;
            const k = m[1]!;
            if (!groups.has(k)) groups.set(k, []);
            groups.get(k)!.push(r);
        }

        const dups = [...groups.entries()].filter(([, gs]) => gs.length > 1);

        const log: Awaited<ReturnType<typeof GlobalGameService.mergeIpdbDuplicates>>['log'] = [];
        let merged = 0;
        let skipped = 0;

        const summarize = (r: typeof allRows[number]) => ({
            id: r.id,
            name: r.name,
            manufacturer: r.manufacturer,
            year: r.year,
            imported_from: r.imported_from,
        });

        for (const [ipdb, gs] of dups) {
            const rowSummaries = gs.map(summarize);

            // Problematic: any row tagged as a fan/digital recreation.
            const isProblematicRow = (r: typeof allRows[number]): boolean => {
                const mfg = (r.manufacturer || '').toLowerCase();
                const name = (r.name || '').toLowerCase();
                if (mfg === 'original') return true;
                if (mfg.includes('zen studios')) return true;
                // v2.21.3: a "JP's …" name is only a fan-table marker when the
                // manufacturer is ALSO virtual-only/missing. JPSalas's faithful
                // recreations of real machines carry the real manufacturer +
                // year (e.g. "JP's The Lord of the Rings (Stern, 2003)") and
                // are the same machine — the 2026-07-13 prod bulk-merge run
                // skipped 7 such groups that should merge. Fan originals like
                // "JP's Cyclone (Original, 2022)" still trip the mfg checks
                // above.
                if (name.startsWith("jp's") && isVirtualOnlyManufacturer(r.manufacturer)) return true;
                return false;
            };
            if (gs.some(isProblematicRow)) {
                log.push({ ipdb, action: 'skipped', reason: 'community-or-digital', rows: rowSummaries });
                skipped++;
                continue;
            }

            // Year must match exactly across all rows in the group.
            const years = new Set(gs.map(r => r.year));
            if (years.size > 1) {
                log.push({ ipdb, action: 'skipped', reason: 'year-disagreement', rows: rowSummaries });
                skipped++;
                continue;
            }

            // Manufacturer compatibility via normalize-and-compare. Strips
            // common company suffixes/punctuation/whitespace; equal forms
            // are treated as the same company.
            const norm = (m: string | null): string => {
                if (!m) return '';
                let n = m.toLowerCase().trim();
                n = n.replace(/[',.\-&\/’]/g, '');
                n = n.replace(/\s+/g, '');
                // Iterate: strip suffix, repeat in case of compound suffixes.
                const SUFFIX_RE = /(electronics|industries|incorporated|inc|company|corporation|corp|llc|ltd|games?|dobrasil|brasil|gmbh|ag)$/;
                let prev = '';
                while (prev !== n) {
                    prev = n;
                    n = n.replace(SUFFIX_RE, '');
                }
                // v2.21.3: curated corporate-alias map — the same physical-
                // machine maker under a renamed/rebranded/parent-group label.
                // Keyed and valued in NORMALIZED form (post-suffix-strip).
                // Sourced from the 2026-07-13 prod bulk-merge skip list; each
                // pair was human-verified as one company (renames: Bell→Nuova
                // Bell, Allied Leisure→Fascination; trade names: Segasa=Sonic,
                // Cirsa group=Unidesa; spelling variants: MAC, Alvin G,
                // Jocmatic/Joctronic, International Concepts).
                const MFG_ALIASES: Record<string, string> = {
                    'segasa': 'sonic',
                    'nuovabell': 'bell',
                    'alvingco': 'alving',
                    'maguinasmacpinball': 'mac',
                    'macpinball': 'mac',
                    'internationalconcepts': 'international',
                    'fascination': 'alliedleisure',
                    'fascinationint': 'alliedleisure',
                    'fascinationinternational': 'alliedleisure',
                    'unidesa': 'cirsa',
                    'joctronic': 'jocmatic',
                    'spinballsal': 'spinball',
                };
                return MFG_ALIASES[n] ?? n;
            };
            const normalizedMfgs = new Set(gs.map(r => norm(r.manufacturer)));
            if (normalizedMfgs.size > 1 || (normalizedMfgs.size === 1 && [...normalizedMfgs][0] === '')) {
                log.push({ ipdb, action: 'skipped', reason: 'manufacturer-incompatible', rows: rowSummaries });
                skipped++;
                continue;
            }

            // Pick richest row as target.
            const richness = (r: typeof allRows[number]) =>
                (r.vps_id ? 1 : 0) + (r.opdb_id ? 1 : 0) + (r.igdb_id ? 1 : 0);
            const sorted = [...gs].sort((a, b) => {
                const dr = richness(b) - richness(a);
                if (dr !== 0) return dr;
                return (a.created_at || '').localeCompare(b.created_at || '');
            });
            const target = sorted[0]!;
            const sources = sorted.slice(1);

            if (dryRun) {
                log.push({
                    ipdb, action: 'merged',
                    targetId: target.id, sourceIds: sources.map(s => s.id),
                    rows: rowSummaries,
                });
                merged++;
                continue;
            }

            let mergeFailed: string | null = null;
            for (const src of sources) {
                try {
                    await GlobalGameService.merge(target.id, src.id);
                } catch (e: unknown) {
                    const err = e as { message?: string };
                    mergeFailed = err?.message || 'unknown';
                    break;
                }
            }
            if (mergeFailed) {
                log.push({
                    ipdb, action: 'skipped', reason: `merge-failed: ${mergeFailed}`,
                    targetId: target.id, sourceIds: sources.map(s => s.id),
                    rows: rowSummaries,
                });
                skipped++;
            } else {
                log.push({
                    ipdb, action: 'merged',
                    targetId: target.id, sourceIds: sources.map(s => s.id),
                    rows: rowSummaries,
                });
                merged++;
            }
        }

        return {
            totalDupGroups: dups.length,
            merged,
            skipped,
            log,
        };
    }
}
