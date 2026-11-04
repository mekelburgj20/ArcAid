---
paths:
  - "src/engine/TournamentEngine.ts"
  - "src/engine/Scheduler.ts"
  - "src/engine/TimeoutManager.ts"
  - "src/services/Tournament*.ts"
  - "src/services/PickQueue*.ts"
  - "src/services/PickAlert*.ts"
  - "src/services/QueueLow*.ts"
  - "src/services/Ranking*.ts"
  - "src/services/Dashboard*.ts"
  - "src/services/MaintenanceRun*.ts"
  - "src/services/OpsAlert*.ts"
  - "src/services/GameRoom*.ts"
  - "src/services/JoinRequest*.ts"
  - "src/services/RoomAccess*.ts"
  - "src/services/RoomMembership*.ts"
  - "src/services/RoomRoster*.ts"
  - "src/services/RotationAudit*.ts"
  - "src/services/CardOrder*.ts"
  - "src/utils/roomTimezone.ts"
  - "src/utils/queueOrder.ts"
  - "src/utils/cronUtils.ts"
  - "src/utils/discordRoomFilter.ts"
  - "src/utils/discordWriteTarget.ts"
  - "src/api/ogMeta.ts"
  - "admin-ui/src/components/TournamentForm.tsx"
  - "admin-ui/src/components/RotationLogPanel.tsx"
  - "admin-ui/src/components/ShareButton.tsx"
  - "admin-ui/src/lib/timezone.ts"
  - "admin-ui/src/hooks/useRoomTimezone.ts"
---
# Rooms, membership, rotation engine, pick queue, rankings, ops — rules

Loads when you touch room membership/join policy, the tournament rotation engine, the pick queue, ranking groups, room timezone, or ops/health endpoints. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## Membership, privacy, join policy
- **Login is mandatory for web score submissions** (v2.79.0). The per-room `REQUIRE_DISCORD_LOGIN` setting and `conditionalRequireDiscordUser` middleware are retired (migration 138 deleted stored rows; `OrphanService` deleted; existing `orphaned_at` rows and every `orphaned_at IS NULL` filter stay untouched). Comments/tips stay guest-open via `optionalDiscordUser`.
- **Three orthogonal room settings:** `ROOM_LISTED`, `JOIN_POLICY`, `AUTO_APPROVE_GUILD_MEMBERS`.
  - `ROOM_LISTED` (default on): `'false'` drops the room from `GET /api/rooms` only; direct URL, portal and member `/api/me/rooms` visibility are unaffected. **It is the ONE listing switch** (v2.203.1): `game_rooms.is_public` mirrors it, written by the settings save, room create and the super-admin edit through `GameRoomService`. A writer that sets one without the other is the arcaid_witness_demo "toggle on, room hidden" bug reborn.
  - `AUTO_APPROVE_GUILD_MEMBERS`: approval rooms auto-approve join requests from linked-guild members via `JoinRequestService.tryAutoApprove` — identity-link-aware, bot-side `isMemberOfGuild` check, any uncertainty degrades to the manual queue, never auto-deny; audit row `resolved_by='auto:guild'`.
