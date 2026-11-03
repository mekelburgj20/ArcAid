---
paths:
  - "src/services/ScoreHistory*.ts"
  - "src/services/Submission*.ts"
  - "src/services/CommunityScore*.ts"
  - "src/services/Leaderboard*.ts"
  - "src/services/GlobalLeaderboard*.ts"
  - "src/services/GlobalScore*.ts"
  - "src/services/GlobalPin*.ts"
  - "src/services/Merge*.ts"
  - "src/services/Identity*.ts"
  - "src/services/PlayerProfileResolver.ts"
  - "src/services/UserProfile*.ts"
  - "src/services/RoomNameClaim*.ts"
  - "src/services/RoomMembership*.ts"
  - "src/services/ScoreRank*.ts"
  - "src/services/ScoreProvenance*.ts"
  - "src/services/AutoScoreSuppression*.ts"
  - "src/services/RoomScores*.ts"
  - "src/services/IScoredSubmitSync.ts"
  - "src/engine/gameCreation.ts"
  - "src/utils/scoreProvenance.ts"
  - "src/utils/platformRules.ts"
  - "src/utils/platformMapping.ts"
  - "src/utils/gameRunWindow.ts"
  - "src/utils/scoreCorrectionPolicy.ts"
  - "src/discord/**/submitscore.ts"
  - "src/discord/**/mapuser.ts"
  - "admin-ui/src/components/SubmissionSheet*.tsx"
  - "admin-ui/src/components/CorrectScoreModal.tsx"
  - "admin-ui/src/components/ScoreboardComponents.tsx"
  - "admin-ui/src/components/GameQuickView.tsx"
  - "admin-ui/src/pages/GameDetail.tsx"
  - "admin-ui/src/pages/Leaderboard.tsx"
  - "admin-ui/src/lib/scoreProvenance.ts"
  - "admin-ui/src/lib/platforms.ts"
---
# Score system, identity, moderation, platform rules — rules

Loads when you touch score storage, submission resolution, identity/alias linking, leaderboard name resolution, score correction/deletion, pinning, or tournament platform rules. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## Score tables

- **`submissions` is the source of truth for *best-per-player-per-game*.** ID format `${gameId}-${username.toLowerCase()}` (sync-compatible with iScored).
- **`score_history` is the physical union of all score sources.** It logs every score event with source tracking; community/freeplay submits dual-write into it via `ScoreHistoryService.log` (`source='community'`, from `CommunityScoreService.submitScore`). Room-wide "all scores" reads (e.g. `RoomScoresService`) read `score_history` ALONE — never UNION `community_scores` (the admin wipe-player path deletes `score_history` rows but deliberately NOT `community_scores`, so a union would resurrect wiped scores).
- **Tournament leaderboards read `score_history` filtered by `submitted_during_tournament_id`** (best-during-window wins); `submissions` is still written for back-compat.
- **Every per-game board also applies `gameRunWindowSql` / `gameRunWindowByIdSql`** from `src/utils/gameRunWindow.ts` (on/after the game's `start_date`, before the next run's), because the tournament key alone cannot tell two RUNS of one table in one tournament apart (web rows have no `game_id`). A new per-game board query without it re-opens a re-run table with its previous run's scores (incident 2026-10-25; v2.172.0). `TournamentScoresService` merges runs on purpose and is exempt.
- **The submit-moment "You are #N of M" card ranks against that SAME window population.** `ScoreRankService.computeRoomRank` uses it when the game is ACTIVE in a tournament — never a source-filtered subset (a `source='tournament'`-only union hid every synced rival) (v2.125.1).
- **`LeaderboardService.recalculate()` partitions by `COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))`** so multi-alias Discord users collapse to one row per game; pure-anon rows still partition per-name (v2.8.0).

## One submission-game resolver

