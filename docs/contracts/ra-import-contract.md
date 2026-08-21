# Contract: RetroAchievements on-demand game import (demand-driven catalogue)

Product decision (owner, 2026-08-01): bulk video-game imports are retired as the acquisition
strategy. Video/arcade games enter the catalogue **on demand**: a room admin searches a synced
RetroAchievements master list from inside the add-game flows, selects a game, and that selection
IS the approval gate. Arcaid imports the game's metadata + art + score-eligibility classification
from the RA API in realtime; the game is immediately usable in the room AND visible (as a
categorized claim card) on the Global Scoreboard. Removal is handled by a new "not score-eligible"
flag reviewed by the super-admin. The hardened IGDB bulk path (v2.65.0) stays dormant as a tool.

API facts verified 2026-08-01 against api-docs.retroachievements.org (see session research):
- Auth: single query param `y=<web API key>` from any free RA account. No published numeric rate
  limit; fair-use enforced, caching of the game-list endpoint explicitly demanded.
- NO server-side search. `API_GetGameList.php?i=<consoleId>&f=1` per console (f=1 = real
  achievement sets only), response includes ID/Title/ConsoleID/ImageIcon/NumLeaderboards/
  DateModified. Delta sync = re-pull + diff DateModified.
- `API_GetGameExtended.php?i=<id>`: Title, ConsoleID/Name, Publisher/Developer/Genre (often
  EMPTY), Released, ImageIcon/ImageTitle/ImageIngame/ImageBoxArt (site-relative paths; prepend
  `https://media.retroachievements.org`).
- `API_GetGameLeaderboards.php?i=<id>&c=500&o=N`: per board ID/RankAsc/Title/Description/Format/
  TopEntry. Format enum (from RAWeb source, NOT in api docs): SCORE, VALUE, UNSIGNED, TENS,
  HUNDREDS, THOUSANDS, FIXED1/2/3 (numeric); TIME, MILLISECS, TIMESECS, MINUTES, SECS_AS_MINS
  (time).
- Console IDs (from rcheevos rc_consoles.h): 1 Genesis, 2 N64, 3 SNES, 4 GB, 5 GBA, 6 GBC,
  7 NES, 8 TG-16, 9 Sega CD, 11 SMS, 12 PS1, 15 Game Gear, 17 Jaguar, 21 PS2, 25 Atari 2600,
  27 Arcade (incl. Neo Geo), 39 Saturn, 40 Dreamcast, 43 3DO, 51 Atari 7800. Exclude pseudo
  consoles 100/101/102. Others exist (Lynx 13, ColecoVision 44, Intellivision 45, Vectrex 46,
  32X 10, PSP 41, DS 18, GameCube 16 …) — future adds.
- Use RAW fetch (5 trivial endpoints), NOT @retroachievements/api — keeps the importer
  dependency-light and PascalCase-faithful to the docs; parse with local zod-lite guards.

## Sections in order (each a commit)

### 1. Settings + client + console map

- Global settings `RA_USERNAME` + `RA_API_KEY`; `RA_API_KEY` goes on `ENCRYPTED_SETTING_KEYS`
  (ADR 0003 allowlist — adding the key there IS the encryption opt-in). The key rides in query
  strings: the client must scrub `y=` from every logged URL/error (grep the logger paths).
- `src/services/RAApiClient.ts` (per-use, like IScoredApiClient — NOT a singleton): the 4 GET
  endpoints, timeout, single retry with backoff on 429/5xx, typed response guards that tolerate
  extra fields. Base host + media host as consts.
- `RA_CONSOLE_ENGINE_MAP` in `src/utils/scoreProvenance.ts` (+ byte-identical FE mirror +
  parity-test export coverage): RA console id → canonical engine id, using the table above —
  ONLY consoles whose engine already exists in CANONICAL_ENGINES (the 20 listed). RA console 27
  → engine `arcade` and catalogue `type='arcade'`; everything else `type='video_game'`,
  subtype='console'. A test asserts every map value is a canonical engine. Unmapped consoles are
  simply absent from the master list (widening later = one map entry, or one engine + one entry).

