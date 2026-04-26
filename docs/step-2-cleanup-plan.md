# Step 2 — drop `game_library` and `game_room_game_library`

## Why this exists

After v2.5.1 (library page reads `global_games` directly), the two legacy
tables `game_library` and `game_room_game_library` still exist but their data
is mostly redundant or unused. They also still get *written* by some paths
(tournament activation, the v2.5.0 proposal flow, the legacy CSV import),
keeping the architecture half-migrated. This plan finishes the migration and
drops both tables.

## Current state of each table

### `game_library` (PK = `name`, predates `global_games`)

Carries data that has no home in `global_games` today:

| Column | Used by | Replacement |
|---|---|---|
| `name` (PK) | iScored sync, tournament games | `global_games.name` (PK = UUID, name is unique-ish) |
| `aliases` | iScored sync — alternate names like "MM" → "Medieval Madness" | Move to `global_games.aliases` (new TEXT column) |
| `style_id` | scoreboard card style | Already on `style_catalogue`; resolved per-game via `games.catalogue_style_id` / `games.bg_style_id` / `games.logo_style_id`. `game_library.style_id` is legacy, unused. |
| `css_title` / `css_initials` / `css_scores` / `css_box` / `bg_color` | per-game scoreboard CSS overrides (legacy, pre-style-catalogue) | Drop. Style catalogue + global card styles cover this. |
| `mode` | filter (`pinball` / `videogame`) | `global_games.type` is canonical — already exists |
| `platforms` | tournament platform rules + leaderboard | Already on `global_games.platforms` |
| `image_url` | scoreboard card image fallback | `global_games.image_url` |
| `tournament_types` | (deprecated CSV field) | Drop |
| `display_name` | per-game display override | `global_games.display_name` |
| `external_url` | "play this game" link | `global_games.external_url` |
| `global_game_id` (added in migration 069) | linkage column | Drops with the table |

### `game_room_game_library` (bridge table)

| Column | Used by | Verdict |
|---|---|---|
| `(game_room_id, game_name)` PK | curation | Drop — no curation in v2.5.1+ |
| `custom_platforms` (added v2.4.0) | per-room platform additions | Drop — global catalogue should cover all real platforms post-v2.5.0 taxonomy expansion |
| `display_name` (added v2.4.0) | per-room name override | Drop — rarely used |
| `global_game_id` (added migration 069) | linkage | Drops with the table |

## What references each table today (audit)

Run before starting step 2:

```bash
git grep -n "game_library\|game_room_game_library" src/ admin-ui/src/ \
  | grep -v "test\|migration\|comment\|//" \
  | sort -u
```

Known callers as of v2.5.1:

**`game_library` writers:**
- `GameLibraryService.importGames()` — used by the per-room CSV import (`POST /:roomId/game_library/import`). Already mostly redundant after v2.5.0 added `/import-csv-preview` + `/import-csv-commit` which write `game_library` AND submit to global. The legacy import path still writes here.
- `GameLibraryService.addToRoom()` — used by tournament game-creation paths.
- The four v2.5.0 proposal endpoints (`use_global` / `room_only` / `submit_to_global`) — write `game_library` rows alongside the catalogue submission.
- Migration handlers — historical, already-applied.

**`game_library` readers:**
- `GameLibraryService.getForRoom()` — was the per-room library list. v2.5.1 stops calling this; library route now reads `global_games` directly.
- Tournament game activation (`gameCreation.ts`) — reads `game_library` for image/style hints when creating a `games` row.
- `GameLibraryService.search()` — autocomplete in Add Game form.
- `LeaderboardService.getActiveLeaderboards()` — reads `gl.image_url` as fallback for scoreboard card art (line ~178 in LeaderboardService.ts).
- `IScoredSubmitSync` — alias resolution.

**`game_room_game_library` writers:**
- `GameLibraryService.addToRoom()` and the four v2.5.0 proposal commit endpoints.

**`game_room_game_library` readers:**
- `ensurePlatformAllowed` (rooms.ts) and `GET /api/submit/platforms` (global.ts) — read `custom_platforms` overlay.
- `GameLibraryService.getEffectivePlatformsForGame` — same overlay.
- `GameLibraryService.getForRoom()` — was the curated list. No longer called from library route in v2.5.1.

## Plan

### 2a — move `aliases` onto `global_games`

1. Schema: `ALTER TABLE global_games ADD COLUMN aliases TEXT DEFAULT '[]'` (JSON array).
2. Data move: `INSERT/UPDATE` to copy `game_library.aliases` (CSV) → `global_games.aliases` (JSON), keyed on `game_library.global_game_id`.
3. Update `IScoredSubmitSync` (and any other alias reader) to read from `global_games.aliases`.
4. Update the catalogue admin UI to expose `aliases` as an editable field on the global game row.

