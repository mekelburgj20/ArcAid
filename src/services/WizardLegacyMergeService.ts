import { getDatabase } from '../database/database.js';
import { GlobalGameService, isVirtualOnlyManufacturer } from './GlobalGameService.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { frontFormOf } from '../utils/sortFormName.js';
import { isReadmeEraWizardRow, wizardFolderSlugs } from '../utils/wizardLegacy.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * C14 (v2.257.0) — fold the README-era Wizard rows into the rows they copy.
 *
 * `isReadmeEraWizardRow` defines the set (255 public rows on 2026-11-21, ~225
 * from the README's old manual-install list). Owner ruling 2026-11-21: they
 * are ordinary VPX tables that belong on their VPS rows, so each is MERGED
 * through `GlobalGameService.merge` (scores, ratings, room links, My Tables
 * move; the README's file facts and dead links stay behind). Never deleted.
 *
 * The preview PROPOSES a survivor per row and the owner decides: it pre-ticks
 * only the pairs nothing argues against, and the page lets any row be pointed
 * at any catalogue row. Evidence, strongest first:
 *
 *  1. `folder` — the row's Wizard install folder (from its README link) is in
 *     today's manifest, which names its VPS game (`wizard_table_slugs`). This
 *     is LU's own identity, the same one cabinet plays resolve through (W110).
 *  2. `name`   — the same `normalizeGameName`, the README's sort form ("X,
 *     The" / "X, JP's") turned to the front first (`frontFormOf`).
 *  3. `maker_year` — same maker and year, and one name contains the other once
 *     the README's decorations ("- JP", "Sound Mod", "Version B", "LE") are
 *     squashed away.
 *
 * Nothing about a pairing is trusted blindly: a maker or year disagreement is
 * shown and blocks the pre-tick, and ADR 0014's rule (a fan original is never
 * the same game as a real machine) is shown as a conflict that is never
 * pre-ticked. The owner can still tick it: the ADR governs automatic dedup,
 * and this is the human adjudication it leaves room for.
 */

export interface OldWizardTarget {
    id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    vps_id: string | null;
    /**
     * C19 (v2.258.0) — the Table Manager folders LU's Wizard installs for this
     * game today (`wizard_table_slugs` on its VPS id); empty when the Wizard
     * does not offer it. The page shows it as "On the Wizard".
     */
    wizardFolders: string[];
}

export type OldWizardTier = 'folder' | 'name' | 'maker_year';

export interface OldWizardRowPlan {
    id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    status: string;
    /** The Wizard install folder the row's README link names, when it has one. */
    folder: string | null;
    counts: {
        /** `global_scores` rows (any state) and the distinct players behind them. */
        globalScores: number;
        globalPlayers: number;
        ratings: number;
        comments: number;
        myTables: number;
        pins: number;
        /** Room game rows linked by id or carrying the row's exact name. */
        roomGames: number;
        activeRoomGames: number;
    };
    suggestion: {
        target: OldWizardTarget;
        tier: OldWizardTier;
        /** Plain-language reasons the two rows disagree ('maker', 'year'). */
        disagreements: string[];
        /** ADR 0014: a fan original paired with a real machine. */
        conflict: string | null;
    } | null;
    /** Several equally good candidates: the owner picks (or searches). */
    alternatives: OldWizardTarget[];
    preselect: boolean;
}

export interface OldWizardPreview {
    rows: OldWizardRowPlan[];
    summary: { total: number; suggested: number; preselected: number; ambiguous: number; none: number };
}

export interface OldWizardMergeResult {
    merged: Array<{ sourceId: string; targetId: string; scoresMoved: number }>;
    failed: Array<{ sourceId: string; targetId: string; error: string }>;
}

export class OldWizardMergeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OldWizardMergeError';
    }
}

/** The most pairs one request may merge (the whole set is ~255). */
export const MAX_PAIRS_PER_MERGE = 500;