- **`JOIN_POLICY` has three values** (v2.213.0): `open` · `approval` (invisible to non-members; join through the admin queue) · `discord_role` ("open to view, Discord role to join").
  - `discord_role` VIEWS exactly like `open`: every view/listing reader (`roomVisibilityGate`, `canJoinRoomChannel`, OG meta, the public room list, the lobby feed gate, `RoomRosterService`'s mode) tests `=== 'approval'` only — keep it that way.
  - Joining reads `DISCORD_JOIN_ROLE_IDS` (`game_room_settings`, JSON array, parsed only by `parseJoinRoleIds`). `JoinRequestService.joinByDiscordRole` resolves the user's Discord id through the identity links (none → `DISCORD_LINK_REQUIRED`), asks `DiscordClient.getMemberRoleIds` (null = UNKNOWN): role held → member; fetched without one → `ROLE_REQUIRED` with role names; unknown → a pending `join_requests` row (never an auto-deny).
  - On an `approval` room with `AUTO_APPROVE_GUILD_MEMBERS='true'` a non-empty role list narrows `tryAutoApprove` to role holders.
  - `discordRoomFilter.ts` / `discordWriteTarget.ts` exclude `approval` only, so a role room stays Discord-reachable.
- **Writes need membership outside `open` rooms.** `RoomAccessService.checkMayWrite(roomId, userId, token?)` is the ONE gate (403 `JOIN_REQUIRED`), called before any write by the three web submit routes, web `/pick-game`, and Discord `/submit-score` + `/pick-game`. A new manual write path in a room needs the call too (comments/tips stay guest-open; a NULL room is never gated).

## Room timezone
- **Room default timezone** (v2.164.0). `game_room_settings.ROOM_TIMEZONE` (Room Settings → Game Room) is the zone every admin time control DEFAULTS to and is labelled with; a saved tournament's own `cadence.timezone` / cleanup `rule.timezone` stays the override.
- **`src/utils/roomTimezone.ts` is the ONE precedence chain** (`resolveTimezone`: object zone → `ROOM_TIMEZONE` → `BOT_TIMEZONE` → `America/Chicago`). Never hand-copy `process.env.BOT_TIMEZONE || 'America/Chicago'` at a site that interprets a tournament time; batch `roomTimezonesFor` inside loops (`s24-efficiency.test.ts` counts the queries).
- Housekeeping crons (backups, prunes, the per-minute tickers) deliberately stay on the server zone.
- FE mirror: `admin-ui/src/lib/timezone.ts` + `hooks/useRoomTimezone.ts` (`defaultFormStateFor(tz)` seeds the create form; `parseCadence`/`tournamentToFormState` take the room zone as their fallback; `formatInZone` renders Game States / Rotation Log stamps in the room zone with `zoneLabel`). No migration, no backfill: an unset room behaves exactly as before.

## Rotation Log
- **Rows store RAW player ids; names resolve at READ** (v2.157.1). `rotation_events.actor` (`player:<id>` / `admin:<id>`), `queue_owner` and the id-bearing `details` keys are snowflakes on purpose (identity-stable, same doctrine as `leaderboard_cache`). `RotationAuditService.list` resolves every id the page mentions into a `names` map (display_name → username → earliest alias, batched) and `RotationLogPanel` renders through `nameOf`/`actorLabel`, falling back to the raw id.
- **A new `details` key that holds a player id must be added to `IDENTITY_DETAIL_KEYS`** or it renders as a snowflake — don't fix it by baking a label into the row instead.

## Pick queue
- **Game queue:** explicit `queue_order` column, per player per tournament, **newest-first** (owner ruling 2026-08-27, v2.143.0): `queueGame` inserts at position 1 and shifts the player's other rows down. Every queue path routes through it, so web/Discord/admin-on-behalf agree.
- **Capped at `PICK_QUEUE_MAX`** (`src/services/PickQueueService.ts`, 30) — import it, never hardcode the number; the FE gets it as `queueMax` on `/pick-status` and the admin on-behalf queue responses.
- **Queue hold model** (v2.126.0): a queued pick inside its cooldown when the engine reaches it is **stamped `games.queue_held_at`, never deleted** (both walkers — `TournamentEngine.nextEligibleQueuedFor` and the extra-slot fill loop in `runMaintenanceWork`). A held pick activates the instant its cooldown clears.
- **`src/utils/queueOrder.ts`'s `queueOrderSql(alias?)` / `QUEUE_ORDER_SQL` is the ONE ordering fragment:** held rows first (oldest hold wins), then `queue_order ASC` (NULLs first, which is how `[Pending Pick]` placeholders keep their front position), then `rowid`. **Every reader must import it** (`/pick-status`, `getPlayerQueue`, `/view-queue`, the admin on-behalf queue, `PickAlertService`, both walkers). A hand-copied `ORDER BY queue_order ASC, rowid ASC` is a bug: the page would show one order and the engine consume another.
- `queue_held_at` is cleared on promotion alongside `queue_order`; `PUT /queue/reorder` renumbers UNHELD rows only.
- **Compaction and nudges:** every removal/promotion calls `PickQueueService.compactQueue(tournamentId, pickerId)` so stored positions stay a gapless 1..N. The three ENGINE consumption sites additionally fire `QueueLowNudgeService.maybeNudge` (the opt-in `queueLow` notification, deduped in `queue_low_nudges`); a player's own delete deliberately does not.
- **Auto-pick** (v2.219.0, ADR 0036): both auto-pick sites (`TournamentEngine.autoPickAndActivate`, `TimeoutManager.fallbackToAutoSelection`) keep their catalogue filters and hand the survivors to ONE ranker, `rankAutoPick` (`src/utils/autoPickRanking.ts`, pure), fed by `AutoPickSignalService.load`. Constants live in the util — never literals at a site.
  - **Tier 1, ranked choice:** each player's QUEUED rows walked in `queueOrderSql` order; rows not eligible (cooldown-held, ACTIVE, off-rules) are SKIPPED so the next row moves up; a repeat counts once; 1st/2nd/3rd score 3/2/1, summed across players. Top total wins deterministically (tie → Tier 2 weight → earliest `rowid`).
  - **Consumption + credit:** every contributing QUEUED row of the pick is deleted, each affected queue gets `compactQueue` + `maybeNudge`; the post says "from the queues of A, B and C" via `resolveUserLabels` ("a member" when unlabelled, no pings). Audit: `details.autoPick` (`contributors` resolved by `RotationAuditService.resolveNames`).
  - **Tier 2, weighted roam** (no queue scored): `(5×siteMean + sum)/(5 + count)` over per-user averages × `(1 + ln(1 + distinct room players))`. **Benched:** a room member's average ≤ 2 unless ≥ 3 raters average ≥ 3.0; or, from 10 rounds, the table's latest run drew < half the median turnout (run-window counted, never `score_history.game_id`). Tier 3 = the benched, only when Tier 2 is empty.
- **Per-slot picker dedup** (v2.9.0): placeholder dedup is keyed `(tournament_id, picker_discord_id, won_game_id)` (it was `(tournament_id, picker_discord_id)`, which collapsed multi-slot wins, e.g. WG-VPXS max=2). DM and channel embed both name the won game. `won_game_id` is not an FK with cascade — admin removing a completed game leaves the placeholder dangling, but `GET /:roomId/pick-status` LEFT JOINs so `won_game_name` falls null gracefully and the FE clause is conditional.

## Rotation engine
- **Rotation guards:** `processSlotMaintenance()` checks `max_active_games` and existing `[Pending Pick]` rows before creating picker slots. `TimeoutManager.fallbackToAutoSelection()` includes orphan cleanup.
- **Cleanup-race fix** (v2.9.0): Wed `0 22 * * *` daily maintenance + `0 22 * * 3` scheduled cleanup fire at the same instant; the cleanup query used to run before maintenance had completed today's active game and missed it. `runMaintenanceWork` now runs cleanup inline at the end of the slot loop when `cleanupRule.mode === 'scheduled'` AND the cleanup cron's `min/hour/dom/mon/dow` would all match right now in its timezone (`cleanupCronMatchesNow` helper). The separate cleanup cron stays registered and fires idempotently.

## Rankings
- **Ranking-group cache watermark** (v2.10.1, ADR 0013): `ranking_groups_cache` self-invalidates via a fingerprint over indexed columns — `(eligible_games_count, score_count, score_sum, MAX(end_date), MAX(start_date))` for the group's tournaments. `RankingService.getRankings` recomputes the watermark on every read; a mismatch with the stored snapshot triggers silent recompute.
- **No mutation code path needs to call `RankingService.invalidate*()`** for score / game-status changes — the data tells us when it's stale. The manual "Recompute" admin button is a diagnostic escape hatch, not load-bearing. `RankingService.update()` (config changes, not data changes) is the one path that still calls `invalidate()` directly.

## Room-admin observability and ops
- **`GET /:roomId/admin/health` aggregates four things:**
  1. Discord gateway readiness + guild membership via `getDiscordClient()?.isReady()` / `.isInGuild(guildId)`. **The live `DiscordClient` is reachable via the module-level `getDiscordClient()` accessor** (set in its constructor); "bot online" checks (`DashboardService`, `/api/status`) must use it, not env-var presence.
  2. `ScoreSyncPoller.getStatus()` — global + per-account (`accountHealth` map) last-success / last-error timestamps + consecutive-failure counts.
  3. Per-tournament last run from **`maintenance_runs` (migration 106)** — `runMaintenance()` records one row (`success` / `skipped` / `error` + summary + duration) for every cron *and* forced run via `MaintenanceRunService`; append-only, **no FK** (an audit log that outlives its tournament, like `games.tournament_id`).
  4. `getVersionInfo()`.
- **Force Maintenance** (`POST .../game-states/force-maintenance`) **awaits** the run and returns the real outcome.
- **`OpsAlertService.sendOperatorAlert`** DMs a super-admin after `OPS_ALERT_FAIL_THRESHOLD` (5) consecutive poller failures for one account, debounced once-per-outage and re-armed on recovery. **Ships inert** behind global settings `OPS_ALERT_ENABLED` + `OPS_ALERT_DISCORD_USER_ID` (both unseeded → off; not encrypted — a user ID isn't a secret).
- **App version:** `GET /api/version` → `{version, commit, builtAt}` (version from root `package.json` via `npm_package_version`; `commit`/`builtAt` from `APP_GIT_SHA`/`APP_BUILT_AT` env baked by `deploy.yml` `GIT_SHA`/`BUILT_AT` build-args in the `Dockerfile` prod stage) — **NOT** the SW `CACHE_NAME`.
- **OG link-preview meta** (v2.24.0): the SPA catch-all in `server.ts` serves `index.html` with `og:*`/`twitter:*` tags injected (via `src/api/ogMeta.ts`) ONLY when the UA matches the curated preview-bot list AND the path is `/:slug/games/:name` or `/:slug/players/:id`. Humans always get the unmodified shell; every failure falls through to it; `OG_META_ENABLED=false` global setting is the kill-switch (default on); bot requests pass through `ogPreviewLimiter` (60/min/IP — the catch-all is outside the `/api` generalLimiter). FE sharing via `components/ShareButton.tsx` (`navigator.share` → clipboard → execCommand fallback chain).
- **Legacy alias URL rewriting:** Express strips the mount path, so `/api/leaderboard`-style aliases must explicitly reconstruct the full `/api/rooms/:roomId/...` path including segment.
- **Background-sync routes** (`/admin/catalogue/sync-opdb`, `/sync-igdb`) validate credentials upfront and return `400` with an actionable message (they used to return `202 started` and throw silently).