- **`SubmissionGameResolver.resolveSubmissionGame` is the ONE decision of which game a web score belongs to.** Order: an explicit `gameId` (the card the FE knows the player pressed "Submit" on) when it matches room/name/status → else name lookup, EARLIEST-`start_date` ACTIVE row wins among same-named games (WARN naming every competitor) → else the newest COMPLETED row (v2.155.1).
- **Called ONCE per request, result threaded everywhere.** `submit-score`, `freeplay-score`, the legacy `community-scores` route, the OAuth draft commit and `ScoreHistoryService.log`'s tournament auto-resolve each call it once (event gate → resolver → provenance check → write), and the result feeds `GET /submit/platforms` (the sheet sends the card's `gameId`), `ScoreProvenanceService.validateForRoomGame`, `ScoreRankService.computeRoomRank`, `IScoredSubmitSync` (which board a web score mirrors to) and `RotationNudgeService` — so picker, acceptance check, `submissions` upsert, `score_history` stamp, cache invalidation and rank card describe the SAME game (v2.155.2).
  - A second ad hoc name lookup in any submit path is the ambiguous-active-games bug (two ACTIVE same-named games in different tournaments) reborn — route it through the resolver.
- **`ScoreHistoryService.isDuplicate`'s dedup key includes `submitted_during_tournament_id`.** One play may be submitted to EACH tournament currently running the table (lands on both boards); the same score into the SAME tournament is a re-send and is dropped (v2.155.3).
- **All web submission paths (`/submit-score`, `/freeplay-score`, `/community-scores`) sync via `IScoredSubmitSync.syncScoreToIScored()`** — single helper, divergence not possible. `IScoredApiClient.submitScore` parses response text before `JSON.parse` to handle "Access Denied" plain-text rejections.

## Identity layer (v2.8.0)

- **`user_mappings(discord_user_id, iscored_username UNIQUE COLLATE NOCASE, avatar_hash, created_at)` is many-to-one.** One Discord user can hold many iScored aliases; an alias maps to at most one Discord user (case-insensitive). The `discord_user_id` PK was dropped in migration 095.
- **`user_profiles(discord_user_id PK, display_name, avatar_hash, avatar_fetched_at, ...)` is one row per Discord user.** Holds the user-chosen global display name (case-insensitively unique via partial UNIQUE INDEX `idx_user_profiles_display_name`) plus the avatar cache (moved off `user_mappings.avatar_hash`, which still exists but is no longer the read source).
- **`anonymous_identities` / `anon_room_claims` / `room_members`** are the pre-existing per-room claim tables; unchanged.
- **Display resolution rule: everywhere a player name renders, `display_name ?? iscored_username`.** FE helper `playerName(entry)` in `admin-ui/src/components/ScoreboardComponents.tsx`. BE responses ship both fields; matching/keying still uses `iscored_username` (stable; used in `/players/:name` routes and React `key` props).
- **Id-keyed surfaces resolve through `resolveUserLabels(ids)` / `labelForProfile(p)` in `PlayerProfileResolver.ts`.** Anything rendering a player from a bare user id rather than a score row (voters, event participants/lobby, members, pickers, nominees, linked accounts, rotation-log actors): `display_name` → `user_profiles.username` → earliest `user_mappings` alias → raw id as LAST resort. A new surface that renders `|| userId` (or ships `display_name ?? null` for a bare id) without that chain is the voter-snowflake bug reborn (2026-10-18; v2.162.2).
- **First-claim-wins names per room.** `RoomNameClaimService.resolveAndClaim` walks a suffix loop (`Bob` → `Bob_2`); `checkAvailability` is the pre-submit dry-run used by `SubmissionSheet`. Discord claims live in `room_members.display_name`; anon claims in `anon_room_claims` (one anon-token may hold multiple names per room).
  - `room_members.display_name` (per-room first-claim policy) is **separate** from the global `user_profiles.display_name` (user-chosen rendering name). Merge does NOT touch `room_members.display_name`.