This is the only piece of `game_library` data that has clear ongoing utility. Everything else (CSS overrides, etc.) drops.

### 2b — switch tournament activation to read from `global_games`

`gameCreation.ts` currently reads `game_library` for image/style/external_url hints when materializing a `games` row. Switch to reading `global_games` (joined via `game.global_game_id` or name). Affected:
- `createGameWithIScoredSync()` — image_url fallback, external_url, style_id (drop — style is per-game-instance now via `games.catalogue_style_id`).
- `LeaderboardService.getActiveLeaderboards()` — image fallback (already reads `gg.local_image_path` etc., the `gl.image_url` JOIN can be dropped).

### 2c — drop the `custom_platforms` and `display_name` overlays

1. Remove the JOIN to `game_room_game_library` from `ensurePlatformAllowed` and `/api/submit/platforms` resolver.
2. Drop `mergeEffectivePlatforms` calls; just use `parsePlatformsList(global_games.platforms)`.
3. Audit anywhere else that reads these columns; should be self-contained to platformRules.ts.

### 2d — replace the four proposal commit endpoints

Today they write `game_library` + `game_room_game_library` rows alongside the global submission. After step 2:

- `/use_global` becomes a **no-op** for the library (the catalogue is the library). Optionally keep it as a "favorite this game" affordance — but since the library shows everything, there's nothing to "add". **Recommendation: delete this endpoint.**
- `/room_only` loses its meaning — there's no per-room library to add to. **Recommendation: delete this endpoint.**
- `/submit_to_global` simplifies — just creates the `global_games` row with `status='pending'`. No library writes. **Keep, simplified.**
- `/proposals` — still useful as a "is this in the catalogue?" preview before the user types out a Submit. **Keep.**

The same applies to `/import-csv-preview` and `/import-csv-commit` — simplify the commit handler to only write `global_games` rows (pending or linked). Drop the `room_only` decision branch.

### 2e — drop the tables

After 2a–2d are merged and verified:

```sql
DROP TABLE game_room_game_library;
DROP TABLE game_library;
```

Plus any indexes/views referencing them.

### 2f — drop legacy admin endpoints

Per v2.5.0 plan §5:
> Keep the legacy endpoints server-side for now — only remove the per-room UI affordance.

Step 2 finishes the cleanup:
- `POST /api/admin/game_library/import-vps`
- `POST /api/admin/game_library/import-wizard`
- `POST /api/admin/game_library/import` (legacy CSV bulk write)
- `POST /api/admin/game_library/merge`
- `POST /api/rooms/:roomId/game_library/import` (legacy room CSV)
- `PUT /api/rooms/:roomId/game_library/:name` (per-game edit form — replaced by global catalogue admin)
- `POST /api/rooms/:roomId/game_library/delete` (bulk delete from room — no curation)

### 2g — admin-ui cleanup

- `GameLibrary.tsx` — drop the edit modal, delete-selection buttons, ratings columns (or keep ratings as catalogue-level — see step 2h). The page becomes a read-only catalogue browser with Add Game (→ submit_to_global only) and Import CSV.
- `GameLibraryService.search()` — repoint at `global_games` so the Add Game autocomplete still works.

### 2h — open question: ratings

`game_ratings` is keyed on `(game_name, user_id)`. Survives step 2 unchanged but should probably be re-keyed on `(global_game_id, user_id)` for consistency. Out of step 2 scope; add to a separate cleanup.

## Order of operations

```
1. 2c  — remove custom_platforms / display_name reads (low risk, isolated)
2. 2a  — alias migration (data move + reader switch)
3. 2b  — tournament activation reads global_games
4. 2d  — simplify proposal endpoints
5. 2g  — admin-ui cleanup
6. 2f  — drop legacy admin endpoints
7. 2e  — drop the tables (LAST)
```

Each step buildable + deployable independently. Step 2e is the only one
that's destructive and irreversible without a backup. Snapshot the DB before
running the DROP TABLE.

## Risks / things to verify before starting

- **iScored sync**: aliases are critical for matching iScored's idiosyncratic name formatting. Test step 2a against a snapshot of prod data and confirm sync still finds matches after the alias move.
- **Tournament activation**: ensure `games.image_url` resolution still works after the gl.image_url JOIN goes away in step 2b.
- **Hidden game_library readers**: do a thorough grep before each step. The audit list above is from v2.5.1 — drift is likely if step 2 is done weeks later.
- **Production data is currently demo** (per v2.5.1 directive). When real data lands, step 2 becomes higher-risk and the alias migration in 2a needs careful testing.

## Estimated effort

~1 day of careful work for someone familiar with the codebase. Most time goes
to 2a (alias data move + IScoredSubmitSync rewiring) and 2g (admin-ui rewrite).
2c, 2d, 2e, 2f are mechanical.
