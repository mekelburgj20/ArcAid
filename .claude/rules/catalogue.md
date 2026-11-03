---
paths:
  - "src/services/GlobalGame*.ts"
  - "src/services/*Import*.ts"
  - "src/services/Catalogue*.ts"
  - "src/services/steamPinballPackContents.ts"
  - "src/services/fxVrPackContents.ts"
  - "src/services/atgamesStudioOverrides.ts"
  - "src/services/AtGamesApiClient.ts"
  - "src/services/AtGamesEStoreClient.ts"
  - "src/services/PlayerTables*.ts"
  - "src/services/Rating*.ts"
  - "src/services/RoomGameTags*.ts"
  - "src/utils/catalogueUtils.ts"
  - "src/utils/ratingTarget.ts"
  - "src/utils/scoreProvenance.ts"
  - "src/utils/platformMapping.ts"
  - "src/utils/platformRules.ts"
  - "admin-ui/src/pages/GlobalCatalogue*.tsx"
  - "admin-ui/src/components/RatingBadge.tsx"
  - "admin-ui/src/hooks/useScrollToHash.ts"
  - "admin-ui/src/lib/ratingSort.ts"
  - "admin-ui/src/lib/platforms.ts"
  - "admin-ui/src/lib/scoreProvenance.ts"
---
# Catalogue, importers, ratings and My Tables, platform taxonomy — rules

Loads when you touch the global catalogue, its importers, ratings, My Tables, or the platform/provenance taxonomy. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## Catalogue (global_games)