### 2. Master list (`ra_games`) + sync + search

- Migration (claim next free number; 131 was last): `ra_games(ra_game_id INTEGER PK, console_id,
  console_name, title, normalized_title, image_icon, num_achievements, num_leaderboards,
  date_modified, synced_at)` + index on `normalized_title` (reuse `normalizeGameName`). NOT a
  child of global_games — it is a shadow index of RA, freely re-syncable.
- `RAMasterListService.syncAll()`: for each mapped console, `GetGameList?f=1`, upsert by
  ra_game_id, delete rows that vanished, ~300ms pause between console calls (fair use), one
  sync_logs row (source 'ra_masterlist') using the v2.65 running/progress lifecycle. Trigger:
  super-admin button on /admin/catalogue + auto-sync AT MOST once/7d checked lazily when the
  search endpoint is hit with a stale (or empty) table. Expected magnitude: ~10-15k rows total.
- `GET /api/rooms/:roomId/ra-catalogue/search?q=` (requireAuth + requireRoomAccess), a
  super-admin twin under /admin, AND a global twin `GET /api/global/ra-catalogue/search?q=`
  (public read — it's just the master list; rate-limited): LIKE + normalized-title contains
  match against `ra_games`, limit 25, response includes whether each RA game is ALREADY in the
  catalogue (LEFT JOIN global_games on the new `ra_id` — §3) so the UI can show "already
  available" instead of an import button.

### 3. One-game realtime import

- Migration (same or next number): `global_games.ra_id INTEGER` UNIQUE-indexed (nullable), plus
  `score_eligibility TEXT` (verdict enum: 'score' | 'score_maybe' | 'time' | 'novelty' |
  'unknown') and `ra_leaderboard_count INTEGER`.
- Dedup: `ra_id` joins the step-1 external-id set in `GlobalGameService.upsert`/`findCandidates`
  (with the existing cross-type guard). Fallback matching for a game already imported via
  IGDB/manual: normal step-4 name match (now indexed via normalized_name) — an RA import that
  lands on an existing row ENRICHES it (fills ra_id, images if missing, eligibility) rather than
  forking a duplicate.
- `RAImportService.importGame(raGameId)`: GetGameExtended + GetGameLeaderboards (paginate c=500)
  → classify score eligibility with EXACTLY this logic (owner-supplied, keep as the single
  classifier function with unit tests):
    - TIME_FORMATS = {TIME, MILLISECS, TIMESECS, MINUTES, SECS_AS_MINS} → 'time'
    - RankAsc true → 'novelty'
    - numeric format (SCORE, VALUE, UNSIGNED, TENS, HUNDREDS, THOUSANDS, FIXED1/2/3) →
      /hi[- ]?score|high score|points|score attack|1cc/i on Title+Description ? 'score'
      : 'score_maybe'
    - no boards at all → 'unknown' (RA silence is NOT a "no" — game stays importable and
      score-submittable; Arcaid's own submission model doesn't depend on RA boards)
    - game verdict = best of its boards' verdicts (score > score_maybe > time > novelty > unknown)
  → upsert global_games: name, manufacturer=Publisher||Developer (may be empty — leave NULL),
  year from Released, type/subtype per console map, `platforms=[engine]` (post-v2.62 engine
  list — goes through the fold like every importer), status='approved' (demand IS approval),
  ra_id, score_eligibility, ra_leaderboard_count → download+rehost ImageIcon (icon) and
  ImageBoxArt (image_url/local_image_path) to `data/catalogue-images/ra/` (existsSync skip,
  timeout — the v2.65 image-pass helpers).
- Endpoints: `POST /api/rooms/:roomId/ra-catalogue/import/:raGameId` (room admin; audit-logged
  via the existing admin write audit), a super-admin twin, AND a PLAYER-triggered global
  variant `POST /api/global/ra-catalogue/import/:raGameId` (owner decision 2026-08-01: a player
  on the Global Scoreboard who can't find Donkey Kong must be able to add it — players are
  demand too). The global variant: `requireDiscordUser` (any logged-in identity — the same bar
  as global score submission; guests see a log-in prompt, not a button), a per-user rate limit
  (5 imports/hour — imports are cheap but RA fair-use and junk-add abuse both argue for a cap)
  plus the existing write limiter, and it records WHO imported: new column
  `global_games.ra_imported_by TEXT` (nullable; the §3 migration adds it) for moderation
  provenance. All three endpoints share one service path. Synchronous — one game is 2-4 API
  calls + 2 image fetches, well under a request timeout; return the created/enriched
  global_game row. Single-flight per raGameId (in-flight map) so double-clicks don't race.
- Instant availability: nothing extra to build — status='approved' makes it visible to the
  library/add-game flows (library = catalogue, ADR 0007) and the Global Scoreboard's v2.63
  prospective-category logic gives it a categorized claim card immediately. Assert BOTH in tests
  (this is the acceptance test: import → game findable in room add-game AND present on
  /api/global/scoreboard under its category filter with a claim card).

### 4. UI — room-admin AND Global Scoreboard

- `GameLibrary.tsx` add-game flow: when a catalogue search misses (or alongside results), a
  "Search RetroAchievements" section → hits the §2 search endpoint → rows show icon, title,
  console, leaderboard count + eligibility hint when known, and an Import button (or "In
  catalogue ✓"). Import → spinner → success lands the game selected/highlighted in the normal
  add flow. Room-admin scoped (the room-admin token already gates the endpoint).
- **Global Scoreboard (owner-mandated player path):** when the scoreboard search yields no (or
  few) catalogue matches for the query, surface master-list results with an **"Add to Arcaid"**
  action — logged-in users trigger the global import endpoint; guests see the row with a
  "Log in to add this game" affordance instead of a button. On success the new claim card
  appears in place (refetch) so the player can immediately submit their score. Apply the same
  treatment in the ⌘K palette's empty state if it composes cleanly; the main search empty-state
  is the must-have. Placement/copy via the screenshot loop.
- Super-admin `GlobalCatalogue.tsx`: same search+import panel behind a button, using the /admin
  twin endpoints (reuse the component across all three surfaces).
- Show "Data from RetroAchievements" attribution + link near the search results (community
  courtesy; not legally mandated per research, but do it).

### 5. "Not score-eligible" flag + review

- The existing report-a-problem flow on game pages (`ReportProblemModal` / game reports admin
  page — recon exact names before editing) gains a reason option: "Not score-eligible (game
  isn't score-based)". Anyone can file it (existing auth semantics for reports).
- Reports admin page renders the new reason distinctly. NO auto-removal — the super-admin
  reviews and uses the existing catalogue delete/merge tooling (FK/unlink discipline applies).
- If `score_eligibility='novelty'|'time'` at import time, the import STILL proceeds (owner may
  want time-attack games someday) but the eligibility verdict renders as a muted hint in the
  admin surfaces so flags aren't the only signal.

## Tests
Classifier unit tests (every Format value, RankAsc branches, keyword boost, no-boards, verdict
precedence) · master-list sync upsert/delete/progress + staleness auto-sync gate · search
already-imported annotation · import: acceptance test above, dedup enrich-not-fork (RA import
onto an existing IGDB/manual row), image rehost paths, key-scrubbing in logs, single-flight ·
flag reason end-to-end (file → renders in admin) · parity test green (map additions mirrored) ·
baselines green (verify current counts on branch first).

## Gates
Root + admin-ui builds · full BE+FE vitest · CRLF · no push · no version/CHANGELOG (orchestrator).
Do NOT touch the IGDB importer, the fold, or the dedup hierarchy semantics.

## Blockers policy
STOP and report: any RA response shape that contradicts the researched facts above; any conflict
between ra_id dedup and the existing external-id guard; the report-flow recon revealing no
game-level report path (build nothing ad hoc — report back for a design call).
