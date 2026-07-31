/**
 * The fidelity-category CASE expression, DERIVED from the TypeScript taxonomy
 * (ADR 0016 P4, v2.59.0).
 *
 * The Global Scoreboard now groups by `(game, fidelity category)`, which means
 * the category has to exist inside SQL. The tempting shortcut is to hand-write
 * `CASE WHEN engine IN ('vpx','vp9','fp') THEN 'simulation' …` in the query.
 * That would make the SQL a FOURTH copy of the taxonomy (after
 * `src/utils/scoreProvenance.ts`, its `admin-ui` mirror, and the tournament
 * rules) — and unlike the first two, a string inside a template literal is
 * invisible to the BE/FE parity test that already caught one real drift.
 *
 * So the expression is generated from `CANONICAL_ENGINES` at query-build time.
 * Add an engine to the taxonomy and the SQL follows on the next call, with no
 * second edit and no way for the two to disagree.
 *
 * ── On literals instead of bind parameters ──────────────────────────────────
 * The engine ids are interpolated as SQL string literals rather than bound.
 * That is safe here and deliberate: every value comes from a module-level
 * constant in this repository (never from a request), the expression is
 * reused verbatim in SELECT / GROUP BY / WHERE where threading a dozen
 * positional parameters through three different clause builders is its own
 * class of bug, and `assertSafeToken` below hard-fails on anything that isn't
 * `[a-z0-9_]+`. A typo'd or hostile id throws at build time instead of
 * reaching SQLite. Category ids the CALLER supplies (the chip filter) are
 * still bound as parameters — see `GlobalLeaderboardService`.
 */

import { CANONICAL_ENGINES, UNSPECIFIED_CATEGORY, type EngineCategory } from './scoreProvenance.js';

/**
 * Guard for anything interpolated into SQL. Throws rather than sanitising:
 * a taxonomy id that isn't a plain lowercase token is a programming error, and
 * quietly dropping it would silently mis-bucket every score on that engine.
 */
function assertSafeToken(token: string, what: string): string {
    if (!/^[a-z0-9_]+$/.test(token)) {
        throw new Error(`Unsafe ${what} for SQL interpolation: ${JSON.stringify(token)}`);
    }
    return token;
}

/** `'a','b','c'` — a quoted, guarded literal list. */
function literalList(tokens: string[], what: string): string {
    return tokens.map(t => `'${assertSafeToken(t, what)}'`).join(', ');
}

/** Engine ids grouped by the fidelity band the taxonomy assigns them. */
export function enginesByCategory(): Record<EngineCategory, string[]> {
    const out = { real: [], simulation: [], arcade_style: [], video: [] } as Record<EngineCategory, string[]>;
    for (const [id, info] of Object.entries(CANONICAL_ENGINES)) {
        out[info.category].push(id);
    }
    return out;
}

/**
 * Build the SQL expression that maps a score row to its card category.
 *
 * Three outcomes, and the difference between the last two is the whole point
 * of P4:
 *
 *   NULL            — there is no score row at all. Keyed on the row's own
 *                     primary key, NOT on `engine IS NULL`, so it means
 *                     exactly "the LEFT JOIN found nothing". That is what
 *                     makes a zero-score game fall out of the data as a single
 *                     uncategorised card instead of needing a special branch.
 *   a band id       — `real` / `simulation` / `arcade_style` / `video`.
 *   `'unspecified'` — a row exists but its engine is `'unknown'` (or anything
 *                     unrecognised). These MUST get a bucket: they are the
 *                     majority of production scores, and no bucket means no
 *                     card means the scores vanish from the site.
 *
 * @param engineColumn      qualified column holding the engine id, e.g. `gs.engine`
 * @param rowPresenceColumn qualified NOT NULL column of the same row, e.g. `gs.id`
 */
export function buildEngineCategoryExpr(engineColumn: string, rowPresenceColumn: string): string {
    const grouped = enginesByCategory();
    const branches = (Object.keys(grouped) as EngineCategory[])
        .filter(category => grouped[category].length > 0)
        .map(category =>
            `WHEN LOWER(TRIM(${engineColumn})) IN (${literalList(grouped[category], 'engine id')}) ` +
            `THEN '${assertSafeToken(category, 'category id')}'`)
        .join('\n                     ');

    return `CASE WHEN ${rowPresenceColumn} IS NULL THEN NULL
                     ${branches}
                     ELSE '${assertSafeToken(UNSPECIFIED_CATEGORY, 'category id')}' END`;
}
