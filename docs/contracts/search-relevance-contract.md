# Search relevance ranking — work-package contract

Owner ask (2026-08-13, field report with "Strike" example): every search ranks by
nearest-exact-match first. Branch: `feature/search-relevance` off current main.

## The tier scheme (THE spec — all sites, both languages)

Query `q` (lowercased, trimmed) vs candidate name `n` (lowercased):

- **Tier 0 — exact**: `n === q`. ("Strike")
- **Tier 1 — starts with the query as a full word**: `n` begins with `q` AND the
  next character is NOT a letter/digit (space, punctuation, end handled by tier 0).
  ("Strike Zone", "Strike Master", "Strike Deluxe Pinball Table")
- **Tier 2 — contains the query as a whole word**: `q` occurs in `n` bounded on
  BOTH sides by non-alphanumeric (or string edge). ("Lucky Strike", "Triple
  Strike", "Big Strike", "Bowl A Strike")
- **Tier 3 — substring inside a word**: any other occurrence. ("Striker",
  "Strikes and Spares", "…Empire Strikes Back")
- **Tier 4 — no name match** (matched via other fields: manufacturer, alias,
  author…): below all name tiers. Only relevant at sites that search multiple
  fields — do NOT drop these rows, they rank last.

Within a tier: alphabetical `COLLATE NOCASE` / `localeCompare` (except noted
per-site secondary orders below). Empty query → site's existing default order,
untouched.

## Shared helpers (build these FIRST, with unit tests)

1. **`src/utils/searchRank.ts`** (BE):
   - `rankName(name: string, query: string): number` — returns 0-4 per the tiers
     (pure JS; used by Discord autocompletes).
   - `nameRankSqlCase(nameExpr: string): string` + `nameRankSqlParams(query: string): string[]`
     — emits a SQLite `CASE WHEN … THEN 0 … ELSE 4 END` fragment over `nameExpr`
     with `?` placeholders, params from the query. Word-boundary test in SQLite:
     `SUBSTR(LOWER(nameExpr), LENGTH(?) + 1, 1) NOT GLOB '[a-z0-9]'` for tier 1;
     tier 2 via `LOWER(nameExpr) GLOB` with the query GLOB-escaped and
     `[!a-z0-9]` boundaries on both sides plus edge variants (`q||'[!a-z0-9]*'`
     prefix-at-start is tier 1's job; tier 2 needs `'*[!a-z0-9]'||q||'[!a-z0-9]*'`,
     `'*[!a-z0-9]'||q` at end). LIKE fallbacks acceptable if GLOB escaping gets
     hairy — correctness on the "Strike" example set is the acceptance test.
   - ESCAPE handling: query may contain `%`/`_` (LIKE) or `*`/`[`/`?` (GLOB) —
     escape both paths. Unit-test with a query containing `%` and `[`.
2. **`admin-ui/src/lib/searchRank.ts`** (FE): `rankName` (same tiers, same tests)
   + `compareByRank(query)` comparator factory (tier asc, then localeCompare).
   Keep the two `rankName` implementations byte-similar; add a short header
   comment in each pointing at the other (no parity test needed — they're small).

## Backend SQL sites (rank must apply BEFORE `LIMIT`)

1. `GlobalGameService.search` (`src/services/GlobalGameService.ts:887-966`) —
   currently `ORDER BY id`. When search text present: `ORDER BY <rankCase>, name
   COLLATE NOCASE`. No search text → keep existing order.
2. `GameLibraryService.search` (`src/services/GameLibraryService.ts:8-18`) —
   `ORDER BY <rankCase>, name COLLATE NOCASE LIMIT 10`.
3. `GlobalLeaderboardService.getTopGames` (`src/services/GlobalLeaderboardService.ts`,
   orderBy built ~1044-1055; search filter 512-537) — WHEN `search` is present,
   PREPEND the rank CASE (over `COALESCE(display_name, name)` — whichever
   name expr the query exposes; check the SQL) to the existing orderBy chain so
   relevance leads and the user's chosen sort (popular etc.) breaks ties within
   tiers. No search → orderBy unchanged. This also fixes the ⌘K palette.
4. `StyleCatalogueService.search` (`src/services/StyleCatalogueService.ts:39-50`)
   — rank over `name` (author matches = tier 4), then existing alphabetical.
5. `RAMasterListService.search` (`src/services/RAMasterListService.ts:347-392`) —
   EXTEND its existing 3-tier CASE to the 5-tier scheme; KEEP
   `num_leaderboards DESC` as the within-tier secondary (it's deliberate), title
   alphabetical third.

## Discord autocomplete sites (JS sort before `.slice(0, 25)`)

Full array is already in memory — sort with `rankName` before slicing:
- `src/discord/commands/pickgame.ts` (~168-170, game option)
- `src/discord/commands/activategame.ts` (~30-66, game_name option)
- `src/discord/commands/forcemaintenance.ts` (~19-33)
- `src/discord/commands/viewstats.ts` (~21-33)

DO NOT touch `/submit-score` and `/deactivate-game` autocompletes — their
tournament-grouped ordering is intentional (product call deferred).

## Frontend client-side sites (apply `compareByRank` after filter)

- `ScoreboardSurface.tsx:221-224` — sort the filtered leaderboards by
  rank of (displayName||gameName) when search text present.
- `GamePickerModal.tsx:56-58`
- `Picks.tsx:594-638` (`filteredGames`) — rank on game name; keep chips/other
  filters as-is.
- `PublicStats.tsx:171-179` — BOTH `filteredGames` and `filteredPlayers`.
- `PersonalBestsSection.tsx:99-150`
- `GameLibrary.tsx` main list (`sortedGames` memo ~905-993): when search text is
  non-empty, rank tier leads; the user's chosen column sort applies WITHIN tiers.
  Empty search → existing behavior byte-identical.
- `ComparePlayers.tsx:107-116` and `MemberAdminPicker.tsx:80-87` — player-name
  filters, same comparator (cheap, owner said "all search functions").

FE sites that are backend-driven (GlobalCatalogue browse/merge pickers,
CatalogueApproval, GlobalSearchPalette, RAGameSearch, StyleCatalogue/StylePicker)
need NO FE change — they inherit the SQL fix.

## Tests

- New unit tests for both `searchRank` helpers pinning the OWNER'S EXAMPLE SET:
  query "strike" over ["Strike", "Strike Zone", "Strike Master", "Lucky Strike",
  "Triple Strike", "Striker", "Strikes and Spares", "Star Wars: Episode V The
  Empire Strikes Back", "Gold Strike", "Bowl A Strike"] → tiers 0/1/1/2/2/3/3/3/2/2
  and the full sorted order. Plus LIKE/GLOB-escape cases.
- A SQL-side test for `GlobalGameService.search` seeding that same name set and
  asserting the returned order (the repo has service-level test patterns — follow
  `src/__tests__/` conventions).
- Extend/adjust any existing tests that pinned old orderings.
- Baselines to end at-or-above: backend 1691, admin-ui 735. Run ALL suites
  SYNCHRONOUSLY in the foreground — NEVER as background tasks.

## Hard rules

- Branch `feature/search-relevance`; verify with `git branch --show-current`
  before editing.
- Both builds green (`npm run build` root + admin-ui), admin-ui lint zero NEW
  problems on touched files.
- CRLF check before commit: `git diff --numstat` vs `git diff -w --numstat`.
- Commit with a `feature:` message; do NOT push, do NOT bump versions or touch
  CHANGELOG/SPRINT_STATUS/ROADMAP, do NOT open PRs.
- No files outside this contract + tests.
- If blocked or a site's code contradicts this contract, STOP and return a
  structured blocker instead of guessing.

RETURN: per-site status table, helper design notes (especially the SQLite
word-boundary expression you landed on), test/build/lint/CRLF results, commit SHA.