- **Anon ID:** the `x-user-id` header carries a `localStorage` UUID for guest write paths (community scores, comments); used for comment author-only delete.
- **Login is unconditionally mandatory for all web score submissions (v2.79.0).** The per-room `REQUIRE_DISCORD_LOGIN` setting and `conditionalRequireDiscordUser` middleware are retired (migration 138 deleted stored rows; `OrphanService` deleted — existing `orphaned_at` rows and every `orphaned_at IS NULL` query filter stay untouched). Comments/tips stay guest-open via `optionalDiscordUser`.
- **Membership/privacy = three orthogonal room settings.** `ROOM_LISTED` (default on; `'false'` drops the room from `GET /api/rooms` only — direct URL, portal and member `/api/me/rooms` unaffected) is the ONE listing switch: `game_rooms.is_public` mirrors it, written by the settings save, room create and super-admin edit through `GameRoomService`; a writer that sets one without the other is the "toggle on, room hidden" bug reborn (v2.203.1). `JOIN_POLICY` (`open`/`approval`). `AUTO_APPROVE_GUILD_MEMBERS` (approval rooms auto-approve linked-guild members via `JoinRequestService.tryAutoApprove` — identity-link-aware, bot-side `isMemberOfGuild`, uncertainty degrades to the manual queue, never auto-deny; audit row `resolved_by='auto:guild'`).

## Alias linking and merge

- **`/map-user` is additive.** It adds an alias for the target Discord user and errors if the name is already mapped to a different user; no "replace" semantic, no `/unmap-user` (deferred) (v2.8.0).
- **`user_mappings` writers:** `global.ts` (global-submit display-name claim), `mapuser.ts`, `submitscore.ts` — all `ON CONFLICT(iscored_username) DO NOTHING` — plus `MergeService.recordMerge` (pre-flight `MAPPING_CONFLICT` check inside the txn). **Discord OAuth login writes NO mapping** (`auth.ts` is not a writer, verified 2026-07-15): a logged-in web player gets `submitted_by_user_id` attribution and a `room_members.display_name` claim, but their room name is NOT a global alias until `/map-user`/merge links it — name-based stat resolvers (compare, enhanced player stats) read `user_mappings` only.
- **`src/services/IdentityAliasEffectsService.ts` is the ONE place that knows what happens when an alias becomes linked (v2.127.0).** Every `user_mappings` writer must call `onAliasLinked(userId, name)`, gated on the INSERT actually inserting (`res.changes`, since they all `DO NOTHING`); every alias REMOVAL must call `onAliasUnlinked`. Callers: `IdentityClaimService.claim`/`approve`/`releaseAlias`, `mapuser.ts`, `submitscore.ts`, `global.ts`, `MergeService.recordMerge`.
  - (a) folds synthetic `iscored:<Name>` `room_members` rows onto the real account (earlier `joined_at` wins; display name carried over when the real row lacks one).
  - (b) re-attributes unowned SYNCED rows in `score_history` + `submissions` across ALL rooms — `submitted_by_user_id IS NULL AND discord_user_id LIKE 'iscored:%' AND merged_from_anonymous_identity_id IS NULL` — minus a **freeze gate** skipping rows whose `submitted_during_tournament_id` names a COMPLETED (`is_active = 0`) tournament, exactly as `MergeService.previewMerge` does.
  - (c) fire-and-forget `UserProfileService.hydrateFromDiscord`. `community_scores`/`global_scores` are never touched (sync writes neither).
  - (a)/(b) run in the caller's transaction when a `db` handle is passed and their errors propagate; (c) never can. Re-attribution invalidates Leaderboard + GlobalLeaderboard **+ Ranking** via the shared `invalidateIdentityCaches` (the ranking watermark is over counts/sums, which re-attribution doesn't change).