interface CatalogueRow {
    id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    status: string;
    type: string;
    vps_id: string | null;
    imported_from: string | null;
    external_url: string | null;
    image_url: string | null;
    table_download_urls: string | null;
}

/**
 * A maker reduced to what tells two spellings of one company apart from two
 * companies: "Alvin G." = "Alvin G", "Sport matic" = "Sportmatic",
 * "Bally Manufacturing" = "Bally". Corporate renames (Premier = Gottlieb) are
 * NOT folded; they show as a disagreement for the owner to judge.
 */
export function makerKey(maker: string | null | undefined): string {
    return String(maker ?? '').toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .replace(/(?:electronics|industries|manufacturing|games|inc|co)$/g, '');
}

/** The README's decorations, removed before the containment test. */
const DECORATION = /\b(?:jp'?s?|jpsalas|mod|sound|soundfx|edition|le|limited|remix|reskin|version|v\d[\d.]*|pro|premium|original|vpw|vpx8?|flexdmd|definitive|the|a|an)\b/g;

/** A name squashed for the maker+year tier's containment test. */
export function squashedName(name: string | null | undefined): string {
    return String(name ?? '').toLowerCase()
        .replace(/\([^)]*\)/g, ' ')
        .replace(/['’]/g, '')
        .replace(DECORATION, ' ')
        .replace(/[^a-z0-9]/g, '');
}

/** The name key the `name` tier compares, sort form turned to the front. */
export function nameKey(name: string): string {
    return normalizeGameName(frontFormOf(name) ?? name);
}

type FoldersByVps = Map<string, string[]>;

function toTarget(r: CatalogueRow, foldersByVps: FoldersByVps): OldWizardTarget {
    return {
        id: r.id, name: r.name, manufacturer: r.manufacturer, year: r.year, vps_id: r.vps_id,
        wizardFolders: (r.vps_id && foldersByVps.get(r.vps_id)) || [],
    };
}

/** `wizard_table_slugs` grouped by VPS game: which games the Wizard installs. */
function groupFolders(slugRows: Array<{ slug: string; vps_id: string }>): FoldersByVps {
    const out: FoldersByVps = new Map();
    for (const s of slugRows) (out.get(s.vps_id) ?? out.set(s.vps_id, []).get(s.vps_id)!).push(s.slug);
    for (const list of out.values()) list.sort();
    return out;
}

async function readSlugRows(): Promise<Array<{ slug: string; vps_id: string }>> {
    const db = await getDatabase();
    return db.all<Array<{ slug: string; vps_id: string }>>(
        `SELECT slug, vps_id FROM wizard_table_slugs`,
    ).catch(() => [] as Array<{ slug: string; vps_id: string }>);
}

/** Maker / year disagreement between an old row and a proposed survivor. */
export function disagreementsOf(
    source: { manufacturer: string | null; year: number | null },
    target: { manufacturer: string | null; year: number | null },
): string[] {
    const out: string[] = [];
    const sm = makerKey(source.manufacturer);
    const tm = makerKey(target.manufacturer);
    if (sm && tm && sm !== tm) out.push('maker');
    if (source.year && target.year && source.year !== target.year) out.push('year');
    return out;
}

/**
 * ADR 0014: a VIRTUAL-only maker ("Original", "Zen Studios") and a real one
 * are different games. Only an explicit virtual maker counts on the old row:
 * a missing one, or a mod author's name ("Balutito MOD", "TBA"), is the
 * README's noise, not a claim.
 */
export function adr0014Conflict(
    source: { manufacturer: string | null },
    target: { manufacturer: string | null },
): string | null {
    const sourceMaker = (source.manufacturer ?? '').trim();
    const targetMaker = (target.manufacturer ?? '').trim();
    if (!sourceMaker || !targetMaker) return null;
    if (isVirtualOnlyManufacturer(sourceMaker) && !isVirtualOnlyManufacturer(targetMaker)) {
        return `A fan original (${sourceMaker}) and a real machine (${targetMaker}) are different games (ADR 0014)`;
    }
    return null;
}

export class WizardLegacyMergeService {
    /** Every README-era row with a proposed survivor. Changes nothing. */
    static async preview(): Promise<OldWizardPreview> {
        const db = await getDatabase();
        const all = await db.all<CatalogueRow[]>(
            `SELECT id, name, manufacturer, year, status, type, vps_id, imported_from,
                    external_url, image_url, table_download_urls
               FROM global_games WHERE imported_from = 'wizard' OR vps_id IS NOT NULL`,
        );
        const old = all.filter(r => isReadmeEraWizardRow(r));
        // Survivors are approved VPS pinball rows. (The page's search can
        // point a row at any approved non-README pinball row; `merge`
        // re-checks.)
        const pool = all.filter(r => r.vps_id && r.status === 'approved' && r.type === 'pinball' && !isReadmeEraWizardRow(r));

        const byVps = new Map<string, CatalogueRow[]>();
        const byKey = new Map<string, CatalogueRow[]>();
        const squashedPool = pool.map(r => ({ r, squashed: squashedName(r.name), maker: makerKey(r.manufacturer) }));
        for (const r of pool) {
            const vps = r.vps_id as string;
            (byVps.get(vps) ?? byVps.set(vps, []).get(vps)!).push(r);
            const k = nameKey(r.name);
            if (k) (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
        }

        const slugRows = await readSlugRows();
        const slugToVps = new Map(slugRows.map(s => [s.slug.toLowerCase(), s.vps_id]));
        const foldersByVps = groupFolders(slugRows);
        const target = (r: CatalogueRow) => toTarget(r, foldersByVps);

        const counts = await WizardLegacyMergeService.countsFor(old);

        const rows: OldWizardRowPlan[] = old.map(row => {
            const slugs = wizardFolderSlugs(row);
            const plan: OldWizardRowPlan = {
                id: row.id,
                name: row.name,
                manufacturer: row.manufacturer,
                year: row.year,
                status: row.status,
                folder: slugs[0] ?? null,
                counts: counts.get(row.id) ?? WizardLegacyMergeService.zeroCounts(),
                suggestion: null,
                alternatives: [],
                preselect: false,
            };

            const pick = (cands: CatalogueRow[], tier: OldWizardTier): boolean => {
                const unique = [...new Map(cands.filter(c => c.id !== row.id).map(c => [c.id, c])).values()];
                if (unique.length === 0) return false;
                const agreeing = unique.filter(c => disagreementsOf(row, c).length === 0);
                const chosen = unique.length === 1 ? unique[0] : agreeing.length === 1 ? agreeing[0] : null;
                if (!chosen) {
                    plan.alternatives = unique.map(target);
                    return true;
                }
                plan.suggestion = {
                    target: target(chosen),
                    tier,
                    disagreements: disagreementsOf(row, chosen),
                    conflict: adr0014Conflict(row, chosen),
                };
                return true;
            };

            const folderCands = slugs
                .map(s => slugToVps.get(s))
                .filter((v): v is string => !!v)
                .flatMap(v => byVps.get(v) ?? []);
            if (!pick(folderCands, 'folder')) {
                const key = nameKey(row.name);
                if (!(key && pick(byKey.get(key) ?? [], 'name'))) {
                    const squashed = squashedName(row.name);
                    const maker = makerKey(row.manufacturer);
                    if (squashed.length >= 4 && maker && row.year) {
                        pick(squashedPool
                            .filter(c => c.r.year === row.year && c.maker === maker && c.squashed.length >= 4
                                && (c.squashed.includes(squashed) || squashed.includes(c.squashed)))
                            .map(c => c.r), 'maker_year');
                    }
                }
            }

            const s = plan.suggestion;
            plan.preselect = !!s && !s.conflict && s.disagreements.length === 0
                && (s.tier === 'folder' || (s.tier === 'name' && !!row.manufacturer && !!row.year));
            return plan;
        });

        rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
        return {
            rows,
            summary: {
                total: rows.length,
                suggested: rows.filter(r => r.suggestion).length,
                preselected: rows.filter(r => r.preselect).length,
                ambiguous: rows.filter(r => !r.suggestion && r.alternatives.length > 0).length,
                none: rows.filter(r => !r.suggestion && r.alternatives.length === 0).length,
            },
        };
    }

    /**
     * Approved catalogue rows a README-era row may merge into, by name. Never a
     * README-era row (that would only move the problem); VPS rows first.
     */
    static async searchTargets(q: string, limit = 15): Promise<OldWizardTarget[]> {
        const term = (q || '').trim();
        if (term.length < 2) return [];
        const db = await getDatabase();
        const rows = await db.all<CatalogueRow[]>(
            `SELECT id, name, manufacturer, year, status, type, vps_id, imported_from,
                    external_url, image_url, table_download_urls
               FROM global_games
              WHERE status = 'approved' AND type = 'pinball' AND name LIKE ? COLLATE NOCASE
              ORDER BY (vps_id IS NULL), LENGTH(name), name
              LIMIT ?`,
            `%${term}%`, limit * 3,
        );
        const foldersByVps = groupFolders(await readSlugRows());
        return rows.filter(r => !isReadmeEraWizardRow(r)).slice(0, limit).map(r => toTarget(r, foldersByVps));
    }

    /**
     * Merges each (README-era row → survivor) pair the owner ticked, one
     * `GlobalGameService.merge` transaction per pair, so one failure leaves
     * the others merged. The whole batch is refused before anything runs when
     * a pair is malformed: an old row named twice, or a survivor that is
     * itself being merged away in the same batch.
     */
    static async merge(pairs: Array<{ sourceId: string; targetId: string }>): Promise<OldWizardMergeResult> {
        if (!Array.isArray(pairs) || pairs.length === 0) throw new OldWizardMergeError('Pick at least one row to merge');
        if (pairs.length > MAX_PAIRS_PER_MERGE) throw new OldWizardMergeError(`At most ${MAX_PAIRS_PER_MERGE} rows per merge`);
        const sources = new Set<string>();
        for (const p of pairs) {
            if (!p || typeof p.sourceId !== 'string' || typeof p.targetId !== 'string' || !p.sourceId || !p.targetId) {
                throw new OldWizardMergeError('Each pair needs a sourceId and a targetId');
            }
            if (p.sourceId === p.targetId) throw new OldWizardMergeError('A row cannot merge into itself');
            if (sources.has(p.sourceId)) throw new OldWizardMergeError('A row is listed twice');
            sources.add(p.sourceId);
        }
        if (pairs.some(p => sources.has(p.targetId))) {
            throw new OldWizardMergeError('A survivor is itself being merged away in this batch');
        }

        const db = await getDatabase();
        const result: OldWizardMergeResult = { merged: [], failed: [] };
        for (const { sourceId, targetId } of pairs) {
            try {
                const source = await db.get<CatalogueRow>(`SELECT * FROM global_games WHERE id = ?`, sourceId);
                if (!source) throw new Error('The old row is gone (already merged?)');
                if (!isReadmeEraWizardRow(source)) throw new Error('Not an old README Wizard row');
                const target = await db.get<CatalogueRow>(`SELECT * FROM global_games WHERE id = ?`, targetId);
                if (!target) throw new Error('The survivor was not found');
                if (target.status !== 'approved') throw new Error('The survivor is not approved');
                if (isReadmeEraWizardRow(target)) throw new Error('The survivor is itself an old README Wizard row');
                if (target.type !== source.type) throw new Error(`The survivor is a ${target.type} game, the old row a ${source.type} one`);
                const { scoresMoved } = await GlobalGameService.merge(targetId, sourceId);
                result.merged.push({ sourceId, targetId, scoresMoved });
            } catch (err) {
                const error = err instanceof Error ? err.message : String(err);
                logWarn(`Old Wizard merge ${sourceId} -> ${targetId} refused: ${error}`);
                result.failed.push({ sourceId, targetId, error });
            }
        }
        logInfo(`Old Wizard rows: ${result.merged.length} merged, ${result.failed.length} failed`);
        return result;
    }

    private static zeroCounts(): OldWizardRowPlan['counts'] {
        return { globalScores: 0, globalPlayers: 0, ratings: 0, comments: 0, myTables: 0, pins: 0, roomGames: 0, activeRoomGames: 0 };
    }

    /** What each row holds, in one grouped query per table. */
    private static async countsFor(rows: CatalogueRow[]): Promise<Map<string, OldWizardRowPlan['counts']>> {
        const out = new Map<string, OldWizardRowPlan['counts']>();
        if (rows.length === 0) return out;
        const db = await getDatabase();
        for (const r of rows) out.set(r.id, WizardLegacyMergeService.zeroCounts());
        const ids = rows.map(r => r.id);
        const marks = ids.map(() => '?').join(',');

        const grouped = async (sql: string, apply: (c: OldWizardRowPlan['counts'], row: { id: string; n: number; m?: number }) => void) => {
            const res = await db.all<Array<{ id: string; n: number; m?: number }>>(sql, ...ids);
            for (const row of res) {
                const c = out.get(row.id);
                if (c) apply(c, row);
            }
        };
        await grouped(
            `SELECT global_game_id AS id, COUNT(*) AS n, COUNT(DISTINCT player_id) AS m
               FROM global_scores WHERE global_game_id IN (${marks}) GROUP BY global_game_id`,
            (c, r) => { c.globalScores = r.n; c.globalPlayers = r.m ?? 0; },
        );
        await grouped(
            `SELECT global_game_id AS id, COUNT(*) AS n FROM global_game_ratings
              WHERE global_game_id IN (${marks}) GROUP BY global_game_id`,
            (c, r) => { c.ratings = r.n; },
        );
        await grouped(
            `SELECT global_game_id AS id, COUNT(*) AS n FROM global_game_comments
              WHERE global_game_id IN (${marks}) GROUP BY global_game_id`,
            (c, r) => { c.comments = r.n; },
        );
        await grouped(
            `SELECT global_game_id AS id, COUNT(DISTINCT user_id) AS n FROM player_tables
              WHERE global_game_id IN (${marks}) GROUP BY global_game_id`,
            (c, r) => { c.myTables = r.n; },
        );
        await grouped(
            `SELECT global_game_id AS id, COUNT(*) AS n FROM global_game_pins
              WHERE global_game_id IN (${marks}) GROUP BY global_game_id`,
            (c, r) => { c.pins = r.n; },
        );

        // Room games: linked by id, or under the row's exact name (room rows
        // are name-keyed; after the merge those names are off-catalogue and
        // Game Names renames them).
        const byName = new Map<string, string>();
        for (const r of rows) byName.set(r.name.toLowerCase(), r.id);
        const games = await db.all<Array<{ global_game_id: string | null; name: string; status: string }>>(
            `SELECT global_game_id, name, status FROM games
              WHERE global_game_id IN (${marks}) OR LOWER(name) IN (${ids.map(() => '?').join(',')})`,
            ...ids, ...rows.map(r => r.name.toLowerCase()),
        );
        for (const g of games) {
            const id = (g.global_game_id && out.has(g.global_game_id)) ? g.global_game_id : byName.get(g.name.toLowerCase());
            const c = id ? out.get(id) : undefined;
            if (!c) continue;
            c.roomGames++;
            if (g.status === 'ACTIVE') c.activeRoomGames++;
        }
        return out;
    }
}
