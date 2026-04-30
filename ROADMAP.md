# ArcAid — Roadmap

> See SPRINT_STATUS.md for live progress; CHANGELOG.md for shipped versions.

---

## Open Followups

- **iScored per-score delete (true cascade)** — when admins/players delete a score in ArcAid, the iScored side keeps the entry; today we suppress re-import via `deleted_score_suppressions`, but iScored's public page still shows the deleted score. No documented REST endpoint for per-score delete in `IScoredApiClient`; `IScoredClient` (Playwright) only supports whole-game delete. Investigation needed: (a) does iScored's admin UI expose a "remove this player's score" action, and (b) what's the DOM/flow to script it via Playwright. Once known, add `IScoredClient.deletePlayerScore(gameId, username)` and call from both delete endpoints. Also worth: an admin UI to clear a row from `deleted_score_suppressions` in case a deletion needs to be undone.
- **Style overlay re-keying** — `game_room_game_library` survived the v2.6.0 step-2 cleanup because it still carries the per-room style overlay (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`). Re-key onto a new `room_game_style_overlay (game_room_id, global_game_id, …)` table, migrate data, then drop the bridge table. Update callers in `gameCreation.ts`, `TournamentEngine`, `StyleCatalogueService`, `GameLibraryService.{set,get}RoomGameStyle`, and the StylePicker FE.
- **Ratings re-keying** — `game_ratings` is keyed on `(game_name, user_id)`. Should re-key on `(global_game_id, user_id)` for consistency post-step-2. Plan §2h.
- **ScoreSyncPoller adaptive backoff** — v2.7.0 added per-account error suppression so logs aren't spammed during iScored outages, but the poller still hits iScored every 5s during an outage. Add a "bump interval to 60s after 5 consecutive failures, restore on first success" mode to cut wasted requests by ~12x during sustained outages.
- **Force-recreate fetch agent on N consecutive ScoreSyncPoller failures** — the 14-min outage on 2026-04-27 was cleared by a container restart, suggesting an undici keep-alive connection got stuck. Adding a one-line agent reset on Nth consecutive failure could self-heal without restart.
- **Studio attribution from AtGames sheet** — column A fill color (Green=AtGames, Red=FarSight, Yellow=Magic Pixel, Blue=Zen Studios) tells which studio ported each game to AtGames. Skipped in v2.7.0 per user direction; revisit if a "filter by porter studio" use case emerges. HTML export path is feasible (~50 lines, no new deps).
- **Tunable iScored API timeout** — currently hardcoded 15s in `IScoredApiClient.getAllScores`. Promote to a Global Settings field if 15s turns out too aggressive.
- **Notification coalescing** — batch 3+ same-type Discord push notifications within 5 minutes into a summary DM. Deferred from Lobby & Social Phase 5 polish.
- **`/unmap-user` Discord admin command** — companion to the now-additive `/map-user` (v2.8.0). Removes a single iScored alias from a Discord user without touching their other aliases. Today the only way to remove an alias is direct DB edit. Small command, ~30 lines.
- **One-shot DM at merge** — when a room admin merges an anonymous nickname into a Discord user, DM the user: "An admin in {room} has linked the iScored name '{nick}' to your account. Future scores under this name will count for you. Set your display name at /account/settings." Opt-out via `/arcaid-notifications`. Deferred from v2.8.0 — single helper call from `MergeService.recordMerge` post-commit.
- **Pure-iScored-name claim flow** — the `/admin/identity` merge UI requires an `anonymous_identities` row, so a name that's only ever submitted directly on iScored (never seen by ArcAid) cannot be claimed via the merge tool. Add an admin form: "Claim an iScored name for a Discord user" — pre-checks `user_mappings` collisions, INSERTs the alias row, kicks off a `fetchAvatarHash` for the target, no merge transaction needed.
- **Admin display-name override** — super-admin-only ability to set/clear another user's `user_profiles.display_name` (e.g. for moderation). Audit-logged via existing `auditMiddleware`.
- **Drop `user_mappings.avatar_hash` column** — kept for one release after the v2.8.0 split (avatar moved to `user_profiles.avatar_hash`). Verify no readers, then drop in a future migration.
- **`MergeService` mapping race-condition pre-check** — the `MAPPING_CONFLICT` check inside `recordMerge` runs outside the transaction so the admin gets a clean error. A different admin merging the same name into a different user between the check and the INSERT could still hit the UNIQUE constraint; the txn rollback is correct but the error message would be cryptic. Tighten by re-checking inside the txn (small UPSERT pattern adjustment).

---

## Architecture Decisions

Load-bearing technical and product decisions are tracked in [`docs/decisions/`](docs/decisions/README.md). Each ADR captures the context, the choice, and the alternatives considered. Write a new ADR when a decision locks in a data shape, auth pattern, or external integration that future code will assume.

---

## Deferred

- **Discord Bot Multi-Room (Phase 5)** — single bot serving multiple guilds with per-room command scoping. Resolve `interaction.guildId` → game room in all commands; filter queries by room in all command handlers; deploy commands to all guilds with game rooms. Not blocking — current setup serves one room per Discord guild adequately.

---

## Future

### Player Self-Service + Moderation

Three related features that together tighten up score/comment integrity and give admins a proper moderation surface. All gated behind Discord-authenticated identity — anonymous users don't get self-service edit/delete (they have no durable identity to verify), don't get to leave comments/tips, and don't need to be "banned" because the claim system auto-suffixes them anyway.

**A. Self-edit / self-delete scores**

Logged-in players can correct or remove their own submissions across every surface where their score appears.

- [ ] **Delete own score** — button/icon on each score row where `submitted_by_user_id === viewer's Discord ID`. Applies to `submissions`, `community_scores`, `score_history`, AND the fanned-out `global_scores` row for the same event. Soft-delete (set `deleted_at` / `orphaned_at`) rather than hard-delete so audit trail survives.
- [ ] **Edit own score value** — modal with new score input + photo upload. Gated on ownership. Writes a new `score_history` row for the revision, updates the canonical `submissions` / `community_scores` row to the new value, re-fans to `global_scores` (delete old global row + insert new). Photo required if the game's room requires photos on new submits.
- [ ] **Scope consistency** — deleting/editing a room score automatically mirrors to the global row (via `submitted_from_room_id` + `submitted_during_tournament_id` linkage). Deleting a pure global submission only affects `global_scores`.
- [ ] **Self-actions logged to `audit_log`** with actor, target row id, old/new values. Room admin + super-admin can see via the activity log.
- [ ] **Rate limit** — e.g., 10 self-edits per user per hour to prevent leaderboard thrashing.
- [ ] **UX** — edit/delete controls on: Tournament card rows (expanded view), Game Detail leaderboard rows, Community tab rows, Global Scoreboard rows, Global Game Detail rows. Hidden for non-owners.

Open design question: **should edit be allowed to raise a score or only lower it?** Raising is abusable without photo-proof verification. Safe default: edits require a new photo if photos are required for submission in that room; otherwise any value is allowed but all edits are logged.

**B. Comments/tips require Discord login**

Currently `POST /:roomId/comments/:gameName` and the global `/global/games/:id/comments` both accept anonymous posts. Change the gate.

- [ ] **Server** — add `requireDiscordUser` middleware to comment POST endpoints (room + global). Reject 401 without a valid player token. Existing anon comments stay visible but read-only.
- [ ] **Client** — comment compose UI hides or replaces with "Log in to leave a tip" CTA when viewer isn't Discord-authenticated. Same for rating.
- [ ] **Self-edit / self-delete comments** — same ownership rule as scores. Logged-in users see edit + delete controls on their own comments on Room Game Detail and Global Game Detail. Soft-delete (set `deleted_at`), audit-logged.
- [ ] **Legacy anon comments** — kept as-is, visible but no owner controls. Admin can still delete them from the mod surface.

**C. Admin ban — logged-in users**

`user_bans` table already exists (used by `GlobalScoreService.isBanned` to short-circuit global submissions). Build out the full moderation workflow around it.

- [ ] **Admin ban UI** — new page (or section in existing admin activity log): `/admin/bans` (super-admin, global) and `/:slug/admin/bans` (room-admin, room-scoped). List current bans, add a ban (Discord user ID + reason + optional expiry), lift a ban.
- [ ] **Ban scope** — two tiers: (1) **room ban** — user can't submit/comment in that room, existing content orphaned; (2) **global ban** — user can't submit anywhere, all their content hidden from Global Scoreboard. Super-admins can set either; room admins can only set room-level.
- [ ] **Enforcement points** — extend the existing `isBanned()` check from global submissions only to room submissions, comment POSTs, rating POSTs, friend POSTs. Consistent 403 response with ban reason (if admin chose to surface it).
- [ ] **Ban → content cascade** — decide per ban whether the user's existing scores + comments are: (a) hidden from public views (soft), (b) deleted (hard), or (c) left visible. Default to (a) soft-hide for reversibility. `orphaned_at` column already exists on `submissions` / `community_scores` / `score_history` for this pattern.
- [ ] **Ban → Discord notification** — optional DM to the banned user with reason, scope, and expiry. Opt-out respected if they've turned off Discord notifications, but bans should probably override that since it's a moderation action.
- [ ] **Audit** — every ban / unban logged to `audit_log` with actor, target, reason, scope.

**Shared plumbing across A/B/C:**
- Need a new `/api/me/scores` endpoint returning the viewer's own recent submissions across all score tables (paginated) so the UI can show a "My scores" management view.
- Need a new `/api/me/comments` endpoint, same pattern.
- Ownership check helper: `requireOwnsScore(scoreId)` / `requireOwnsComment(commentId)` middleware that reads the row's `submitted_by_user_id` / `user_id` and compares to `req.user.discordId`. Super-admins bypass.

**Rough sizing:** A is ~2 days (lots of surface area — scores live in 4 tables and 6+ UI components). B is ~0.5 days (middleware flip + compose-UI gate). C is ~1-1.5 days depending on whether the ban→cascade hide logic is implemented or deferred. All three should probably ship behind a `FEATURE_PLAYER_SELF_SERVICE=true` settings flag initially so it can be rolled back without data loss.

### Score Photo Persistence

Score proof photos are stored locally on disk (`data/score-photos/`). As the Global Scoreboard becomes the primary submission path (no iScored dependency), reliable photo storage is critical. Many rooms will not use iScored integration at all.

Current gaps:
- Direct global submissions store photos locally — works, but no redundancy or CDN
- Legacy iScored-synced scores reference external CDN URLs that may expire
- Room-originated photos referenced by global scores may 404 if the file wasn't persisted during fan-out
- No backup/replication strategy for photo files (DB is backed up, photos are not)

Options to evaluate:
- [ ] S3/object storage for all score photos (persistent, CDN-backed, scales independently)
- [ ] Serve missing photos gracefully (placeholder image instead of 404)
- [ ] Include `data/score-photos/` in backup volume (quick win)
- [ ] Download and persist iScored CDN photos during sync (for rooms still using iScored)
- [ ] Copy room photos to global photo dir during fan-out

### Phantom anon-claim cleanup — manual runbook (not automation)

First-claim-wins is the policy: whoever uses a name first in a room owns it. **We don't automate "Discord trumps anon" name transfers** — that's the fraud surface we explicitly rejected when the design was agreed. If a Discord user and a legit-different-human anon share a display name, the anon (who got there first) keeps it, the Discord user gets `Name_2`.

The one exception is a phantom claim — an anon row that *is actually the same human* as the Discord user who later tries to claim the name, typically from the pre-v2.2.5 window when `conditionalRequireDiscordUser` was dropping Bearer tokens in guest-allowed rooms. Those should be cleaned up case-by-case, never automated.

**Procedure:**

1. Verify the claim is a phantom. Needs at least two of:
   - The anon claim's `claimed_at` falls inside a known middleware-bug window (pre-v2.2.5 deploy, or after any future auth-middleware regression).
   - The user confirms it was their browser session.
   - The `anon_token` matches a localStorage UUID the user can produce.
2. Identify the row precisely:
   ```sql
   SELECT anon_token, room_id, display_name, claimed_at
     FROM anon_room_claims
    WHERE LOWER(display_name) = LOWER('<name>')
      AND room_id = '<room-uuid>';
   ```
3. Delete narrow, keyed on `anon_token` + `room_id` + `display_name`:
   ```sql
   DELETE FROM anon_room_claims
    WHERE anon_token = '<token>'
      AND room_id = '<room-uuid>'
      AND LOWER(display_name) = LOWER('<name>');
   ```
4. Log the deletion in `audit_log` with a reason so there's a trail (or document in ops notes if the table doesn't accept ad-hoc reasons).