- **Profile hydration.** Also a nightly `20 4 * * *` sweep, `refreshStaleDiscordProfiles`, whose candidates are `user_profiles` rows with a stale/NULL stamp UNION Discord-snowflake ids in `user_mappings`/`room_members` with NO profile row (so a link-time failure is retried). One `fetchDiscordUser` REST call; skips Google ids and anything fetched inside 24h; fills `username` only when NULL; never touches `display_name`; killed by `PROFILE_HYDRATION_ENABLED='false'`.
- **The AUTOMATIC avatar provider is Discord-first.** `resolveEffectiveAvatarProvider`: explicit preference → Discord `avatar_hash` → Google URL → none (Google returns a generated letter tile, not NULL, for a photo-less account; migration 160 re-derived preference-less rows) (v2.127.1).
- **`room_members` never holds an `iscored:*` id.** Migration 159 folded/purged survivors; `RoomMembershipService.isRealUserId` rejects the prefix.
- **Forward attribution at merge.** `MergeService.recordMerge` writes `user_mappings(discord_user_id, iscored_username)` inside the transaction with a pre-flight `MAPPING_CONFLICT` check; `ScoreSyncPoller` picks it up next poll cycle (mappings load fresh per cycle, `ScoreSyncPoller.ts:109`).
  - `reverseMerge` deletes that alias row and re-anonymizes post-merge auto-attributed rows (not in the snapshot, landed via the auto-mapping rule between merge and reversal) — special-cases `global_scores.player_id` vs the other tables' `discord_user_id`.
  - `MergeService.previewMerge` derives the tournament-completed timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` (no `tournaments.end_date` column exists).

## Display-name resolution in BE queries and caches

- **`submitted_by_user_id` never holds the poller's synthetic `iscored:<name>` id.** `normalizeSubmitterUserId` returns null for it, because every resolver keys `user_profiles` on that column first and only falls back to `user_mappings` when NULL; a synthetic value hid the avatar/name of anyone who linked after their scores synced (incident 2026-08-21; v2.125.2). `PlayerProfileResolver` also treats a synthetic value as absent for cached rows.
- **Live leaderboard/ranking/stats queries that ship `display_name` resolve the same way:** `user_mappings` for the `iscored:*` fallback, then `user_profiles` keyed on `COALESCE(submitted_by_user_id, um.discord_user_id)` — deliberately NOT on the raw per-row discord id. Expressed as two LEFT JOINs in `RankingService.computeRankings` (two batched lookups, same rule), `StatsService.getAllPlayerStats`/`getRoomOverview`, `GlobalLeaderboardService.getTopScoresForCards`, `/api/global/recent-scores`.
- **CACHED paths resolve at READ time, not at recalculate time (v2.74.0, S24.1).** `leaderboard_cache` and `global_leaderboard_cache` store identity-stable rows only (`submitted_by_user_id`, the raw per-row discord id, `iscored_username`, score, provenance) in a `{v, rows}` envelope; `resolveProfiles` in `src/services/PlayerProfileResolver.ts` attaches `display_name`/`avatar_hash`/`avatar_url` in two batched queries per page.
  - **Never bake a name or an avatar back into that cache JSON** — it re-creates the profile-edit invalidation storm (`invalidateAll()` is a whole-table DELETE, after which `getActiveLeaderboards` serially recalculates the whole room) and the avatar-never-reaches-Global bug.
  - The rename (`users.ts`) and avatar-change (`auth.ts`) paths therefore perform NO cache invalidation; the settings/merge/admin `invalidateAll` sites are unrelated and still required. A blob in the old bare-array shape is treated as a cache miss.

## Global Scoreboard fan-out

- **EVERY score reaches the Global Scoreboard unless the player opted out (v2.153.0, ADR 0023).** Tournament, event round, Throwdown, AtGames cabinet and VPXS cabinet all fan out; **format never decides, the player does** (`user_preferences.share_to_global`, default on; the per-submission checkbox still wins for one score where a form exists).
- **The three no-form paths go through ONE helper, `GlobalScoreService.fanOutAutomatedScore`.** It resolves the account preference (`resolveExcludeFromGlobal`) and refuses a null/unlinked identity; a fourth caller that hand-rolls either check is a bug.
- **`'sync'` is the ONE refusal**, about missing provenance not format (ADR 0016 P2 §3b forces `unknown`/`unknown`, unplaceable on an engine-split board), enforced INSIDE the fan-out so a call site cannot reinstate it. Rooms keep their own `GLOBAL_SCOREBOARD_ENABLED='false'` switch — the room owner's decision, not the player's.
- **`GlobalScoreService.fanOutFromRoomSubmission` early-returns when `normalizeSubmitterUserId` is null** (guest submissions never appear on `/scoreboard`) and takes a **required `source` param, rejecting `'sync'`** (ADR 0016 P2). iScored-synced scores never reach Global (fully visible on room boards); no `iscored:*` synthetic-ID fan-out from `ScoreSyncPoller`. Synced scores are always `engine='unknown'`/`device='unknown'` — no inference, ever (`tournaments.iscored_default_engine`/`_device` are vestigial and unread).

## Score correction (not moderation)

- **`PATCH /:roomId/score-history/:historyId/score` → `ScoreHistoryService.correctScore` changes a score's VALUE in place (v2.149.0).** Three tiers (`requireDiscordUser`, matching the sibling per-row DELETE): super_admin → any row; room_admin → any row in their rooms; **the SUBMITTER → their own row while the card is UNLOCKED** (owner ruling 2026-08-31, reversing admin-only).
- **Two refusals in `src/utils/scoreCorrectionPolicy.ts` (owner ruling 2026-10-25; v2.176.0).** A MACHINE-REPORTED row (`'vpx'` / `'atgames'`) is not editable by ANYONE, admins included (`403 machine_reported`; `correctScore` throws `ScoreNotEditableError`) — a wrong Witness score is deleted, never edited. In a Sanctioned or Limited-attempts tournament the submitter tier is closed (`ownerCorrectionWindow` → `'integrity'`; the board ships `selfCorrectionLocked` so the FE hides the pencil).
- **"Locked" = the game is no longer `ACTIVE`.** `ownerCorrectionWindow` draws the SAME line `isCooldownLocked` draws for submissions and that both admin lock affordances change; do NOT add a `games.locked` column (a second drifting answer). The ACTIVE game is matched by (room, name) AND the row's `submitted_during_tournament_id` must match its tournament, or a table rotating back round re-opens the PREVIOUS run's scores.
- **An admin-verified row is closed to its owner; admins are never blocked.** Ownership is the RAW `submitted_by_user_id`, so a synced row belongs to nobody.
- **What correction moves.** The `community_scores` twin and `global_scores` fan-out move with the row (same exactly-one match rules as `deleteEvent`, shared via `findCommunityScoreTwinId`/`findFannedOutGlobalScoreId` so the paths cannot drift); it recomputes the `submissions` best-per-player row, invalidates + broadcasts. It writes **no tombstone on the corrected row**, deletes no photo, fires **none** of the submit-time side effects (no lobby event, toast, notification, announcement) — bookkeeping, not a new score.
- **Exception: a correction DOWNWARD tombstones the OLD value.** `IScoredApiClient` can submit but not edit/delete, so on a mirrored room `ScoreSyncPoller` would re-import the old higher score and undo the fix; cost: a later genuine score between new and old values is suppressed until an admin clears it.
  - Skipped when the room resolves to NO iScored creds (`roomSyncsToIScored` → `getIScoredCredsForRoom`, the SAME resolution the poller uses, so "switched off" / "partially configured" / "no env fallback" never disagree). A NULL room (a Throwdown) is never synced; a settings-read failure degrades to "it might sync" and KEEPS the tombstone.
  - `deleteEvent`'s tombstone stays UNCONDITIONAL on purpose: the row is gone, so a stray suppression is the cheaper mistake.
- **Correction must sit wherever a score DELETE sits** — adding one to a new surface without the other is the bug that recurred three releases (v2.149.1, v2.150.0, v2.150.1). Shared dialog `components/CorrectScoreModal.tsx`. Surfaces: Game Detail board rows and per-player history rows, the admin Leaderboard's Manage Scores modal, `GameQuickView`'s ranked rows + nested history rows (`QuickViewTarget.gameStatus` exists solely to feed the owner tier's locked check).
  - **Deliberately excluded:** `GlobalGameDetail`'s delete, which acts on `global_scores` via `DELETE /api/me/global-scores/:scoreId` and is one-way by design (a correction would desync the global copy from its room row). Admin surfaces go through `api.*` for the admin token; the public page deliberately uses a raw fetch with the player token so a 401 can't bounce a player to super-admin login.
  - **The board-row pencil is NOT hover-gated**, same as row delete (a pencil only inside the `hasMultiple`-gated history expand left one-score players with no correction).
  - Manage Scores needs `history_id` on `GET /:roomId/leaderboard/:gameId/submissions` — matched on an EXACT score (not "the player's best"), joined by (room, name) since `game_id` is NULL on modern web rows; no match → NULL → no pencil.
- (incident 2026-08-30: a mistyped extra digit on an already-COMPLETED table, where delete would tombstone the wrong value and every submit path requires `games.status = 'ACTIVE'`; CHANGELOG v2.149.0.)

## Per-row score moderation (deletes)

- **Two delete paths, both gated server-side, both emitting `leaderboard:updated` globally on success (v2.9.0).**
- **Admin "wipe player from game"** — `DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId` (`requireAuth + requireRoomAccess`). Drops the `submissions` row + every matching `score_history` row for `(game_room_id, lower(iscored_username), game_id-or-game_name)`. Works on pinned games (LEFT JOIN tournaments + `ownedByRoom` check). Surfaced via `ManageScoresModal` (admin Leaderboard page → "Scores" button per card).
- **Per-row delete (admin or self)** — `DELETE /api/rooms/:roomId/score-history/:historyId` (`requireDiscordUser`). Tiers: super_admin → any row; room_admin → any row in their rooms; player → only rows where `submitted_by_user_id === viewer.discordId`. Accepts `source IN ('tournament','sync','community','vpx','atgames')`. After delete it recomputes the `submissions` row from remaining `score_history` (`ORDER BY score DESC, created_at ASC LIMIT 1`); deletes if none left, else updates `score`+`timestamp` to the new top row. Surfaced as a trash icon on each row in the `GameDetail.tsx` per-player history expand.
- **`deleted_score_suppressions` tombstone (migration 096, ADR 0011).** Without it `ScoreSyncPoller` would re-import a deleted score next cycle. Both delete paths write `(game_id, lower(iscored_username), suppressed_score)` with `MAX(existing, deleted_score)` on conflict; the poller bulk-loads suppressions per game and skips `score <= suppressed_score` before its `> existing.score` check — higher new scores still flow. iScored-side cleanup remains manual.
- **`auto_score_suppressions` — the AUTO-POSTED tombstone (migration 178, v2.156.0, ADR 0024).** `'vpx'`/`'atgames'` rows REPLAY (cabinet re-sends up to 7 days of score files on restart/re-pair; a host may press "Pull scores" repeatedly), so a delete writes a PLAY-scoped tombstone `(source, owner_key, game_key, score, played_at)`.
  - `owner_key` = `submitted_by_user_id` else raw `discord_user_id` (an unlinked `atgames:<id>`); `game_key` = `normalizeGameName`; `played_at` = the play's own time (`score_history.created_at` for these sources), NULL = time unknown (a Global row's `submitted_at` is INGEST time, so a Global delete matches player+game+score alone). NOT room-scoped: a play deleted from a room board must not return via the Global leftover path.
  - **`AutoScoreSuppressionService.isSuppressed` is the ONE predicate.** `ScoreHistoryService.isDuplicate` consults it when given `source`/`ownerKey`/`createdAt` (so the AtGames preview and the real pull agree); `VpxScoreIngestService` checks it before choosing ANY destination (device names + matched room game name + catalogue name); a suppressed VPX replay answers the device `'duplicate'` (no new status), files no observation, fans out nothing.
  - Writers: `deleteEvent`, the admin wipe sweep, the ban content cascade, and `GlobalScoreService.softDelete`/`hardDelete` (inside the service so no caller can forget; `restore` lifts the time-unknown one). `correctScore` is not a writer (it refuses these rows).
  - `recordGlobal` also refuses a play when a SOFT-DELETED `global_scores` row with the same game/player/score exists (covers pre-v2.156.0 cabinet rows written with a NULL source — no tombstone, no backfill).
  - For these two sources `deleteEvent` writes **no** `deleted_score_suppressions` row — they are never pushed to iScored and that table's MAX threshold would swallow unrelated lower synced scores.
  - The key is captured at delete time, so a later link/merge that changes the owner does not carry the tombstone (accepted, not solved — ADR 0024). No FKs — it outlives the rows, rooms and games it describes.

## Pin-to-scoreboard (ADR 0005)

- **`games.tournament_id IS NULL` is the canonical pinned-row signal.** `games.game_room_id` is denormalized (equals `tournament.game_room_id` for tournament rows; set explicitly for pins). Unique partial index `idx_games_pinned_unique ON games(game_room_id, LOWER(name)) WHERE tournament_id IS NULL` prevents double-pin per room.
- **Cascade on unpin is application-level, NOT `ON DELETE CASCADE`:** `UPDATE submissions SET game_id = NULL` (same for `score_history` + `global_scores.origin_game_id`) before DELETE — keeps history.

## Platform stratification (ADR 0006, 0009, 0016)

- **`platform` is required at the API boundary** on `submissions`/`score_history`/`community_scores`/`global_scores` (column nullable in SQL for legacy rows).
- **Tournament rules are two-AXIS (ADR 0016 P2):** `{ engines: {required, excluded}, devices: {required, excluded}, restrictedText? }`, axes evaluated independently and AND-combined. Within each axis ADR 0009's orthogonal semantics hold:
  - **`required` ("Must be available on") → game-level eligibility ONLY.** `passesplatformRules(gamePlatforms, rules)` checks the game has at least one platform denoting a required engine AND one denoting a required device; it does NOT restrict which platforms can submit.
  - **`excluded` ("Not allowed on") → submission-level filter ONLY.** `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` strips platforms excluded by EITHER axis (required intentionally not applied); it does NOT restrict eligibility.
- **Every runtime read of `tournaments.platform_rules` goes through `parseTournamentRules` (`src/utils/platformRules.ts`)** — 10 routed sites; malformed JSON logs a WARN naming the tournament then degrades to empty rules. Never hand-roll a `JSON.parse` of this column (the 3 migration parses — 101/083/089 — are deliberately raw frozen transforms).
  - It is also the read-time shim: ~200 rooms still store the flat legacy shape (`{required, excluded}` over legacy platform ids), lifted via `LEGACY_PLATFORM_MAP` (both-axis ids like `vpxs` → engine `vpx` + device `atgames` restrict BOTH; unknown room-invented tags kept verbatim on the engine axis).
  - Writes always emit the two-axis shape (Zod preprocess + `TournamentService.create/update` both normalize); stored rows upgrade only when an admin re-saves.
  - Example: WHO dunnit on `[vpx, vpxs, real, fx, fx_vr, atgames]` with legacy Must=`[atgames]` lifts to `devices.required=[atgames]`; the game qualifies and the picker shows all 6 platforms.
- **Submit platforms.** `SubmissionSheet` reads `GET /api/submit/platforms` → `{ platforms, submittable, tournamentRules }`. One platform → read-only chip; 2+ → required dropdown. Chip caption: `fullGamePlatforms.length > 1` → "(only platform allowed by this tournament)" else "(only platform for this game)". Discord `/submit-score` auto-fills when 1, prompts when 2+. Server re-validates at every submit handler (`ensurePlatformAllowed`, also strict-excluded-only). `/leaderboard/:gameId?platform=X` returns `distinctPlatforms[]` for the GameDetail tab strip.
- **When adding/changing a platform:** update `src/utils/platformMapping.ts` AND mirror to `admin-ui/src/lib/platforms.ts` (FE has its own copy of `CANONICAL_PLATFORMS` + `PLATFORM_ALIASES`). Forgetting causes silent FE/BE drift.
