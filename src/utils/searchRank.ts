/**
 * Search-relevance ranking (search-relevance work package, owner ask
 * 2026-08-13 — field report with the "Strike" example).
 *
 * Every search across the app should rank nearest-exact-match first. This is
 * the ONE tier scheme, shared by every site (SQL and JS alike):
 *
 *   Tier 0 — exact: `n === q`.
 *   Tier 1 — starts with the query as a full word: `n` begins with `q` AND
 *            the next character (if any) is not a letter/digit.
 *   Tier 2 — contains the query as a whole word: `q` occurs in `n` bounded on
 *            BOTH sides by a non-alphanumeric character (or a string edge).
 *   Tier 3 — substring inside a word: any other occurrence.
 *   Tier 4 — no name match at all (relevant only at multi-field sites that
 *            also match on e.g. manufacturer/alias/author — those rows still
 *            rank, just last).
 *
 * Within a tier, callers sort alphabetically (COLLATE NOCASE / localeCompare)
 * unless the site has its own documented secondary order.
 *
 * Mirrored (same tiers, same tests) at `admin-ui/src/lib/searchRank.ts` for
 * client-side sites. The two implementations are kept byte-similar by hand —
 * no parity test, they're small — so if you change one, change the other.
 */

/** True when `ch` is a non-alphanumeric boundary, or past the string edge. */
function isBoundary(ch: string | undefined): boolean {
    return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/**
 * Ranks `name` against `query` per the tier scheme above. Pure JS — used by
 * Discord autocompletes (small in-memory arrays, sorted before `.slice`).
 * Returns 0-4; lower is a closer match.
 */
export function rankName(name: string, query: string): number {
    const n = (name ?? '').trim().toLowerCase();
    const q = (query ?? '').trim().toLowerCase();
    if (!q) return 4;
    if (n === q) return 0;
    if (n.startsWith(q) && isBoundary(n[q.length])) return 1;

    // Tier 2: scan every occurrence — an early non-word-bounded hit ("Strikers")
    // must not shadow a later bounded one ("Strikers Strike").
    let idx = n.indexOf(q);
    while (idx !== -1) {
        const before = idx === 0 ? undefined : n[idx - 1];
        const after = n[idx + q.length];
        if (isBoundary(before) && isBoundary(after)) return 2;
        idx = n.indexOf(q, idx + 1);
    }

    if (n.includes(q)) return 3;
    return 4;
}

/** Escapes `%`, `_`, and `\` for a SQLite `LIKE ... ESCAPE '\'` pattern. */
function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

/**
 * Escapes GLOB metacharacters (`*`, `?`, `[`, `]`) by wrapping each in a
 * single-character bracket class, e.g. `*` -> `[*]`. SQLite's GLOB has no
 * ESCAPE clause, so this is the standard way to make literal user input safe
 * inside a hand-built GLOB pattern.
 */
function escapeGlob(s: string): string {
    return s.replace(/[*?[\]]/g, ch => `[${ch}]`);
}

/**
 * Emits a SQLite `CASE WHEN … THEN 0 … ELSE 4 END` fragment ranking
 * `nameExpr` (a raw SQL expression, e.g. a column name or `COALESCE(a, b)`)
 * against a query bound via `nameRankSqlParams` — same tier scheme as
 * `rankName`, same `?` param count (7) and order every time it's used, so
 * multiple call sites in one statement just concatenate more params.
 *
 * Word-boundary test: `SUBSTR(LOWER(nameExpr), LENGTH(?) + 1, 1) NOT GLOB
 * '[a-z0-9]'` for tier 1 (the character right after the prefix isn't
 * alphanumeric). Tier 2 needs the query bounded on both sides — handled as
 * three OR'd GLOB checks (query at the very start followed by a boundary,
 * query at the very end preceded by one, query in the middle bounded by
 * both) rather than one pattern, since GLOB has no alternation operator.
 * Negated classes use `[^a-z0-9]` — SQLite's GLOB follows the `^`
 * negation convention (POSIX bracket-expression style), NOT `[!...]`;
 * `!` has no special meaning inside a SQLite GLOB bracket class and was
 * caught by the SQL-side unit tests before this fix.
 */
export function nameRankSqlCase(nameExpr: string): string {
    return `CASE
        WHEN LOWER(${nameExpr}) = ? THEN 0
        WHEN LOWER(${nameExpr}) LIKE ? ESCAPE '\\' AND SUBSTR(LOWER(${nameExpr}), LENGTH(?) + 1, 1) NOT GLOB '[a-z0-9]' THEN 1
        WHEN (LOWER(${nameExpr}) GLOB ? OR LOWER(${nameExpr}) GLOB ? OR LOWER(${nameExpr}) GLOB ?) THEN 2
        WHEN LOWER(${nameExpr}) LIKE ? ESCAPE '\\' THEN 3
        ELSE 4
    END`;
}

/**
 * Params for one `nameRankSqlCase(...)` fragment, in placeholder order (7
 * values). `query` is trimmed and lowercased once here — callers must NOT
 * pre-lowercase it themselves (double-lowering is harmless but wasteful).
 */
export function nameRankSqlParams(query: string): string[] {
    const q = (query ?? '').trim().toLowerCase();
    const likeQ = escapeLike(q);
    const globQ = escapeGlob(q);
    return [
        q,                                  // tier 0: LOWER(nameExpr) = ?
        `${likeQ}%`,                        // tier 1: LIKE prefix
        q,                                  // tier 1: LENGTH(?) for the boundary SUBSTR
        `${globQ}[^a-z0-9]*`,                // tier 2: query at the very start
        `*[^a-z0-9]${globQ}`,                // tier 2: query at the very end
        `*[^a-z0-9]${globQ}[^a-z0-9]*`,      // tier 2: query in the middle
        `%${likeQ}%`,                        // tier 3: contains
    ];
}