**Do not:**
- Run the broad `DELETE ... WHERE name IN (SELECT iscored_username FROM user_mappings)` form. It can't distinguish phantom from legit and violates first-claim-wins.
- Surface a self-serve "claim this name" button in the UI — same fraud surface.
- Build a background job that auto-cleans phantoms. Needs a human to verify the claim is actually the same user.

The existing admin merge tool at `/:slug/admin/identity` is the right place for real cross-identity reconciliation when it turns out two claims should collapse into one.

### Game Library filters — Platform / Manufacturer / Type / etc.

> **Status (v2.7.0):** smart-search bar shipped covers many of the cases this section originally addressed (substring match across name/manufacturer/year/designers/themes/table_authors/aliases/platforms/room_tags + inline year-range syntax `2001-2020`). The dedicated multi-select filter panel below was deferred when the manufacturer chip-row was reverted in favor of search-first UX. Items below remain on the table if a structured filter-panel UI is later wanted.

The game library and global catalogue are already searchable by name across four surfaces: room admin (`/:slug/admin/library`), global catalogue (`/catalogue`), freeplay picker (`/:slug/freeplay`), and super-admin master library. Add a filter panel so users can narrow by metadata fields without typing.

- [ ] **Filter fields (MVP):**
  - **Platform** — the canonical platform IDs from `src/utils/platformMapping.ts` (VPX, VPXS, VPX-VR, IRL, AtGames, Scorbit, etc.). Multi-select. Already stored as JSON array on `game_library.platforms` / `global_games.platforms`.
  - **Manufacturer** — Stern, Bally, Williams, Gottlieb, Data East, Sega, etc. Stored on `global_games.manufacturer`; usually missing on pure room entries (falls back to catalogue lookup via `global_game_id`).
  - **Type** — Real pinball (EM / SS / modern), Virtual pinball, Video game, Arcade cabinet. Derivable from platform + year + catalogue category; may need a dedicated column if the derivation gets ambiguous.
  - **Year** — range slider or decade dropdown.
  - **Theme / Tags** — adventure, sci-fi, supernatural, licensed (IP tags from VPS/OPDB imports). Multi-select.
  - **Player count** — 1P / 2P / 4P (already surfaced on Global Game Detail).
