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
 * Mirrored (same tiers, same tests) at `src/utils/searchRank.ts` (backend,
 * powers SQL sites + Discord autocompletes). The two implementations are kept
 * byte-similar by hand — no parity test, they're small — so if you change
 * one, change the other.
 */

/** True when `ch` is a non-alphanumeric boundary, or past the string edge. */
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/**
 * Ranks `name` against `query` per the tier scheme above. Returns 0-4; lower
 * is a closer match.
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

/**
 * Comparator factory for `Array.prototype.sort`: tier ascending, then
 * `localeCompare` on the name within a tier. `nameOf` extracts the
 * comparable name from whatever row shape the caller has (game object,
 * player row, plain string, ...).
 */
export function compareByRank<T>(query: string, nameOf: (item: T) => string): (a: T, b: T) => number {
  return (a: T, b: T) => {
    const diff = rankName(nameOf(a), query) - rankName(nameOf(b), query);
    if (diff !== 0) return diff;
    return nameOf(a).localeCompare(nameOf(b));
  };
}
