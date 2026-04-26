# Changelog

This file is the single source of truth for ArcAid release history. The legacy `releases/v*/README.md` per-version-directory convention was retired as of v2.3.0 — see [`releases/README.md`](releases/README.md) for context.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

---

## [2.5.2] — 2026-04-26

**Patch.** Game library page showed duplicate platform tags per game (`fp` AND `FP`, `vpx` AND `VPX`, `pinball_fx_classic` AND `FX3`). Migration 083 only rewrote the literal `pinball_fx3` token; case mismatches and aliases survived in `global_games.platforms` / `game_library.platforms` JSON arrays.

- **Migration 089** — one-time normalization sweep. Walks every JSON platform array (`global_games.platforms`, `game_library.platforms`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules`) and folds each entry through `normalizePlatform()`. Dedupes case-insensitively. Production landed: 2733 `global_games` rows, 2813 `game_library` rows, 4 tournament rule rows normalized. Idempotent.
- **`GameLibrary.tsx`** — defense-in-depth at render time. `PlatformChips` alias-folds + dedupes via `normalizePlatformList()` then renders `getPlatformDisplay(id)` (e.g. "FX Classic" instead of `pinball_fx_classic`). Filter pill row above the grid does the same. Filter match logic normalizes the game's raw list so filtering works on pre-089 data too.

SW `CACHE_NAME` → `arcaid-v18`.

---

## [2.5.1] — 2026-04-26

**Feature + patch.** Per-room library page reads from `global_games WHERE status='approved'` directly — every room sees the full approved catalogue. The legacy `game_room_game_library` curation overlay is no longer consulted for the list view. This is "step 1" of a two-step cleanup; step 2 (drop the legacy `game_library` / `game_room_game_library` tables, move aliases onto `global_games`, simplify proposal endpoints) is documented in `docs/step-2-cleanup-plan.md`. Tournaments still pick from `game_library` for now — out of scope for step 1.

Three platform-display bugs fixed:

- **Submission picker showed raw IDs and case-mismatch duplicates.** `/api/submit/platforms` resolver now alias-folds + dedupes via `normalizePlatform()` server-side; `SubmissionSheet` renders display names from a new FE-side `admin-ui/src/lib/platforms.ts` helper. Same treatment applied to `GameDetail` tabs and per-row platform badges.
- **Display names shortened** for the Zen Studios FX family + Zaccaria: `"Pinball FX Classic"` → `"FX Classic"`, etc. Catalogue IDs unchanged. Display-only — no DB migration.
- **Global game detail page now has a Platform column** on the cross-room leaderboard. `GlobalLeaderboardService.recalculate` SELECTs `gs.platform`, propagates through `GlobalRankedEntry`, renders as a chip. Migration 088 flushes both leaderboard caches so existing entries pick up the platform field on next read.

SW `CACHE_NAME` → `arcaid-v17`.

---

## [2.5.0] — 2026-04-26

**Feature.** VR + Steam-pinball platform taxonomy expansion, score-platform stratification, per-room contribution flow rationalization. Coordinated bundle — score-platform is required end-to-end, so partial deploys would reject every submission.

**Platform taxonomy.** Adds 7 canonical IDs: `pinball_fx_classic` (replaces `pinball_fx3`, Zen rebrand), `pinball_fx_classic_vr`, `pinball_fx_midnight`, `pinball_fx_vr`, `star_wars_pinball_vr`, `zaccaria`, `zaccaria_vr`. Removed legacy `pinball_fx3` + generic `vr` bucket. New `'VR'` `PLATFORM_GROUPS` quick-pick. `PLATFORM_ALIASES` + `VPS_FORMAT_MAP` fold pre-rebrand names forward.

**Steam Pinball importer.** `SteamPinballImportService` pulls DLC lists from six Steam apps. Curated `PACK_CONTENTS` map (78 packs → 220 table entries) baked in via `steamPinballPackContents.ts`; pack DLCs expand into per-table upserts rather than landing as a single pack-named row. Skip-list catches Volume/Pack/Bundle/Tables/VR/Soundtrack/Editor/Mode entries. `cleanTableName` strips ™/®/©/℠ + wrapping quotes. `findSuffixVariantMatch` folds "X" / "X Pinball" duplicates pre-upsert. 1100ms inter-fetch throttle; 30s back-off on HTTP 429. Production import: 152 imported / 198 updated / 78 packs expanded / 0 errors. Admin route: `POST /api/admin/catalogue/sync-steam-pinball`. UI: new "Steam Pinball" button on `/admin/catalogue`.

**Score-platform stratification.** Required `platform` field on `submissions`, `score_history`, `community_scores`, `global_scores` (column nullable in SQL for legacy rows; required at the API boundary via Zod). New `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` helper — game's effective platforms ∩ active tournament rules. Server-side `ensurePlatformAllowed` re-validates at every submit handler. `SubmissionSheet` picker: read-only chip when 1 platform, required dropdown when 2+. Discord `/submit-score` auto-fills when 1, rejects with valid-choices reply when 2+. `ScoreSyncPoller` stamps `tournament.iscored_default_platform` on synced rows. Leaderboard endpoint accepts `?platform=<id>`; per-game distinct-platform list returned for the GameDetail tab strip. RankedEntry carries per-row platform; "All" view shows platform badges + demotes NULL-platform rows to a "Platform unknown" tail.

**Per-room contribution flow.** Removed legacy "Import from VPS" / "Import VPXS Wizard" buttons from the per-room game library page (server endpoints kept for now). New `GlobalGameService.findCandidates` (read-only dedup walker, extracted from `upsert`) powers four new per-room routes: `/game_library/proposals`, `/use_global`, `/room_only`, `/submit_to_global`. Add Game UX renders an inline result panel (exact / possible / no-match) with the three commit choices. CSV import switched to two-step preview/commit: `/import-csv-preview` categorizes rows into `auto_link` / `auto_submit` / `needs_review`; FE renders bucketed preview with per-row decision UI; `/import-csv-commit` applies decisions per-row best-effort.

**Super-admin Catalogue Approvals.** `GET /admin/catalogue/pending` (joined with submitter + room), `/pending-count` (nav badge polled every 60s), `POST /pending/:id/approve`, `/reject` (audited reason), `/merge_into/:targetId` (delegates to `GlobalGameService.merge`). New `CatalogueApproval.tsx` page; nav badge in `SuperAdminLayout`.

**Visibility hardening.** Public `GET /global/games` hard-codes `status='approved'` (was honoring `?status=` query — leak risk). Aligned `'pending_review'` stub references to `'pending'` across `getCounts` + status PATCH validator.

**Migrations 083–087.**
- 083 — rename `pinball_fx3` → `pinball_fx_classic` across `global_games`, `game_library`, `game_room_game_library`, tournament `platform_rules`. Production landed: 102 `global_games` rows + 99 `game_library` rows.
- 084 — `ALTER TABLE … ADD COLUMN platform TEXT` on submissions/score_history/community_scores/global_scores + composite indexes; `tournaments.iscored_default_platform`; `submission_drafts.platform`.
- 085 — backfill platform on legacy score rows where the source game has exactly 1 platform; multi-platform rows stay NULL. Production: resolved 62 submissions / 9 score_history / 67 community_scores; left NULL: 18 / 80 / 10 / 23 (multi-platform games).
- 086 — flush `leaderboard_cache` + `global_leaderboard_cache` for the new platform-bearing `RankedEntry` shape.
- 087 — `global_games.{submitted_by_user_id, submitted_by_room_id, submitted_at}` + partial index on `(status, submitted_at) WHERE status='pending'`.

**Bug surfaced + fixed inline:** four sites used `JOIN game_library gl ON gl.id = grgl.game_library_id` — but `game_library`'s PK is `name` and the FK column is `game_name`. Would have failed at runtime on first `docker compose up`.

SW `CACHE_NAME` → `arcaid-v16`.

---

## [2.4.16] — 2026-04-25

**Patch.** Catalogue UX + diagnostics.

- **Logger writes `Error.stack` to file instead of `{}`.** `formatLogArg()` in `src/utils/logger.ts` special-cases `Error` so the rotating file stream and the admin Logs viewer get the actual stack — previously every `logError(msg, err)` site silently lost detail because `Error.message` and `.stack` are non-enumerable and `JSON.stringify` skipped them. Console output was unaffected (Node's `util.inspect` handles Error specially), so this had been hiding for the entire life of the project. The trigger was `Background OPDB sync error: {}` showing in the file.
- **OPDB / IGDB sync routes return 400 when credentials are missing.** Previously they returned `202 started`, threw inside the background task, and the only signal was a swallowed log line. Routes now validate `process.env.OPDB_API_KEY` / `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` upfront. The admin-ui catch-and-toast pattern surfaces the message directly.
- **OPDB API Key + Twitch Client ID/Secret added to Global Settings → Configuration.** Three new fields with masked inputs + reveal toggles for the secrets. The error messages now point to a section that actually exists.
- **`OPDB_API_KEY` and `TWITCH_CLIENT_SECRET` join the at-rest encryption allowlist.** Parity with `ISCORED_PASSWORD`. Twitch Client ID stays plaintext (it's a public identifier).
- **VPS catalogue import accepts broken-flagged entries.** Bluey, Britney Spears, Chime Speed Test Table and similar rows showed up as bare entries on `/scoreboard` because the importer's `playable` filter (gating both legacy `game_library` and global catalogue) excluded VPS entries with `broken: true`. The filter served the legacy path correctly — broken tables shouldn't be selectable for tournament picks — but it also blocked the global catalogue, which is just identity + metadata + images. Split into `playable` (game_library) and `cataloguable` (any entry with a name → global_games + image download pass).

SW `CACHE_NAME` → `arcaid-v15`.

---

## [2.4.15] — 2026-04-24

**Patch.** VPS re-indexing case. VPS occasionally re-registers entries with new `vps_id` values; on the next sync, step 1 (external-ID lookup) misses, and step 4's dedup excluded the row via the `hasExternalIdConflict` Frankenstein-prevention guard, causing `INSERT` to collide on the composite UNIQUE INDEX. Three games failed: "Hot Tip" (Williams 1977), "A-ha" (Original 2025), "Evel Knievel" (Bally 1977).

Fix: step 4 concrete-match path now filters against the full `nameMatches` set instead of `nonConflicting`. A pinball machine has a single canonical `(name, manufacturer, year)` identity by physical reality — divergent external IDs just mean the source re-indexed itself, not that we'd merge unrelated rows. The COALESCE-based UPDATE adopts the new authoritative external ID. The loose path (NULL mfg or year) still applies the conflict guard, since there's no canonical anchor without those.

---

## [2.4.14] — 2026-04-23

**Feature.** Per-tournament scheduler logs gain a `[room-slug]` prefix so site-admin Logs no longer show un-attributed "Scheduling maintenance for Daily Grind" lines. `Scheduler.start()` LEFT JOINs `game_rooms` to obtain the slug; `scheduleTournament` and `scheduleCleanup` accept it as an optional parameter. Super-admin Dashboard adds an **Activity Log** link per room card linking to `/${room.slug}/admin/activity` for per-room drill-down.

---

## [2.4.13] — 2026-04-22

**Feature.** Wizard import is now section-aware. The README parser distinguishes `wizard_auto` (verified VPXS auto-install tables) from `wizard_manual` (Manual Install Tables — hit-or-miss on AtGames Standalone). `WizardImportService.platformsForTable()` tags rows accordingly: `vpxs` for auto, `vpxs_manual` for manual. New canonical platform `vpxs_manual` ("VPX Standalone (Manual Install)") added to `platformMapping.ts`. `reconcileWizardPlatformTags` strips stale tags when a table moves between sections on a re-import. Tournaments requiring reliable VPXS can now exclude unreliable manual ones.

Also: SpongeBob no-parens edge case. Wizard input had no `(Original, 2021)` parens so `parseNameParts` returned undefined mfg/year, and the catalogue had both a rich (Original, 2021) row and a thin backfill residue (NULL, NULL) — both passed the NULL-tolerant `manufacturerYearAgree`. Step 4 loose path now applies a richest-row tie-breaker (`opdb_id + vps_id + igdb_id + manufacturer-not-null + year-not-null` score; created_at as final tie).

---

## [2.4.12] — 2026-04-22

**Patch.** `findByNormalizedName` rewritten to drop the SQL `LIKE '%word%'` prefilter. The previous version computed `firstWord = normalizeGameName(input).split(' ')[0]` and used it to prefilter rows by raw `name` LIKE, but normalization strips punctuation while raw names retain it — so `"gilligans"` couldn't match the stored `"Gilligan's Island"` because the apostrophe broke the substring match. Now does a full-table scan and JS-side normalize compare. At ~5k rows the scan runs in milliseconds; negligible for admin-triggered imports.

---

## [2.4.11] — 2026-04-22

**Patch.** Step 4 concrete filter now requires exact year match (not ±1 tolerance). Tolerance let "Breaking Bad (Original, 2021)" and "Breaking Bad (Original, 2022)" both count as concrete matches for a 2022 input — `concrete.length=2` → fall-through → INSERT → UNIQUE collision. Multi-concrete case adds a richest-row tie-breaker (most external IDs first, oldest `created_at` as tiebreak).

---

## [2.4.10] — 2026-04-22

**Patch.** Two-tier step 4 match. `manufacturerYearAgree` treats NULL mfg/year as "pass," which lets thin-backfill rows (NULL/NULL leftovers from the v2.4.0 backfill) blend into the candidate set and prevent single-hit resolution. Step 4 now prefers candidates that *concretely* agree on both mfg AND year (non-null on both sides, exact match) before falling back to the NULL-tolerant check. Migration 082 re-runs the thin-duplicate merger.

---

## [2.4.9] — 2026-04-22

**Patch.** Removed stale `SYNC_ALERT_CHANNEL_ID = 1467561374040461527` from the seed; it had been baked in and was firing 404s on every sync attempt. Migration 081 scrubs the value if it exists in the live `settings` table.

---

## [2.4.8] — 2026-04-21

**Patch.** Composite UNIQUE INDEX swap. Migration 080 drops `idx_global_games_name_type` (UNIQUE on `(LOWER(name), type)`) and creates `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. The strict 2-column index rejected legitimate same-name pinballs from different manufacturers (Stern Batman 2008 vs Data East Batman 1991, etc.) — 115 errors on the first Wizard import. The composite preserves dedup of true duplicates while letting variants coexist.

---

## [2.4.7] — 2026-04-21

**Patch.** Migration 079 catches no-comma `(Mfg YYYY)` thin duplicates that 078's strict comma regex missed.

---

## [2.4.6] — 2026-04-21

**Patch.** Migration 078 merges thin backfilled catalogue duplicates (rows where `name` contains a parens-baked-in `(Mfg, YYYY)` suffix and a corresponding rich row exists with stripped name + populated mfg/year).

---

## [2.4.5] — 2026-04-21

**Patch.** All Games tab fixes: catalogue card link now resolves to room game detail when mapped (was always going to global); rows with no image are hidden by default to keep the carousel art-forward.

---

## [2.4.4] — 2026-04-21

**Patch.** Migration ledger order fix. Migration 077 (drop NOT NULL on `submissions.game_id`) now runs before 070 (orphan cleanup, which `UPDATE`s `submissions.game_id = NULL`). Pre-fix, prod boot crashed on the orphan cleanup because the column still required non-null.

---

## [2.4.3] — 2026-04-21

**Patch.** v2.4.0 backfill (migration 069) now uses a strict `LOWER(name) + type` exact-match helper instead of `GlobalGameService.upsert`'s 4-step dedup. The dedup matched too aggressively (normalizeGameName collapsed multiple distinct names to the same key) and re-INSERTed rows the migration was meant to backfill, recreating duplicates.

---

## [2.4.2] — 2026-04-21

**Patch.** Migration 068 audit pass now runs multi-pass (up to 3 iterations) to catch residuals where a duplicate group's "winner" itself has another duplicate. Logs unresolved-group diagnostics if any remain.

---

## [2.4.1] — 2026-04-21

**Patch.** Migration 068 auto-merges legacy duplicate `(name, type)` groups instead of aborting. Prod had 112 duplicate groups in `global_games` — pre-fix the unique index creation aborted on first attempt and prod failed to boot.

---

## [2.4.0] — 2026-04-21

**Major.** Catalogue Unification + Pin to Scoreboard.

**Catalogue unification.**
- **Backfill.** Migration 069 populates `global_game_id` on every relevant row in `games`, `game_library`, and `game_room_game_library`. Pre-sprint fill rate was 0% / 0% / 51%; identity now resolved through the FK rather than name-based JOINs (with name-based COALESCE fallbacks kept as defense in depth).
- **UNIQUE INDEX `idx_global_games_name_type`** on `(LOWER(name), type)` (later replaced by composite identity index in v2.4.8) closes the read-check-insert race in `GlobalGameService.upsert`.
- **Orphan cleanup.** Migration 070 deletes the 5 legacy pinned games (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id=NULL` that the broken `/list-active` was returning. Reference audit confirmed zero dangling submissions.
- **Per-room overlay.** `game_room_game_library.custom_platforms` and `display_name` columns (migration 071). `effectivePlatforms = union(global, room-custom)`. WMS leagues can add their own platform tags without touching the shared catalogue.
- **Query migration.** High-impact joins switched to FK-based: `rooms.ts` library JOIN, `GameLibraryService` room-library queries, `GlobalScoreService` fan-out short-circuits, `LeaderboardService` + `DashboardService` style-resolution.

**Pin to Scoreboard.**
- Room admins can now pin a game to the scoreboard from the Game Library page, optionally creating it on the room's iScored account in the same step. Pinned games render with a "Pinned" chip on Banner/Showcase/Minimal cards, stay ACTIVE until manually unpinned, don't contribute to cross-tournament rankings, and survive maintenance cycles.
- **Schema.** `games.game_room_id` (denormalized for pinned rows; tournament rows still derive via `tournament_id`), `games.display_order`, unique partial index `idx_games_pinned_unique` on `(game_room_id, LOWER(name)) WHERE tournament_id IS NULL`.
- **Cascade on unpin.** Submissions, score_history, and global_scores `origin_game_id` get `UPDATE … SET game_id = NULL` before the row DELETE — score history preserved even when the game row goes away.
- **Shared `createGameWithIScoredSync()` helper** (`src/engine/gameCreation.ts`) extracted from three duplicated `TournamentEngine` call sites. Returns structured `{ gameId, iscoredStatus: 'created' | 'failed' | 'skipped' }`.

Migrations 068–076 (9 total). 119 tests pass (was 89 + 30 new).

---

## [2.3.3] — 2026-04-19

**Patch.** Discord read commands (`/list-active`, `/list-tournaments`, etc.) now exclude `games` rows with `tournament_id IS NULL` (orphans). The legacy "pinned" attempt left 5 orphan rows on prod that surfaced through these commands as ghost active games. v2.4.0 deletes them; v2.3.3 prevents re-emergence in case future code paths leave orphans.

---

## [2.3.2] — 2026-04-19

**Patch.** Discord-disabled rooms (per-room `DISCORD_ENABLED=false`) now excluded from slash-command queries. Pre-fix, `/list-active` in a connected room would return data from disconnected rooms too.

---

## [2.3.1] — 2026-04-19

**Patch.** Discord slash commands and DM dispatch now gate on the per-room `DISCORD_ENABLED` flag. Demo room could disable Discord but still receive DMs from notification hooks.

---

## [2.3.0] — 2026-04-19

**Major.** Per-room iScored / Discord configuration + at-rest secret encryption.

- **Per-room moves.** Discord guild ID, admin role ID, announcement channel ID, and iScored credentials moved from global to per-room `game_room_settings`. Each room can independently connect to its own Discord guild and iScored account, or disable either integration.
- **At-rest encryption.** New `src/utils/secrets.ts` provides AES-GCM encryption keyed off `SECRETS_KEY` (32-byte hex from env). `ENCRYPTED_SETTING_KEYS` allowlist (currently `ISCORED_PASSWORD`) controls which keys are encrypted on write and decrypted on read. `SettingsService` and `GameRoomSettingsService` consult the registry transparently. Allowlist is intentional (no convention-based auto-encrypt) so a typo like `IS_CORED_PASSWORD` won't silently land in plaintext. `maskEncryptedValues` returns a `[ENCRYPTED]` placeholder on `GET /admin/settings` so the UI never round-trips ciphertext.
- **Pre-deploy DB snapshot pattern** captured for the migration that introduced encrypted columns.

---

## [2.2.15] — 2026-04-18

**Patch.** Room Settings reorganized + Identity moves.

- Room Settings sections reordered: Theme → Scoreboard Display → Scoreboard Branding → Kiosk → Game Room → Integrations → Discord → Users → iScored.
- "Refresh Schedules" button moved to bottom of Tournaments page (was under "System Actions" on Settings).
- Merge / Rename Player moved from Settings to the Identity admin page (`/:slug/admin/identity`).
- Platforms management removed from Settings — covered by the `+` button next to Platforms in the Game Library row editor.
- Discord admin "user not found" error now surfaces a distinct 400 with actionable text.
- Default scoreboard display picker shows the new card styles first (Banner/Showcase/Minimal) with a "Show legacy styles" expander revealing the older card system.

---

## [2.2.14] — 2026-04-21

**Patch.** Swapped Fire and Queue button positions on the Mystery Award cabinet — Queue now sits on the left, Fire on the right. Matches pinball cabinet convention where the "commit/hit" button is on the right. SW `CACHE_NAME` → `arcaid-v9`.

---

## [2.2.13] — 2026-04-21

**Patch.** Mystery Award cabinet redesign.

- **Tournament Pool is now a pinball cabinet topper.** New `TournamentPoolTopper` component renders directly above the backbox as a cabinet attachment — orange LED glow strip, chunky silhouette, "TOURNAMENT POOL — Daily Grind ▼" pill. Clicking opens a drop-down list that overlays the top of the backbox; selecting collapses it back. `MysteryAward` accepts an optional `topper` slot so the page composes it in.
- **Fire and Queue buttons are always visible as circles.** Replaced the branching Hit Mystery / Add to Queue / Log in to queue / Play Again / Close button stack with two persistent circular pinball-cabinet buttons. Fire is always live (triggers a new spin, disabled only while cycling); Queue is grayed out until a game is revealed and the viewer has a Discord login. Labels beneath ("SPIN" / "ADD") clarify action.
- **Queue color matches the cabinet.** Was green. Now an amber-orange sibling of Fire (slightly deeper tint) so both buttons read as part of the same cabinet.
- **"Hit Mystery" renamed to "Fire"** per user preference — matches the cabinet action-button vocabulary.
- **Close moved to a footer text button** (was a NeonButton in the control panel). Less visually competitive with the round action buttons.

SW `CACHE_NAME` bumped to `arcaid-v8` so the cabinet redesign propagates to installed PWAs on next reload.

---

## [2.2.12] — 2026-04-21

**Patch.** Mystery Award: Tournament Pool selector was at `top-[14%]` which overlapped the backbox graphic on mobile. Collapsed it into the top nav row alongside the back link + login CTA — single fixed header at `top-0`, selector centered between the two, so it sits directly above the backbox with no overlap at any viewport width. Label shows "Tournament Pool:" on sm+ and "Pool:" on xs.

SW `CACHE_NAME` bumped to `arcaid-v7` so clients pick up the new bundle on next reload.

---

## [2.2.11] — 2026-04-21

**Patch.** Service-worker cache-bust. `sw.js` uses cache-first for JS/CSS assets and its `CACHE_NAME` had been pinned at `arcaid-v5` since v2.0.x, so installed service workers were serving stale bundles even after browser hard-refreshes. Bumped to `arcaid-v6`. The SW's `activate` handler deletes all caches not matching the current name, so on the user's next page load the old cache is purged and everything reloads fresh.

This is why v2.2.10's username-Link / expand-contrast / Picks-URL changes weren't visible to the tester even though the bundle was correctly deployed.

---

## [2.2.10] — 2026-04-21

**Patch.** Five follow-ups from v2.2.9 testing.

- **Username → player stats everywhere.** BannerCard, MinimalCard, ShowcasePodium (all 3 slots), and ScoreList now render each leaderboard username as a `<Link>` to `/:slug/players/:name` with `stopPropagation` so row-click expand still works. Previously only Room Game Detail's leaderboard had the Link.
- **Expanded history contrast bumped.** The inline mini-history panel under an expanded player was rendering scores at 50% opacity and dates at 25% — nearly invisible against the card background (image #12). Now scores at ~95%, dates at ~65%, panel background opacity bumped from 30% → 55%. Font size up 1px.
- **Mystery Award: pool selector moved under the back link → centered above the modal.** Was tucked in the top-right corner disconnected from the object it controls. Now sits at `top-[14%]` centered horizontally so the Tournament → Mystery Award relationship is visually obvious. Label changed from `Pool:` → `Tournament Pool:`.
- **Pinball-backbox-style action button.** `Hit Mystery` / `Add to Queue` buttons now render as chunky pinball-cabinet buttons — chrome bezel, neon gradient face, pressed-in `:active` state, color-coded (orange for spin, green for queue). Full CSS lives in `index.css` as the `.pinball-action-btn` family.
- **Picks URL is human-readable.** `/:slug/picks?t=<uuid>` became `/:slug/picks?t=daily_grind` (tournament name slugified — lowercased + non-alphanumerics collapsed to underscores). Resolved back to tournament id once the list loads. Back-compat: UUID still works if an old link is clicked.

---

## [2.2.9] — 2026-04-21

**Patch.** Apply the v2.2.8 Link-overlay removal to the places that actually render scorecards.

v2.2.8 removed the Link overlay + passed `titleLinkTo` through CardRouter — but only via `GameCard`. **The public Scoreboard (`Scoreboard.tsx`) and `GamesTabView.tsx` render `CardRouter` directly**, with their *own* overlay Link wrapping. v2.2.8's fix never applied to the room scoreboard the user actually sees. This patch:

- Drops the overlay Links from `Scoreboard.tsx` (all three layouts: grid / vertical / horizontal) and `GamesTabView.tsx`.
- Passes `titleLinkTo={linkForTournamentCard(lb)}` to each `CardRouter` call.
- Drops the now-unused `Link` imports from both files to satisfy TypeScript `noUnusedLocals`.

Same behavior goal as v2.2.8, this time applied to the actual render paths.

---

## [2.2.8] — 2026-04-21

**Patch.** Structural fix for the scoreboard click-routing problem + Mystery Award visibility.

Instead of stacking a z-10 Link overlay across the whole card and juggling `pointer-events` on every interactive child — which kept losing to one layout or another — removed the overlay entirely. Each card variant (BannerCard / MinimalCard / ShowcaseCard) now wraps *its own title* in a `<Link>` to the Room Game Detail. Score rows, `+` expand icons, and the submit button all have natural clickability with no competing overlay.

- **Scoreboard card click routing.** Title click → Room Game Detail. `+` / score row click → inline expand (when the player has multi-score). Submit button → submit sheet. No more "click `+` navigates away."
- **Removed title-click-submits-score behavior.** Previously clicking the title area opened the submit sheet when `onSubmitScore` was set. This was redundant with the explicit `+` button and conflicted with making title a Link. The `+` button is the single submit affordance now.
- **Mystery Award header overlay `z-[60]` + `fixed` positioning.** `MysteryAward` renders as `fixed inset-0 z-50`; the header overlay was at `z-10` inside a `relative` wrapper, so it sat underneath the modal entirely — including the Pool dropdown. Now `fixed` + `z-[60]` so it renders above the modal.

Full details → [releases/v2.2.8/README.md](releases/v2.2.8/README.md)

---

## [2.2.7] — 2026-04-21

**Patch.** Two v2.2.6 follow-ups + a playbook clarification.

- **Shared `DiscordLoginButton` component** so GlobalScoreboard, GlobalGameDetail (and any future global-surface pages) render the same Discord-brand blue button with the Discord SVG logo that PublicLayout uses on room pages. Previously globals used lucide's generic `LogIn` icon on a neon-cyan button, which broke visual parity after the v2.2.6 "Login" text normalization.
- **ShowcasePodium pointer-events reinforcement.** Outer wrapper of each podium slot now also sets `pointerEvents: 'auto'` when `canExpand`, so clicks on the slot's padding / surrounding flex area (not just the tinted inner box) still trigger the inline expand. The inner's `pointerEvents: 'auto'` was already there in v2.2.6 but didn't cover edge clicks.
- **Playbook clarified.** The `+` expand indicator only renders on rows where the player has >1 submission on that game. Rows for single-submission players never show `+` — that's the intended design, not a missing feature.

Full details → [releases/v2.2.7/README.md](releases/v2.2.7/README.md)

---

## [2.2.6] — 2026-04-21

**Patch.** Five UX follow-ups from v2.2.5 playbook feedback.

- **Tournament card / All Games card links now go to Room Game Detail** (`/:slug/games/:name`) instead of Global Game Detail when the game has a global mapping. Pre-v2.2.6 clicks routed to the Global page, which (correctly) hides anon submissions via the fan-out gate — so guest scores appeared to vanish on click. Global remains reachable via `/scoreboard` tiles.
- **UserMenu on Global pages.** `/scoreboard` (GlobalScoreboard) and `/games/:id` (GlobalGameDetail) used their own inline login/logout UI; now they use the shared `UserMenu` component — My Rooms / Friends / Scoreboard-display / Log out are reachable from global pages too.
- **Login text normalized** to "Login" on all public-facing pages. Admin login pages keep their existing labels.
- **Room Game Detail leaderboard: username clicks go to player stats.** `/:slug/players/:name` instead of doing nothing. Row-click still expands the multi-score history (v2.1.0). `stopPropagation` keeps the two gestures separate.
- **Scoreboard card score rows are clickable again.** The `+` expand icon on scorecards was being intercepted by the z-10 Link overlay, so clicks navigated to Game Detail instead of expanding inline. Fix: wrap `CardRouter` in `relative z-20 pointer-events-none` and mark expandable score rows `pointer-events-auto` — interactive rows now capture their own clicks; non-interactive areas still pass through to Link → navigate.
- **Mystery Award tournament selector.** When a room has >1 active tournament, a Pool dropdown appears in the header overlay so users can pick which tournament's pool drives the spin. Defaults to first active tournament (prior behavior preserved for single-tournament rooms).

Full details → [releases/v2.2.6/README.md](releases/v2.2.6/README.md)

---

## [2.2.5] — 2026-04-20

**Patch.** Two correctness fixes + one UX lift from v2.2.3 manual testing.

- **`conditionalRequireDiscordUser` now decodes optional tokens.** Pre-v2.2.5, when a room had `REQUIRE_DISCORD_LOGIN=false`, the middleware called `return next()` without looking at the Authorization header — so a logged-in user's submission silently fell through as `COMMUNITY` (anon). Effect: their score didn't fan out to Global, their avatar join failed, and they appeared with a `?` silhouette on the Tournament card. Middleware now always attempts to decode a Bearer token when present; it only *requires* one when the room opts in.
- **Pre-submit name collision prompt.** `POST /:roomId/submit/name-check` returns `{ available, suggestion }` using `RoomNameClaimService.checkAvailability` (dry-run of the claim logic, no persistence). SubmissionSheet now runs this before POSTing for anon submissions — if the name is taken, it shows an editable "Name already in use" panel pre-filled with the server's next-free suggestion. User can accept, edit to something else (check re-runs), or cancel. Replaces the post-hoc "Submitted as Chad_2" disclosure message.
- **Resolved-name prefill.** `arcaid-player-name` localStorage now stores the *resolved* display name after a successful submit (e.g. `Chad_2` if the server suffixed), not the raw typed name. Next session prefills with the sticky identity.

Full details → [releases/v2.2.5/README.md](releases/v2.2.5/README.md)

---

## [2.2.4] — 2026-04-20

**Patch.** Post-login redirect lands on the Lobby, not Picks.

When a user logs in with Discord from a game room's public pages (landing → Scoreboard → Login), they were being dropped on `/:slug/picks` — the winner-pick surface. New default is `/:slug/lobby` (social hub), which is what users expect after a fresh login. Global pages (`/scoreboard`, `/friends`, `/my-rooms`) and in-flight flows (pending-submission OAuth handoff) still pass their own explicit `returnPath`, so those are unaffected.

Changed: `ViewerAuthContext.loginWithDiscord` default path and `DiscordCallback`'s `player:<slug>` fallback.

---

## [2.2.3] — 2026-04-19

**Patch.** Fix first-claim-wins over-sticking: typing a different name from the same browser was silently collapsed back to the browser's first claim, so "Bob_2" and "Bob_3" submitted from the "Bob"-claimed browser were stored as "Bob" and merged into Bob's leaderboard row.

`RoomNameClaimService.resolveAndClaim` dropped the token→name idempotent short-circuit. The suffix loop now checks whether the requested name is free OR already owned by the submitting claimant — either is fine, otherwise suffix. Symmetric for Discord users (they can rotate their per-room display name too).

Migration 066 rebuilds `anon_room_claims` with PK `(anon_token, room_id, display_name)` so one token can hold multiple name claims in the same room. Unique name-per-room index preserved.

Full details → [releases/v2.2.3/README.md](releases/v2.2.3/README.md)

---

## [2.2.2] — 2026-04-19

**Patch.** Closes the "freeplay scores never reach iScored" gap.

Before v2.2.2 only the Tournament-card / Game-Detail submit path (`POST /:roomId/submit-score/:gameName`) fired the fire-and-forget iScored sync. Scores submitted via `/freeplay-score` or the legacy `/community-scores/:gameName` endpoint stayed local-only — so players who used the Freeplay page never appeared on iScored even when the game matched an active tournament.

Extracted the sync into a shared `IScoredSubmitSync.syncScoreToIScored` helper and wired it into all three web submission paths. Same guards (game must be ACTIVE with an `iscored_id`), same API-preferred / Playwright-fallback logic, same error handling. All three paths now pass the resolved `displayName` (post-v2.2.0 auto-suffix), so the name on iScored matches the name on ArcAid's scoreboard.

Full details → [releases/v2.2.2/README.md](releases/v2.2.2/README.md)

---

## [2.2.1] — 2026-04-19

**Patch.** Three follow-ups from v2.2.0 manual testing.

- **Winner resolution reads local DB first.** `TournamentEngine.processSlotMaintenance` now picks the winner from `submissions` (which has everything — Discord, guest, iScored-synced) and only falls back to iScored when local is empty. Previously the reverse — the bot would announce whoever iScored had on top, even when ArcAid's own scoreboard knew better. Broke badly for guest-allowed rooms where iScored rejected a submission (the "Access Denied" case below).
- **iScored API `submitScore` handles non-JSON rejections.** iScored responds `200 OK` with a plain-text body like `"Access Denied"` when it rejects a submission (seen on a guest's 99.9B score). The client now parses response text before JSON and surfaces a clean error instead of a raw `SyntaxError` that crashed the surrounding sync pipeline.
- **Anon-winner Discord message** now includes claim guidance: *"Is this you? Log in with Discord on {scoreboard} to claim future scores. If your Discord name differs from `{name}`, ask an admin to merge identities. An admin will pick the next game in the meantime."* No more broken `@mentions`; no more picker-slot created for a winner that can't use `/pick-game`.
- **GameDetail leaderboard React key fix** (shipped as `a368aaeb` on 2026-04-19) — anon rows were being de-duped by the reconciler because they share `discord_user_id="SYSTEM"`; composite `rank-username` key restores them.
- **Data cleanup (prod):** removed 61 legacy anon rows from `global_scores` that fanned out before the v2.2.0 gate landed, and flushed `global_leaderboard_cache` (7 entries). Global Game Detail now resolves to the Discord-authenticated row for affected usernames.

Full details → [releases/v2.2.1/README.md](releases/v2.2.1/README.md)

---

## [2.2.0] — 2026-04-19

**Minor.** Identity-correctness release. Closes the "guest score absorbs a logged-in user's leaderboard row" gap.

- **Global fan-out gate** — guest submissions never reach the Global Leaderboard. Every row on global is guaranteed to have a real Discord ID behind it. Implemented as a one-line early-return in `GlobalScoreService.fanOutFromRoomSubmission` keyed on `normalizeSubmitterUserId`.
- **First-claim-wins identity** — new `RoomNameClaimService` resolves a per-room display name at submission time. The first identity (Discord or anon) to use a name in a room owns it; later arrivals auto-suffix to `Bob_2`, `Bob_3`. Backed by a new `room_members.display_name` column and a new `anon_room_claims` table. SubmissionSheet shows "Submitted as Bob_2 — 'Bob' is already in use" when a suffix was applied.
- **`REQUIRE_DISCORD_LOGIN=true` default for new rooms** — safe-by-default identity. Existing rooms unaffected (flipping retroactively orphans anon scores).
- **SubmissionSheet polish** — always sends a stable anon-token; replaces the global-exclude checkbox with a guest-mode nudge ("Log in with Discord to also include it on the global ArcAid leaderboard").
- **UserMenu z-index fix** — dropdown bumped to `z-50` so it wins over game-card submit buttons.

Migrations 064 (DDL for first-claim-wins) and 065 (no-op marker for the default-flip event).

Full details → [releases/v2.2.0/README.md](releases/v2.2.0/README.md)

---

## [2.1.0] — 2026-04-18

**Minor.** Three net-new capabilities.

- **Tournament scoring reads `score_history`** filtered by `submitted_during_tournament_id` — best-during-the-window wins, no longer tied to all-time personal best. `submissions` writes preserved for back-compat. Migration 063 backfills existing rows.
- **Multi-score view** on Game Detail: click a username → inline expand with sparkline of progression, split into "This tournament" vs "All time" when an active tournament is in play. Photo-proof links per row.
- **Stats page Combo redesign** — 4-card overview at the top (plays this week / active players / hottest game / latest submission) on top of the existing Players / Games tabs. New `GET /:roomId/stats/overview` endpoint.

Full details → [releases/v2.1.0/README.md](releases/v2.1.0/README.md)

---

## [2.0.3] — 2026-04-18

**Patch.** Three smoke-test follow-ups.

- Default catalogue image restored on Tournament + All Games cards (backend COALESCE to `global_games` + ShowcaseCard fallback; admin style still wins)
- Submit button icon unified — `Plus` on both Tournament and All Games cards
- `/freeplay-score` now upserts `submissions` when the game is an active tournament game, so scores submitted via game detail count for the tournament just like Tournament-card submits

Full details → [releases/v2.0.3/README.md](releases/v2.0.3/README.md)

---

## [2.0.2] — 2026-04-18

**Hotfix.** Tournament card title routed to room-scoped URL instead of global catalogue.
`LeaderboardService.getActiveLeaderboards()` now selects `COALESCE(g.global_game_id, gl.global_game_id)`
so the frontend's `linkForTournamentCard` resolves to `/games/:id?from=:slug` when the game is mapped.

Full details → [releases/v2.0.2/README.md](releases/v2.0.2/README.md)

---

## [2.0.1] — 2026-04-18

**Patch release.** Seven fixes from v2.0.0 manual testing.

- Avatar leak on anonymous submissions (privacy regression — `LeaderboardService` + 3 siblings narrowed the username-fallback to `iscored:*` only)
- OAuth-cancel detection when user closes the Discord tab without a redirect
- Room-scoped GameDetail Community tab migrated to `SubmissionSheet` (photo upload + anon claim + error messaging)
- `SubmissionSheet` gained a `requireLogin` prop → login-required state up-front on gated rooms
- Global GameDetail Submit respects `?from=<slug>` room context → freeplay target when present
- Internal `Catalogue` / `Community` labels no longer leak onto cards
- Mystery Award direct URL: `/:slug/mystery-award` as a shareable Discord link + login hint

Migration 062: cache flush for the avatar-fix SQL changes.

Full details → [releases/v2.0.1/README.md](releases/v2.0.1/README.md)

---

## [2.0.0] — 2026-04-18

**Major release.** Scores/Nav Reorg — 12-sprint plan + Sprint 13 polish pass.

Highlights:
- Anonymous submission runtime with Discord-collision claim prompt + OAuth draft handoff
- Merge/unmerge admin flow at `/:slug/admin/identity` with freeze-rule protection
- `ENABLE_GAME_PICK_AWARD` opt-in gate hides the pick flow where not wanted
- Global Scoreboard room badges with `?room=<slug>` filter URLs
- Unified `SubmissionSheet` replaces 4 legacy submit modals
- Scoreboard tabs: `Tournaments | All Games` + "Played at" filter
- `/:slug/games` renamed to `/:slug/picks` with 301 redirect
- New nav UserMenu dropdown with full WAI-ARIA keyboard support
- Per-room `short_tag` column for custom badge abbreviations

Breaking: route rename + 4 components deleted + existing rooms must opt into `ENABLE_GAME_PICK_AWARD` to keep the Picks tab visible.

Full details → [releases/v2.0.0/README.md](releases/v2.0.0/README.md)

Commit: `595d9b0f`

---

## [1.x] — pre-2026-04-18

No per-version release notes exist for the 1.x line. Historical context is tracked in `SPRINT_STATUS.md` (current session notes) and `ROADMAP.md` (completed work). Starting with v2.0.0, every release gets a dedicated notes file.