- **4-step dedup hierarchy** in `GlobalGameService.upsert`: (1) external ID match (`opdb_id`/`vps_id`/`igdb_id`, with cross-type guard), (2) IPDB URL cross-reference for pinball, (3) reserved, (4) normalized-name match (full-table scan + JS-side `normalizeGameName`; no SQL `LIKE` because punctuation broke it). Step 4 is two-tier: **concrete** matches (both sides have non-null mfg + year, exact match) outrank **loose** (NULL-tolerant). Tie-break: external-ID count → mfg/year populatedness → oldest `created_at`.
- **Identity index.** Composite UNIQUE INDEX `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. Same-name pinballs from different manufacturers coexist; true `(name, type, mfg, year)` dupes reject. ADR 0004.
- **Library = global catalogue.** The legacy `game_library` table is dropped (migration 092). Tournament activation, the per-room library page, autopick, Discord autocomplete, and leaderboard image fallback all read `global_games WHERE status='approved'` directly. ADR 0007.
- **`game_room_game_library` survives** for one purpose only: per-game style overlay (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) keyed on `(game_room_id, game_name)`. The `custom_platforms` and `display_name` overlay columns are unread (column kept for now). Future cleanup re-keys the overlay onto `(game_room_id, global_game_id)` and drops this table.
- **Per-room game tags** live in `room_game_tags(game_room_id, global_game_id, tag)`, variant-keyed via `global_games.id`. A game's effective platforms = catalogue platforms ∪ room tags. The UNION is applied across `ensurePlatformAllowed`, `/api/submit/platforms`, `/:roomId/platforms/available`, library list response, web pick-game, admin activate-game, Discord activate/pick autocomplete, autopick paths. `RoomGameTagsService.getTagMapByGameNameForRoom` is the batched-lookup helper. Migration 093, ADR 0008.
- **Pending-approval flow.** Room admins propose new globals via `POST /:roomId/game_library/submit_to_global` (`status='pending'`); super-admins approve/reject/merge at `/admin/catalogue/approvals`. Public `GET /global/games` hard-codes `status='approved'`.
- **`GlobalGameService.findCandidates(input)`** is the read-only dedup walker (extracted from `upsert`'s hierarchy) powering the per-room contribution proposal endpoints.

## My Tables and ratings

- **My Tables (v2.206.0, C2).** `player_tables(user_id, global_game_id, platform)` is a player's own inventory, keyed on `global_games.id` so variants stay distinct; `platform` is a canonical ENGINE id or `''` ("owned, platform unspecified", the ONLY row for a generically owned table). `PlayerTablesService` is the one reader/writer; `setOwnership` REPLACES a game's rows.
- **Inventory may be anonymous, opinions may not (owner ruling 2026-08-24).** Other players only ever see `ownerCount(s)` (the Picks rows' `owner_count`, `GET /api/global/games/:id/owners`), never a list of owners; a new surface that names owners is a bug.
- **Ratings are named.** Both `getGameRating`s ship `raters` resolved through `resolveUserLabels` with `UNRESOLVED_RATER_LABEL` for anything the chain cannot name (pre-v2.86 guest uuids). Per-player reads are `/:roomId/ratings/by-user/:userId` (registered BEFORE `/:roomId/ratings/:gameName`, or "by-user" matches as a game name) and `/global/ratings/by-user/:userId`.
- **Ratings are ONE store (ADR 0035, "a star is a star"; v2.207.0).** `global_game_ratings(global_game_id, discord_user_id, platform)` holds every rating of a table the catalogue knows. `RatingService` is a NAME-keyed facade that resolves the room game through `catalogueIdForName` (`src/utils/ratingTarget.ts`: exactly one approved row, case-insensitive, else null) and only falls back to `game_ratings` for room-only / ambiguous names; a new `INSERT INTO game_ratings` anywhere else is a bug. Migration 205 folded the room history (newer opinion wins).
- **Rating platform and headline.** `platform` is `''` ("the table in general") or a canonical ENGINE id (same vocabulary as `player_tables`). The headline average/count is PER RATER (average of each rater's own average, COUNT DISTINCT) on both game pages, the bulk maps and the Global Scoreboard card subqueries, with `by_platform` beside it. The submission sheet and Discord `/submit-score` rate the ENGINE just played.
- **Lists show that headline (v2.209.0, A14.1).** The Picks availability rows and `GET /api/me/tables` carry `avg_rating`/`rating_count`, and the Global card footer renders the pair it already received. Every list renders it through ONE badge (`components/RatingBadge.tsx`) and sorts "Top rated" through ONE comparator (`lib/ratingSort.ts`); a new table list gets both, not a local copy.
- **Every rating shown off a game page is a link to it (v2.216.0, A14.2).** The badge takes `to` (room lists -> `/:slug/games/:name#ratings`, catalogue lists -> `/games/:id#ratings`); both game pages anchor the rating block at `id="ratings"` and scroll to it through `hooks/useScrollToHash.ts` once the ratings fetch resolves. A new rating surface passes `to`, and a new hash target on an async page uses that hook, not a mount-time scroll.
- **`Star` is the rating glyph and nothing else (v2.209.1).** A record holder (the Picks All-Time High cell, `GameQuickView`'s highlight stat, `GlobalHeroCard`) wears lucide `Crown`, and `Trophy` is a tournament winner.

## Catalogue importers

Each importer feeds the same `GlobalGameService.upsert` path so the dedup hierarchy keeps the catalogue clean (idempotent across re-runs). Admin endpoints under `/api/admin/catalogue/sync-<source>`; FE buttons on `/admin/catalogue`. **Every importer must stamp its source** (`imported_from`): `upsert` merges cross-source only when the stamp differs from the row's, and an unstamped write is a same-source overwrite that NULLs `table_download_urls`/`tutorial_urls`/`rules_urls`.

- **VPS** (Virtual Pinball Spreadsheet) is the primary pinball metadata source. Fetches the VPS database JSON, splits into `playable` + `cataloguable` filters, downloads images in a background pass after the metadata pass returns.
- **VPXS Wizard** reads Legends Unchained's Table Manager **manifest** (`manifest.json` on the repo's `manifest` branch; one fetch, no GitHub REST API; v2.195.0). Every entry carries the VPS game id (`vpsdbId`), so a Wizard row is a **step-1 `vps_id` match**, never a name walk; `enabled: false` entries are skipped. Tags `vpx` + features `vpxs`, `wizard_auto`, `has_backglass`/`requires_rom`/`has_puppack`/`fps_N`. Art is the manifest branch's `boxart/<slug>.webp` (the launcher.png re-encode, v2.201.0); `external_url` is the catalog site's per-table page `vpxtablemanager.com/catalog/#table=<slug>` and the repo folder is the `wizard` download entry. The manifest's `tutorialYouTubeID` lands in `tutorial_urls`.
  - **The README scrape is gone** (upstream deleted the README's table sections 2026-10-28). **There is no manual-install section any more:** the reconcile pass strips `vpxs_manual` from every row the manifest lists; rows it does not list are left alone. `parseWizardManifest` is the pure parser (`wizard-manifest-import.test.ts`).
  - **The sync log's `summary` is the honest count (v2.202.0, C11):** "N tables new on the Wizard since <last run>" from the manifest's `firstAvailableAt`/`updatedAt` (`describeWizardChanges`), because `records_imported` is new CATALOGUE rows and a Wizard table VPS already holds is never one. `source_version` is the manifest's MD5; the NIGHTLY pass (`importFromWizard({ skipIfUnchanged: true })`, runner only) probes the stable release's `release-meta.json` first and skips the 1.4 MB manifest when the checksum matches the last success.
- **OPDB** is pinball metadata + manufacturer/year data. Requires `OPDB_API_KEY` env var.
- **IGDB** is arcade/console games via Twitch OAuth. Requires `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`.
- **Steam Pinball** covers Zen + Zaccaria DLC catalogues across six Steam apps. `tmp/pack-contents-draft.md` source-of-truth → `src/services/steamPinballPackContents.ts` (committed). The curated `PACK_CONTENTS` map expands DLCs into per-table upserts. It stamps `imported_from: 'steam-pinball'` (v2.199.0, C9); it runs after Wizard in the nightly pass.
- **FX VR** is the Pinball FX VR (Meta Quest standalone) catalogue tagger: `tmp/fx-vr-tables-draft.md` (gitignored) → `tmp/emit-fx-vr-data-ts.js` → `src/services/fxVrPackContents.ts`; 43 tables across 19 packs; tags `pinball_fx_vr`. It has a LIVE twin (v2.195.0): Pinball FX VR is on Steam (app 4738360, Steam Frame), so the Steam Pinball importer walks its DLC list too (product entry with `extraFeatures: ['fx_vr']`, all 21 DLC ids curated in `steamPinballPackContents.ts`). "Sync FX VR" can only re-apply this file's list; a new Zen table shows up through "Sync Steam Pinball" (or the nightly cron). Zen's site (Cloudflare bot protection) and the Meta store page (JS-only) cannot be scraped from the server.
- **AtGames** uses two unauthenticated sources, no API key. `AtGamesApiClient` walks AtGames' catalogue feed (`atgames.net/api/leaderboards/games`, CURSOR pagination via `after`/`nextAfter`, 8 rows/page; `limit`/`page`/`catalog`/`rule`/`table` are silently ignored) for canonical names, `hardware_models`, and the stable `game_id` → `global_games.atgames_id`, which makes AtGames dedup a **step-1 external-ID match**. `AtGamesEStoreClient` reads the Shopify storefront (`atgames.us`) for `studio`. Tags `atgames` + one `atgames_<variant>` per cabinet (HD/4K/Micro/HDP/ALU/Mini/Gamer/Core) derived from `hardware_models`.
  - **The feed mixes pinball and arcade** and says which nowhere; the importer classifies on pinball-exclusive cabinet codes (`RK9920`/`HA9919`/`HA8818`/`HA8819C`). Shared codes can't discriminate (an arcade ROM lists `HA8819` "Legends Pinball" too). Add any new pinball cabinet to `PINBALL_ONLY_MODELS` or its exclusive tables silently stop importing.
  - **Studio attribution is five tiers, strongest evidence first:** pack contents list → series parenthetical → pack-title prefix → announced brand → `src/services/atgamesStudioOverrides.ts` (curated, LAST so the store always wins). The first four generalise to future packs; the curated map does not, so **every sync logs the names of unattributed tables**; that WARN is the maintenance trigger for the override file. It fires mainly for ANNOUNCED-BUT-UNRELEASED tables (in the feed weeks before a store listing), where the fix is an interim override entry from AtGames' Originals release schedule, inert once the table ships.
  - **`studio` is NOT `manufacturer`.** FarSight publishes Gottlieb machines, Magic Pixel publishes Zaccaria, Zen publishes Williams. A studio in `manufacturer` makes `manufacturerYearAgree` compare "magic pixel" to "zaccaria", fails step-4 dedup, and inserts a duplicate on every sync (the class repaired by the 88-row prod merge). Manufacturer lands out-of-band via `GlobalGameService.fillMissingManufacturer` (gap-fill only, never in the upsert input).

### Refreshing curated importers

Steam Pinball and FX VR follow one pattern: a hand-curated source-of-truth in `tmp/` (gitignored), an emitter script generating a typed TS data module committed to `src/services/`, and an import service consuming it. AtGames is not in this group (two live APIs, curates nothing).

| Importer | Source-of-truth (gitignored) | Emitter | Committed data module | Refresh cadence |
|---|---|---|---|---|
| **Steam Pinball** | `tmp/pack-contents-draft.md` | manual edit + commit `steamPinballPackContents.ts` | `src/services/steamPinballPackContents.ts` | **Self-maintaining (PR #245):** packs the curated map doesn't cover auto-expand from the DLC's Steam description (`extractPackTables`: marker phrase required, only lines ending "Table"/"Tables" taken, cosmetics blocked). Curated entries win. A pack the parser refuses **WARNs by name** ("N pack(s) still need curating"); THAT is the trigger to hand-add a `PACK_CONTENTS` entry. Known refusals: Bronze Pack (cosmetics, correct), Achievement Table Pack + Pinball Champ Table Pack (~21 real tables in unparseable formats). `cleanTableName` also strips a trailing " Table"/" Pinball Table" (Zaccaria single DLCs). |
| **FX VR** | `tmp/fx-vr-tables-draft.md` | `node tmp/emit-fx-vr-data-ts.js > src/services/fxVrPackContents.ts` | `src/services/fxVrPackContents.ts` | **Mostly self-maintaining** via the Pinball FX VR Steam app (4738360) inside the Steam Pinball sync. The list is the SEED for what Steam lacks: edit the draft, regenerate, click "Sync FX VR". A new FX VR pack Steam's auto-expansion refuses WARNs by name under the Steam sync; add it to `steamPinballPackContents.ts` by id. |
| **AtGames** | none (live API + storefront) | none | `src/services/atgamesStudioOverrides.ts` (studio residue only) | Click "Sync AtGames". Touch the override file only when a sync WARNs about unattributed tables (a pack with no contents list). |

Endpoints: `POST /admin/catalogue/sync-steam-pinball`, `POST /admin/catalogue/sync-fx-vr`, `POST /admin/catalogue/sync-atgames`.

- **Nightly sync (v2.195.0, C4).** `Scheduler.startCatalogueSyncCron` → `CatalogueSyncService.runScheduled` at 04:30 BOT_TIMEZONE, in order VPS → Wizard → Steam Pinball → AtGames (+ OPDB when `OPDB_API_KEY` is set). The runner only sequences: each importer keeps its own `sync_logs` row and Discord alert, a source whose previous run is still live (`SyncLogService.getActiveRun`) is skipped, and one failure never stops the rest. FX VR (static list) and IGDB (multi-hour, own resume contract) are deliberately not scheduled. `CATALOGUE_AUTOSYNC_ENABLED='false'` (env or global setting) turns it off; default ON. Adding a live importer means adding it to `SCHEDULED_SOURCES` (and, if it needs a key, to `sourcesForTonight`).

## Platform taxonomy

- **Two taxonomy generations coexist.** The provenance taxonomy (ADR 0016) lives in `src/utils/scoreProvenance.ts` (BE) mirrored **byte-identically below the header** in `admin-ui/src/lib/scoreProvenance.ts` (locked by `scoreProvenance-parity.test.ts`; extend, never weaken): `CANONICAL_ENGINES`, `CANONICAL_DEVICES`, `ENGINE_DEVICE_COMPAT`, `LEGACY_PLATFORM_MAP` (every canonical engine id is an identity key), and `foldCataloguePlatforms` (the ONE legacy→engines+features fold shared by migration 129 and all seven importers; never fork it).
- **Legacy taxonomy.** `src/utils/platformMapping.ts` + FE `admin-ui/src/lib/platforms.ts` (no parity test) still back `normalizePlatform`/aliases. Beware `PLATFORM_ALIASES['fx'] = 'pinball_fx'`: catalogue paths must use `normalizeCataloguePlatformId` (BE) / the isCanonicalEngine guard (FE) so engine ids aren't re-legacied.
- **`global_games.platforms` holds ENGINE ids** (`vpx`, `fx_classic`, `atgames_native`, console ids…) since v2.62.0; per-game availability facts live in `features` (`atgames`, `vpxs`, `vpxs_manual`, `vr`, `bam`, the 8 AtGames cabinet variants).
- **Device-required rules match explicit availability only.** Never match via `ENGINE_DEVICE_COMPAT` (deliberately permissive; it would admit every VPX table to AtGames-only tournaments).
- **`vr_headset` required-matching is engine-scoped (ADR 0019, v2.144.0).** `ENGINE_VR_AVAILABILITY` (`always` wholesale engines: `vpx`, `fp`, `zaccaria`, `star_wars`; `per_table` engines `fx`/`fx_classic`, evidenced by the `<engine>_vr` feature the FX VR / FX Classic VR importer stamps) decides eligibility. The generic `vr` feature is informational only ("a VR room/edition exists") and does not drive eligibility.