- [ ] **Filter UI:** collapsible sidebar on desktop, bottom-sheet on mobile. Filter chips above the grid show active filters with `×` to remove. Clears-all link when any filter is active.
- [ ] **URL state** — filters serialize to query params (`?platform=vpx,vpxs&manufacturer=stern&year=1990-2000`) so shares and deep-links work.
- [ ] **Combined with search** — existing name-search input stays; filters narrow the result set server-side, search is applied on top.
- [ ] **API surface** — extend the existing list endpoints (`GET /:roomId/game_library`, `GET /global/catalogue`, `GET /admin/master-library`) to accept the filter params. Single query with `WHERE` clauses + JSON array intersection for `platforms`.
- [ ] **Performance** — all filter columns need indexes on `global_games` (platforms is JSON so an index helps but doesn't fully accelerate). Consider a materialized `global_games_facets` view or extracting filter keys into indexed columns if the catalogue grows past ~10k entries.
- [ ] **Filter facet counts** — next to each filter option show the number of matching games (e.g. "Stern (47)", "Bally (23)"). Requires a separate aggregation query. Can ship without initially; add once the UI is validated.

Open questions:
- **Type derivation**: is "Real pinball" vs "Virtual pinball" vs "Video game" stored anywhere already, or do we need a new column? If new, seed from a platform→type mapping table.
- **Room-local vs global**: should room-admin library filters be restricted to what the room has (reflecting its curated list) or show the full global catalogue with availability indicators? MVP: restricted to room's actual library; add "browse global" as a secondary pivot later.

Rough sizing: 1-2 days depending on whether Type needs a new column + migration. Facet counts add another half-day.

### Comments & Tips — bidirectional view (Option 2)

Comments/tips and ratings currently live in two parallel stores: `game_comments`/`game_ratings` (room-scoped, keyed on `(room_id, game_name)`, anon allowed) and `global_game_comments`/`global_game_ratings` (keyed on `global_game_id`, Discord required). A tip written on the Room Game Detail never reaches the Global Game Detail for the same game, and vice versa.

Ship a union-view model that keeps both stores but surfaces cross-room content where appropriate:

- [ ] Comment compose UI gains a "Share globally" checkbox. Defaults on for Discord-authed users (writes to both tables); anon comments stay room-only.
- [ ] Room Game Detail renders local + global comments together, tagged by origin (e.g., small "Globally" badge on shared comments, room logo on room-only). Add a `?scope=room|global|both` filter or tab.
- [ ] Global Game Detail adds a "From rooms" section or similar so room-shared tips are discoverable cross-community.
- [ ] **Ratings:** probably fully unify for any game with a `global_game_id` — a star is a star. Room-only games (no global mapping) keep their ratings local.
- [ ] Migration / backfill decision: do we one-shot promote existing room comments with Discord-authored authors into `global_game_comments`, or leave history as-is?

Rough scope: half a day of focused work. Needs a design pass on the compose UX (where exactly the checkbox lives, default state per auth state, how to handle room games without a global mapping).

### iScored Sync Hardening

Cooldown enforcement gaps identified in v2.2.0 review. Evaluate and address in a future sprint.

- [ ] **Cooldown bypass via `/sync-state`** — when an admin manually creates a game on iScored tagged `DG` / `WG-VPXS` / `WG-VR` / `MG`, the next `/sync-state` creates a local `games` row set to ACTIVE with no `GAME_ELIGIBILITY_DAYS` / `last_played` check (`src/discord/commands/syncstate.ts:45-65`). The game goes live in ArcAid even if `game_library` says it's still in cooldown. Cooldown is only enforced by `runMaintenance()`, `autoPickAndActivate()`, and the web `/pick-game` path — not by sync. Decide: (a) treat sync as admin-override and document, (b) refuse to create the local row when cooldown applies, or (c) create it as LOCKED so it's recorded but doesn't surface on scoreboards. Option (c) preserves iScored-is-source-of-truth while respecting cooldown.
- [ ] **Duplicate active games when sync runs with an active DG game present** — related to above. Sync doesn't check `max_active_games` before marking a discovered game ACTIVE, so two DG games can be ACTIVE simultaneously until the next maintenance run rotates one out.

### Ops / Infrastructure

- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
- [ ] Super-admin dashboard server metrics (CPU, memory, I/O, container stats)
- [ ] High availability / multi-container — see notes below

#### High Availability Notes

Current constraints: SQLite (single-writer), singleton engine classes (in-memory state), Playwright persistent sessions (local disk).

| Approach | Effort | Notes |
|----------|--------|-------|
| Active-passive failover | Low | 2 containers, 1 active. Docker restart policy + health checks. Shared volume for SQLite. |
| Read replicas (Litestream) | Medium | SQLite WAL mode + Litestream replication. One writer, N readers. Public scoreboard benefits most. |
| Separate concerns | Medium | Stateless API container (scales horizontally) + singleton engine/scheduler container. Requires DB change. |
| Migrate to PostgreSQL | High | True multi-container with connection pooling. Rewrite all raw SQL + migrations. Biggest payoff, largest effort. |

**Quick wins:** Docker `restart: always` + health check, Litestream for continuous S3 backups, reverse proxy (nginx/Caddy) for SSL/rate limiting, CDN for static assets. **Recommendation:** Start with active-passive + Litestream, migrate to PostgreSQL when scale demands it.

### Platform Integrations

- [ ] IFPA (International Flipper Pinball Association) — submit tournament results to official world rankings via API
- [ ] Matchplay.events — interoperability with the most-used competitive pinball tournament platform
- [ ] Scorbit — automated score capture from connected physical pinball machines (eliminates manual submission for IRL)
- [ ] Stern Insider Connected — pull scores from Stern connected machines
- [ ] Guilded / Revolt — alternative community platform support beyond Discord
