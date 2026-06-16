# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the roadmap and future plans, see ROADMAP.md.

---

## Current Work

### Fresh-agent handoff (read this first)

- **▶ ACTIVE PLAN: execute `tmp/improvement-audit-sprint-plan-v2.md` (25 sprints S0–S24 → public v0.90.0 Beta). Phase 0 (S0–S3) MERGED + deployed (PR #1); node_modules untrack MERGED (PR #2); Phase A / S4 (live scores + viewer rank) MERGED + deployed 2026-06-15 (PR #3); Phase A / S5 (the submit moment) MERGED + deployed 2026-06-15 (PR #22); Phase A / S6 (dethrone loop & notification hygiene) COMPLETE on PR #23 (off main), NOT yet merged — see blocks below. NEXT: S7 (admin data-safety bugs — Phase B).** Standing rule still in force: any sprint touching TournamentEngine/Scheduler/ScoreSyncPoller/TimeoutManager adds regression tests (S2 built the harness). Migration ledger: 102 (S0), 103 (S1), 104 (S3), 105 (S6 — `player_milestones_fired`) consumed; **next free = 106**.
- **Trigger:** the user says **"Resume"** (per `ArcAid/CLAUDE.md` Session Start Checklist). Not "Continue".
- **Current version (internal dev line):** **v2.13.16** (HEAD). The detailed arc log below ends at v2.10.1 — for the v2.11.0–v2.13.16 history see **CHANGELOG.md** (source of truth; not duplicated here). NOTE: the public version reset to **v0.90.0 Beta** happens at the live-beta milestone, not now (see the v2 plan's "Versioning & release strategy" section).

- **Phase 0 — Stabilize foundation (S0–S3) — COMPLETE 2026-06-14, MERGED to main (PR #1) + deployed 2026-06-15 (prod FK pre-flight cleaned 6,830 orphans → 0, `foreign_key_check` clean):**
  - **S0** (`fix(s0)` + `chore(s0)`): SECURITY — `merge-player` unscoped cross-tenant write gated to super_admin (full room-scoping deferred to S7); DATA INTEGRITY — tournament-delete 409 guard + `game_room_id` denormalized onto all 4 TournamentEngine INSERTs + migration **102** backfill; CI — `vitest run` gate added to `deploy.yml`; CVEs — `npm audit fix` 28→8 vulns (remaining 8 = sqlite3 native-build toolchain, need a breaking major, deferred) + Dependabot; version header reconciled.
  - **S1** (`perf(s1)`): migration **103** — 4 indexes on `score_history`/`submissions` incl. a covering index for the ranking watermark (all EXPLAIN-verified); RankingService watermark double-compute fix. DEVIATION: websocket room-scoping deferred to S4 (scoping `emitLeaderboardUpdated` in isolation would deliver to zero clients — no FE joins a `room:` channel until S4's socket wiring).
  - **S2** (`test(s2)` ×2): engine/cron harness — injectable iScored client factory + extracted `ScoreSyncPoller.findLocalGameForIscoredId` + `cleanupCronMatchesNow` clock injection; 3 prod-incident regression tests (v2.10 session contention, v2.7.2 duplicate-DM, v2.9 cron-collision). admin-ui Vitest runner (jsdom + testing-library) + smoke test.
  - **S3** (`feat(s3)`): FK enforcement flip. **`PRAGMA foreign_keys=ON` set AFTER the migration loop**, not at connection-open (066/077/095 are FK-checked rebuilds; a swallowed 077 failure under enforcement would corrupt a legacy DB). Migration **104** — orphan cleanup + `game_room_game_library` rebuild (drops dead `game_library` FK from migration 092, columns preserved via PRAGMA table_info). 4 delete paths fixed (admin remove-game, TournamentService/GameRoomService/GlobalGameService.delete). Audited via a 6-agent workflow that reproduced 4 live breaks. CLAUDE.md Database section updated.
  - **Build/tests:** backend `tsc` clean, **156/156 tests** (19 files), admin-ui `npm run build` + 1 test clean. The whole backend suite now runs under live FK enforcement.
  - **⚠️ Before deploying S3 to prod:** run `PRAGMA foreign_key_check` on a copy of the prod DB to enumerate orphans + confirm migration 104 cleans them. The local dev DB couldn't validate the upgrade path (it predates `schema_migrations` — re-runs migration 068, which fails on an unrelated `room_game_tags` ref; harmless for prod, which has 068 applied).
  - **Follow-ups:** `git rm -r --cached node_modules` = **PR #2 — MERGED 2026-06-15**; still open: a `pull_request`-triggered CI check (the S0 gate only runs on push to `main`); Dependabot PRs #4–#20 (need rebase onto post-S0 deploy.yml + lockfile); `actions/setup-node` Node-20 deprecation → Dependabot #4 bumps to v6.

- **Phase A / S4 — Live scores + viewer rank — COMPLETE + MERGED to main (PR #3) + deployed 2026-06-15:**
  - **Viewer rank** ("Your best — Rank #N"): FE Scoreboard sends the player token (`usePlayerHeaders`) on leaderboard/rankings fetches (was the null admin token); BE `/:roomId/leaderboard` resolves the viewer across `discord_user_id` + ALL aliases (was one arbitrary alias → multi-alias users saw no rank).
  - **Live scores:** new room-scoped `room:<id>` socket channel (`join:room`); `emitScoreNew`/`emitLeaderboardUpdated` room-scoped (also lands the S1-deferred scoping); `emitScoreNew` wired into `LobbyFeedGenerator.onScoreSubmitted` (single chokepoint — poller dedup prevents double-toast); `socket.off` shared-singleton clobbering fixed with handler refs on Scoreboard + admin Leaderboard; kiosk live toast (60s poll kept as backstop).
  - **Tests:** `api-viewer-rank.test.ts` (discord match, multi-alias regression, anon). **159/159**, backend + admin-ui build clean. SW `CACHE_NAME` → v69.
  - **⚠️ NEEDS visual UX pass** (`review-ux` gate): live toast on Scoreboard + the TV-scaled kiosk toast — can't verify headless.

- **Phase A / S5 — The submit moment — COMPLETE 2026-06-15, on PR #5 (`phase-a-s5-submit-moment`, off main), NOT yet merged:**
  - **BE canonical-partition rank helper** (`src/services/ScoreRankService.ts`, NEW): `computeRoomRank`/`computeGlobalRank` return `{rank,totalPlayers,previousBest,gapToNext,gapToFirst}`, best-effort (return an all-null object on error, NEVER fail the already-committed insert). Partition by the canonical `COALESCE(submitted_by_user_id,'iscored:'||LOWER(iscored_username))` (room) / 3-arg global variant — **verified char-for-char against LeaderboardService/GlobalLeaderboardService** so multi-alias users get a rank that agrees with the board. The inline `LobbyFeedGenerator` rank logic (wrong `LOWER(iscored_username)`-only partition) is LEFT UNTOUCHED — its rework belongs to S6. Wired into `CommunityScoreService.submitScore` + `global.ts` POST /global/scores. `scoreRank.test.ts` (7 tests incl. alias-collapse).
  - **FE result card** replaces the 1.2s auto-close toast (`SubmissionSheet.tsx`): persistent "You're #N of M / X behind #1 / new-high-score" card + View-leaderboard link + Done; guest-conversion CTA every 3rd guest submit; mobile keyboard fix (`inputMode='none'` on touch suppresses the OS keyboard so the in-app one drives input) + Shift key on `OnScreenKeyboard`. QR submit (`ScoreSubmit.tsx`) deep-links to `/:slug/games/:name?highlight=<name>`; `GameDetail` consumes `?highlight=` (rings + scrolls the row) and defaults to the leaderboard tab when tournament data exists. `PublicStats` search matches `display_name`. `Picks` guest-login banner with returnPath.
  - **Review fixes (post-workflow, by orchestrator):** (1) null-rank → plain-success fallback (workflow's card rendered "#null of null" when the BE all-null result came back); (2) Done falls back to `onClose` so `PendingSubmissionWatcher` (no `onSubmitted`) still dismisses; (3) `?highlight=` consumption in GameDetail (workflow set the param but never read it). + `SubmitRank.rank/totalPlayers` typed `number|null` to match BE.
  - **Built via an 11-agent workflow** (recon → 6 file-partitioned implementers → integrate → 2 adversarial verify lenses); both partition-verification lenses returned `partitionMatchesLeaderboard: true`. **167/167 backend tests** (21 files), admin-ui build + 2 tests clean. SW `CACHE_NAME` → **v71**.
  - **Pre-existing caveat (out of scope, noted by verify):** `CommunityScoreService.getGameLeaderboard` still groups by `LOWER(iscored_username)` only — the community-only listing can show a different player count than the submit-moment rank for multi-alias users. The rank correctly matches `LeaderboardService.recalculate` (the tournament board).
  - **⚠️ NEEDS visual UX pass** (`review-ux`): the result card, guest CTA, and highlight scroll-into-view — can't verify headless.

- **Phase A / S6 — Dethrone loop & notification hygiene — COMPLETE 2026-06-15, on PR #23 (`phase-a-s6-dethrone-loop`, off main), NOT yet merged:**
  - **Dethrone DM revived** (`LobbyFeedGenerator.ts`): decoupled from the cosmetic `new_high_score` feed toggle (was silently gated by it — a room disabling that feed killed the retention DM); deep-links to the GAME (`/:slug/games/:name`) not the room root; includes the margin ("beating you by X" / "tying your top score"); passes `roomId` so the per-room `DISCORD_ENABLED` gate applies (was bypassed).
  - **`tournamentStarting` room-scoped** (`Scheduler.resolveTournamentStartingRecipients`): DMs only the tournament room's `room_members` (was ALL opted-in users globally → cross-room spam); legacy NULL-room tournaments keep the global fan-out as documented back-compat.
  - **Rate-limit fairness** (`NotificationService`): separate per-class budgets (`${userId}:high` vs `:chatty`, 5/hr each) so chatty types (turnToPick/friendScore/tournamentStarting) can't starve `rankDethroned`/`tournamentWin`.
  - **⚠️ FLAGGED default-ON flip — SHIPS INERT.** `rankDethroned`+`tournamentWin` default-ON for Discord-linked users is gated behind global SettingsService key **`NOTIFY_HIGH_VALUE_DEFAULT_ON`** — NO seed row → resolves OFF → zero behavior change on deploy. An explicit user pref (true OR false) always wins (the `explicitKeys` set distinguishes "absent" from "explicitly false"); rollback = set the key `false`. **TO ACTIVATE: set `NOTIFY_HIGH_VALUE_DEFAULT_ON=true`** (super-admin settings). Flag read cached 10s (propagation delay; `NotificationService.invalidateFlagCache()` exists but is NOT wired to settings writes). First flag-defaulted DM appends a one-time "manage via /arcaid-notifications or Account Settings" footer (`_hvFooterShown` marker in the user's prefs JSON).
  - **Milestones** (`MilestoneService` + **migration 105** `player_milestones_fired`): exact-equals → **crossed-threshold** detection backed by a UNIQUE-on-`(game_room_id, player_key, scope, threshold)` idempotency table (`INSERT OR IGNORE` + `changes()===1`); fires the threshold value (9→11 reads "10th"); uses resolved `displayName`. CAVEAT (out of S6 scope): counts stay alias-keyed while de-dup is canonical — multi-alias users may under-count totals, but no cross-alias double-fire.
  - **Web Notifications card** in `AccountSettings` — 5 toggles over the existing `GET/PUT /api/me/notification-preferences` (no new routes).
  - **Built via a 10-agent workflow** (recon → 3 file-partitioned implementers → integrate → 3 adversarial verify lenses); verdicts **safe / pass / pass**. **194/194 backend tests** (23 files, +2 S6 suites), admin-ui build + 2 tests clean. SW `CACHE_NAME` → **v72**.

<!-- LATEST_ARC_START — /release-docs replaces everything between this marker and LATEST_ARC_END with the new arc, prepending the displaced text into the "Earlier arc (v<previous>)" block below. -->

- **Most recent arc (v2.10.0 → v2.10.1 — IScored session registry + ranking cache watermark):**
  - **v2.10.1 — Ranking groups self-invalidate via data watermark.** User reported stale ranking-group values after Wed maintenance and after manual game deletes — the manual "Recompute" button was the only way to refresh. Root cause: `ranking_groups_cache` had no auto-invalidation; only the manual button, `RankingService.update()` (config changes), and Discord `/submit-score` cleared it. Every other score-mutation path (web submits, per-row delete, admin wipe-player, deactivateGame, deleteGameCompletely, runCleanup, ScoreSyncPoller, pin/unpin) silently skipped the invalidate. After maintenance flipped games to HIDDEN, `computeRankings`'s status filter dropped them, but the cached snapshot still reflected pre-maintenance state.
  - **Fix shape.** Migration **097** adds `data_watermark TEXT` to `ranking_groups_cache`. `RankingService` computes a 5-tuple fingerprint over indexed columns (`eligible_games_count`, `score_count`, `score_sum`, `MAX(end_date)`, `MAX(start_date)`) on every read; mismatch with the cached watermark triggers a silent recompute. Sub-10ms watermark query; ~50-200ms recompute when invalidated. **No invalidation calls anywhere in mutation code paths** — the data tells us when it's stale.
  - **Why watermark over alternatives.** Application-level invalidation hooks at every mutation site (~7 fan-out points) put forgetfulness back on every future contributor. SQLite triggers are opaque and hard to debug. Compute-on-every-read wastes CPU when nothing changed. Watermark is the only approach where adding a new score endpoint requires zero ranking-related awareness.
  - **Removed redundant invalidate.** Discord `/submit-score`'s `RankingService.invalidateAll()` call dropped — pre-fix it nuked all groups even ones that didn't include the affected tournament. Watermark recomputes only the actually-affected groups.
  - **Manual "Recompute" button retained as diagnostic escape hatch** — no longer load-bearing but useful for "force fresh data" if the watermark itself ever has a bug.
  - **Tests.** 4 new `cache watermark auto-invalidation` tests in `RankingService.test.ts` covering insert, status flip to HIDDEN, deletion, and no-op cache hit. **133/133 total tests pass**.
- **v2.10.0 — IScored session registry, eliminate parallel-Playwright contention. Deployed 2026-05-02.**
  - **Bug.** Wed 2026-04-29 22:00 Central + Thu 2026-04-30 22:00 Central maintenance fires left games visible on iScored despite local DB rows being marked HIDDEN. Affected: Mandalorian (cleared OK), Paranormal (failed cleanup later), Attack from Mars, CSI, X-Men Wolverine LE. Symptom logged repeatedly: `Game '<name>' not found in dropdown. Skipping delete.` followed by the caller's `Deleted from iScored: <name>` line — the caller couldn't tell success from no-op.
  - **Root cause.** `rtx_pinball` has 5 tournaments on one iScored account. At a shared cron minute (Wed 22:00: 4 weeklies + DG; last-day 22:00: DG + MG), each `runMaintenance` call constructed its own `IScoredClient`. Multiple Playwright contexts on the same iScored login contend over server-side session state — between `navigateToGamesTab()` and the `option[value=...]` lookup at `IScoredClient.ts:691`, another concurrent context's mutation flips the dropdown contents, the lookup returns 0, and `deleteGame` short-circuits silently. Plus `runCleanup` opened a *second* client per tournament (one for slot processing, one for cleanup), even within a single tournament's run.
  - **Fix — `IScoredSessionRegistry` (`src/engine/IScoredSessionRegistry.ts`).** New singleton, `withSession(creds, fn)` API. Calls for the same iScored account serialize: only one `fn` runs at a time per account. The underlying client is held across calls within a 1.5s idle TTL so cron-fire batches reuse the same Playwright login. Implementation is a per-account promise chain — each new caller sets itself as the chain tail, awaits the previous tail, runs its work, signals done.
  - **Routed every iScored caller through the registry.** Direct `new IScoredClient()` is now allowed only inside `IScoredSessionRegistry.acquireClient`. Refactored: `TournamentEngine.{runMaintenanceInternal, runMaintenanceWork, runCleanup, runScheduledCleanup, deactivateGame, deleteGameCompletely, reorderIScoredLineup}`, `TimeoutManager.fallbackToAutoSelection`, `gameCreation.{pinGameToScoreboard, unpinGameFromScoreboard}`, `IScoredSubmitSync`, four `rooms.ts` admin endpoints (DELETE game, DELETE admin/games, sync-iscored, state-change-sync, pickgame-fulfill, activate-game, validate-creds), the `admin.ts` backup endpoint, four Discord commands (`/activate-game`, `/pick-game`, `/submit-score`, `/sync-state`).
  - **Inline cleanup reuses the maintenance client.** `runCleanup(tournamentId, rule?, sharedClient?, sharedCreds?)` accepts an injected client; when present, skips its own registry acquisition. `runMaintenanceWork` passes its registry-managed client through. Halves the Playwright sessions per maintenance fire from two to one.
  - **`reorderIScoredLineup` scoped to caller's room.** Pre-fix, every maintenance fire reordered *every* room's lineup (5 weeklies on rtx_pinball reordered the same lineup 5×). Now `reorderIScoredLineup(gameRoomId?, sharedClient?)` — when called from maintenance with a `gameRoomId` and matching `sharedClient`, only that room is reordered using the shared client. Standalone callers preserve all-rooms behavior.
  - **`IScoredClient.deleteGame` now returns `Promise<boolean>`.** Returns `false` for the dropdown short-circuit, `true` on completed delete. Every caller branches on the return value: `runCleanup` logs `-> Cleanup skipped <name> on iScored (not in dropdown). Local row will still be marked HIDDEN.` instead of the misleading `Deleted from iScored: <name>`. `deleteGameCompletely` reports `iscoredStatus: 'failed'` with an actionable error message so admin UI surfaces the orphan instead of reporting fake success.
  - **Tests.** 129/129 passing. No new tests added — the registry's chain logic is small (~40 lines, single-file), and the production validation point is the next concurrent-fire moment (Wed 2026-05-06 22:00 Central or earlier under cron-collision conditions).
  - **No DB / FE changes.** Backend-only refactor. SW `CACHE_NAME` does NOT bump.
  - **One-off prod cleanup pending.** Paranormal (iScored ID 95735) and Attack from Mars (95586) are currently iScored orphans (visible there, no local DB row) from the pre-fix bug. Need manual delete via iScored UI as `mekelburgj@gmail.com` — user has accepted ownership. The fix prevents future occurrences but doesn't reconcile existing orphans.
- **Build state:** backend `tsc` clean, **133/133 tests pass** (+4 watermark tests in v2.10.1). Admin UI not built (no FE changes). SW `CACHE_NAME` at `arcaid-v47` — unchanged across the v2.10.x backend-only arc; the v44 → v45 → v46 → v47 walk happened in three FE polish commits between v2.9.0 deploy and v2.10.0 deploy (cropper aspect-ratio drop, QR peek tightening, admin-leaderboard hover-button fix).

<!-- LATEST_ARC_END -->

- **Earlier arc (v2.9.0 — per-row score moderation + multi-slot picker correctness):**
  - **Score moderation gap.** Players had self-delete on the **Global** scoreboard (`DELETE /api/me/global-scores/:scoreId`) but no equivalent for room-scoped scores. Room admins had a backend endpoint (`DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId`) but its only UI was on the legacy `AdminGameCard` rendering path which doesn't render once `SCOREBOARD_STYLE` is set — i.e. dead code in production for everyone using the v2.x card system.
  - **Player + admin per-row delete on `GameDetail.tsx`.** Trash icon appears on hover next to each `score_history` row in the per-player history expand. FE gates by decoded JWT claims (`role`, `gameRoomIds`, `discordId`); BE re-checks. Restricted to `source IN ('tournament','sync')`.
  - **Admin "Manage Scores" modal on Leaderboard cards.** New "Scores" button in `AdminCardWrapper` opens a modal listing per-player submissions with delete buttons. Targets the existing admin endpoint.
  - **Latent bugs in the existing admin endpoint.** Pre-fix it (1) only ran `DELETE FROM submissions` while tournament leaderboards have read `score_history` since v2.1.0 — cache invalidation re-computed and the score reappeared; (2) used `INNER JOIN tournaments` for verification, 404'ing pinned games per ADR 0005. Both fixed: cascade to `score_history` rows matching `(game_room_id, lower(iscored_username), game_id-or-game_name)`; switch to `LEFT JOIN tournaments` with an `ownedByRoom` check.
  - **New per-row endpoint.** `DELETE /api/rooms/:roomId/score-history/:historyId` (`requireDiscordUser`). Authorization tiers: super_admin → any row; room_admin → any row in their rooms; player → only their own. Recomputes the corresponding `submissions` row from remaining `score_history` (`ORDER BY score DESC, created_at ASC LIMIT 1` — preserves the timestamp of the displayed top row).
  - **Sync-resistant tombstone (migration 096).** New `deleted_score_suppressions(game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)` table. Both delete paths write a tombstone (`MAX(existing, deleted_score)` on conflict). `ScoreSyncPoller.pollOneAccount` bulk-loads suppressions per game and skips `score <= suppressed_score` before its existing `>` check. Without this, the next ~30s poll would re-import deleted scores. iScored's public page keeps the entry (no per-score delete API); manual cleanup tracked in ROADMAP.
  - **Cron race fix.** Daily Grind on rtx_pinball had `0 22 * * *` maintenance + `0 22 * * 3` cleanup. On Wednesdays both fired simultaneously; cleanup's first SELECT ran before maintenance had completed today's active game, leaving one game per Wed stuck `COMPLETED` (Black Knight 2000 on 2026-04-29 was the latest casualty). Fix: `runMaintenanceWork` runs cleanup inline at the end of the slot loop when `cleanupRule.mode === 'scheduled'` AND `cleanupCronMatchesNow(cleanupRule.cron, cleanupRule.timezone)`. New private cron-field matcher supports `*`, single ints, comma lists, inclusive ranges. Separate cleanup cron is left registered — fires idempotently after. (Note: v2.10.0 obsoletes most of the load-bearing reasoning here — registry serialization solves the original race — but the inline-cleanup fast path is preserved.)
  - **Per-slot picker correctness.** When one user won multiple slots in a single maintenance run (e.g. WG-VPXS max=2), pre-fix we emitted one `[Pending Pick]` + one DM, collapsing wins. Dedup rescoped from `(tournament_id, picker_discord_id)` to `(tournament_id, picker_discord_id, won_game_id)`. Embed + DM now name the won game per slot.
  - **Discord `/pick-game` placeholder fulfillment.** Pre-fix the command branched only on `hasOpenSlot`. Now mirrors the web route: pending+full → repurpose placeholder; open-slot → drop placeholder + activateGame; no-pending+full → queueGame.
  - **Tests.** 129/129 passing. SW `CACHE_NAME` walked `arcaid-v42` → `v44` across the arc.

- **Earlier arc (v2.8.0 → v2.8.2 — identity merge forward-attribution + Discord-style display names):**
  - **Original gap (v2.8.0).** Admin Identity-merge re-attributed history but did nothing forward-looking. Future iScored sync of "PBW2023" continued landing as `iscored:PBW2023` — anonymous synthetic. `MergeService.recordMerge` only updated the four score tables and flipped `anonymous_identities.status`; it never wrote to `user_mappings` (the table `ScoreSyncPoller` reads at every poll).
  - **Forward attribution (v2.8.0).** `MergeService.recordMerge` now INSERTs into `user_mappings` inside the merge transaction with a pre-flight `MAPPING_CONFLICT` check. After commit, a best-effort `fetchAvatarHash` (new helper in `src/utils/discord.ts`) seeds `user_profiles.avatar_hash`. `reverseMerge` cleans up: drops the alias row + re-anonymizes any post-merge auto-attributed rows that aren't in the snapshot (special-cases `global_scores.player_id` vs the other tables' `discord_user_id`).
  - **Many-to-one schema (v2.8.0).** `user_mappings` rebuild — dropped `discord_user_id` PRIMARY KEY, added `UNIQUE(iscored_username COLLATE NOCASE)` and `created_at`. Migration **095** detects case-only collisions and aborts with a clear message if any exist; the rebuild + new `user_profiles` table + backfill happen in one idempotent handler.
  - **Discord-style identity layer (v2.8.0).** New `user_profiles` table holds the user-chosen `display_name` (globally unique, case-insensitive, also blocked against other users' iScored aliases — but a user MAY pick their own alias as their display name) plus the avatar cache. `UserProfileService` owns the validation (length 2–32, allowed character set, uniqueness pre-check). `/api/users/me/profile` (GET/PATCH/check-display-name) and a new `/account/settings` page wire the FE.
  - **Leaderboard collapse (v2.8.0).** `LeaderboardService.recalculate`/`getForGameByPlatform`, `GlobalLeaderboardService.recalculate` + cross-game top-N, `RankingService`, `StatsService` all now `PARTITION BY COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))` — multi-alias Discord users render as one row per game; anon partitions per-name. All responses ship `display_name` alongside `iscored_username`. `PlayerAvatar` (already mounted everywhere) consumes the propagated `avatar_hash` and `display_name`.
  - **Discord-side display (v2.8.0).** `LobbyFeedGenerator` resolves the chosen display name once per event and substitutes it into new-#1 / rank-change / score-posted / friend-score titles + the `rankDethroned` and `friendScore` DMs. `TournamentEngine` winner announcement embed (both pick-award-on and pick-award-off branches) + `emitPickerAssigned` ticker use it.
  - **FE rendering polish (v2.8.1).** New `playerName(entry)` helper exported from `ScoreboardComponents` (single rule: `display_name || iscored_username`), substituted across `BannerCard`, `MinimalCard`, `ScoreList`, `ShowcasePodium`, plus the page-level renders in `Leaderboard`, `GameDetail` (5 sites), `GlobalScoreboard`, `GlobalGameDetail`, `Stats`, `PublicStats`, `Rankings`, `Friends`. Match/key/route logic deliberately keeps `iscored_username` for stable identifiers. `FriendsService.getFriends` LEFT JOINs `user_profiles` so the friends list pulls each friend's chosen name + avatar from the new table (with `MIN(m.iscored_username)` to flatten the now-many-to-one alias rows).
  - **Last two surfaces (v2.8.2).** `GET /api/global/recent-scores` (LandingPage ticker) returns `player_display_name` alongside the existing game-level `display_name`; `StatsService.getRoomOverview` Latest-submission card LEFT JOINs `user_profiles` for display_name. Closes the v2.8.1 known-deferred items.
  - **Behavior changes worth flagging.** `/map-user` Discord command shifts from "replace mapping" to "add alias" — errors if the name is owned by a different Discord user. Avatar cache moved from `user_mappings.avatar_hash` to `user_profiles.avatar_hash` (`auth.ts` Discord OAuth callback writes the new column; old column is left in place for one release).
  - **Tests.** `src/__tests__/MergeService.test.ts` (forward-attribution write, MAPPING_CONFLICT, idempotent re-merge, case-insensitive collision check, reverseMerge re-anonymize, freeze-gate regression) + `src/__tests__/UserProfileService.test.ts` (validation rules, uniqueness vs other display names, vs other users' aliases, own-alias allowance, batch lookup). 129/129 passing.
  - **Docs.** CHANGELOG entries for v2.8.0/v2.8.1/v2.8.2. SW `CACHE_NAME` walked `arcaid-v37` → `v38` → `v39` → `v40` across the three deploys. Reference memory `reference_iscored_case_insensitive.md` written (iScored is case-insensitive at the player-identity level; canonical casing follows highest-scoring submission).
  - **Deferred (rolled to ROADMAP Future):** one-shot DM to the merged user at recordMerge time, `/unmap-user` Discord admin command, pure-iScored-name claim flow (admin claims an iScored name with no `anonymous_identities` row), admin display-name override.
- **Earlier arc (v2.7.2 — duplicate dethrone DM root cause + Deactivate/Delete admin split):**
  - **Bug.** User received two identical `rankDethroned` Discord DMs for the same WHO dunnit submission on rtx_pinball (PBW2023, 96,814,400, 2026-04-27 02:56 UTC). 763ms apart, identical message text. Forensics in `data/.../arcaid.log` show the web `/submit-score` route fired `LobbyFeedGenerator.onScoreSubmitted` once (DM #1 from `CommunityScoreService.submitScore`), then the SyncPoller polled iScored and re-fired it (DM #2 with `source: 'sync'`).
  - **Root cause (two layers).** (1) Two `games` rows shared `iscored_id = "95570"` — Daily Grind's WHO dunnit (ACTIVE) and Weekly Grind - VR's (COMPLETED). Reuse happened because the legacy "lock on deactivate" never deleted the iScored game; subsequent `IScoredClient.createGame` for the same name returned the existing locked entity. (2) `ScoreSyncPoller.pollOneAccount`'s `db.get` had no `ORDER BY` and no status filter, so it could pick the COMPLETED row, find no matching `submissions` entry under that `game_id`, and fire `onScoreSubmitted` as if the score were new.
  - **Fix B (`7c7cf8b8`) — SyncPoller deterministic lookup.** Added `ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END, g.created_at DESC LIMIT 1`. This alone neutralizes the bug for legacy data — it's the correctness patch.
  - **First-cut Fix A (reverted in `aef1d0ff`).** `7c7cf8b8` had deactivation hard-delete on iScored + NULL `iscored_id`. Killed the structural cause but broke normal end-of-round semantics (admins still want history visible on iScored after a round closes; deletion is for the rare "wrong game in wrong tournament" case).
  - **Fix A final (`aef1d0ff`) — Deactivate vs Delete split.** Two distinct admin actions on an ACTIVE game:
    - **Deactivate** — `setGameStatus({locked:true})` on iScored + `status=COMPLETED` in DB; `iscored_id` is intentionally KEPT non-NULL so `runCleanup` (cleanup_rule retain/scheduled/immediate) can find the row. End-of-round semantics.
    - **Delete** — `deleteGame()` on iScored + `DELETE FROM games` + score orphan per ADR 0005 (`UPDATE submissions/score_history SET game_id = NULL`, `UPDATE global_scores SET origin_game_id = NULL`). Wrong-game-in-wrong-tournament semantics.
    - Both run a new `TournamentEngine.finalSyncScoresForGame()` helper first that pulls iScored scores into `submissions` + `score_history` so anything submitted between the last poll cycle and the action survives. Helper does NOT fire `LobbyFeedGenerator.onScoreSubmitted` — data capture only.
    - `processSlotMaintenance()` (cron rotation) follows the same lock + final-sync contract.
    - New `DELETE /api/rooms/:roomId/games/:id` endpoint and a Delete button + type-to-confirm dialog in the Tournaments admin Active Games row.
  - **Retained-completed admin (`bd58481c`).** Daily Grind on rtx_pinball uses `cleanup_rule.mode = 'scheduled'`, which keeps every COMPLETED game on the public scoreboard until the Wednesday cleanup cron — admins had no UI to remove a stale entry before the scheduled run. New `GET /api/rooms/:roomId/games/retained-completed` mirrors `LeaderboardService.getActiveLeaderboards`'s retention logic (capped at 100 per tournament for `scheduled` mode); Tournaments admin renders a "Retained Completed Games" card below Active Games with the same Delete button.
  - **One-off prod cleanup.** "Spooky Retro" games row (residue from the first-cut "always delete" version) was sitting on the public board with no admin affordance — deleted via `docker exec arcaid node -e ... deleteGameCompletely('5fab0c5e-…')`. Future occurrences are self-service via the Retained Completed Games card.
  - **Bundled fix `e28cdb81`** (user-authored, between Fix B and the split): `MergeService` was querying a non-existent `tournaments.end_date` column for "tournament completed" detection. Rewritten to derive a completion timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` for that tournament. Unrelated to the dethrone arc but in the same release window.
  - **Docs.** CLAUDE.md "iScored integration" rewritten with the Deactivate-vs-Delete table; CHANGELOG v2.7.2 entry; SW `CACHE_NAME` bumped `arcaid-v34` → `arcaid-v37` (three bumps across the cycle).
  - **Migration.** None — no schema or data changes.
- **Build state:** backend `tsc` clean, admin-ui `vite build` clean, **109/109 tests pass**. SW `CACHE_NAME` → `arcaid-v37`.
- **Earlier arcs (v2.7.1 — tournament platform-rules orthogonality, ADR 0009):**
  - **Bug.** WHO dunnit (catalogue + room tags = 6 platforms) on Daily Grind (`Must=[atgames]`, `NotAllowed=[]`) showed only AtGames in the submission picker captioned "(only platform for this game)". Player wanted to log a VPX score; couldn't.
  - **Root cause.** `resolveSubmittablePlatforms` was applying both `required` and `excluded` to the picker. `Must` was conflating two orthogonal concerns: game-level eligibility (intended) AND submission-level filtering (unintended). The v2.7.0 semantics shift fixed the same conflation on the other half (`NotAllowed` was both); this fixes the `Must` half.
  - **Fix (2 commits):**
    - `9dc58ad4` (FE) — `SubmissionSheet` tracks `fullGamePlatforms` separately so the single-platform chip caption disambiguates: `(only platform for this game)` vs `(only platform allowed by this tournament)`. SW `CACHE_NAME` → `arcaid-v34`.
    - `faf86557` (BE) — `resolveSubmittablePlatforms` returns `gamePlatforms − excluded`, period. `passesplatformRules` (game-level) unchanged. Both helpers' JSDoc rewritten with the orthogonal-axes contract spelled out so the next reader doesn't re-introduce the conflation.
  - **Architecture (ADR 0009).** Two orthogonal axes: `Must` = game-level eligibility ONLY (`passesplatformRules`); `NotAllowed` = submission-level filter ONLY (`resolveSubmittablePlatforms`). Worked examples in the ADR.
  - **Docs.** ADR 0009 written (Context/Decision/Consequences/Alternatives + 4 worked examples). ADR 0006 gets a Notes section pointing at 0009 (the platform-stratification decision is intact; only the resolver-semantics phrase was stale). CLAUDE.md "Platform stratification" rewritten with two-axis table. README.md feature blurb + Tournament Settings table corrected. CHANGELOG v2.7.1 entry.
  - **Migration.** None — no schema or data changes. Behavior shift is deliberate; tournaments previously relying on `Must=[X]` as a *submission* lock will now accept all of an admitted game's platforms. Use `NotAllowed` for the others to block them.
- **Earlier arcs (v2.7.0 — per-room tags + new importers + tournament rules shift):**
  - **Per-room game tags (ADR 0008).** New `room_game_tags(game_room_id, global_game_id, tag)` table — variant-keyed via `global_games.id`. `RoomGameTagsService` (single-game CRUD + bulk add/remove + `getTagMapByGameNameForRoom` for batched lookups). Endpoints under `/api/rooms/:roomId/games/`: `GET/POST/DELETE :globalGameId/tags`, `POST bulk-tag` (cap 500), `POST bulk-untag`. Read-path UNION across catalogue platforms ∪ room tags applied to `ensurePlatformAllowed`, `/api/submit/platforms`, `/:roomId/platforms/available`, `/:roomId/game_library` response, web pick-game route, admin activate-game route, Discord `/activate-game`, `/pick-game` autocomplete, `TournamentEngine.autoPickAndActivate`, `TimeoutManager` fallback autopick. Migration 093 inline.
  - **Tournament platform-rules semantics shift.** `Not allowed on` is now submission-level only — game can be picked/activated/autopicked even if it carries the excluded platform; only score submissions selecting the excluded platform are rejected. `Must be available on` stays a game-level gate. `passesplatformRules` drops the excluded clause; FE form subtitle updated; inline conflict validator (`getPlatformRuleConflicts`) blocks Create/Save when same platform is in both lists.
  - **Pinball FX VR catalogue tagger.** `tmp/fx-vr-tables-draft.md` (gitignored source-of-truth, 39 tables) → `tmp/emit-fx-vr-data-ts.js` → `src/services/fxVrPackContents.ts` (committed). `FxVrImportService.applyTags()` uses `GlobalGameService.upsert` so real-machine recreations merge into VPS-imported rows + Zen originals (Sky Pirates etc.) auto-create. Migration 094 cleans up legacy bare `vr` token. Endpoint `POST /admin/catalogue/sync-fx-vr` + Catalogue page button.
  - **AtGames Sheet sync.** `AtGamesImportService` pulls column A of public Google Sheets export (no API key) plus columns H/I/J/K for cabinet variants. Always-tag invariant: every row gets `atgames` + one `atgames_<variant>` per detected cabinet (HD / 4K / Micro / HDP / ALU / Mini / Gamer / Core). 6 new canonical platform IDs. Tiny inline CSV parser, unicode-quote normalization. Endpoint `POST /admin/catalogue/sync-atgames` + Catalogue page button. Production: 260 updated, 0 created.
  - **Library page polish:** bulk select + sticky action bar (Tag / Activate / Pin / Clear); per-row Tag dialog with chip-remove + suggestions; amber room-tag chips distinct from cyan catalogue chips; search bar overhaul (substring across name/manufacturer/year/platforms/room_tags/designers/themes/table_authors/aliases + inline `2001-2020` year-range syntax + live preview line); manufacturer chip-row added then reverted in same release per user direction; client-side pagination 100/page with truncation; variant disambiguation sub-line; React row keys → `g.id` to fix duplicate-key reconciliation glitch.
  - **iScored credentials hardening.** Activate handler switched to per-room creds (was env fallback — caused activate-works-but-deactivate-fails orphans). `deactivateGame` returns `iscoredStatus: 'locked'|'failed'|'shared'|'skipped'` + `iscoredError`; FE renders 4 distinct toasts. `IScoredClient.connect` classifies login timeouts: "iScored rejected the credentials (wrong username or password)" vs "iScored login timed out — possible rate limit". New `POST /api/rooms/:roomId/iscored/validate` + `IScoredCredentialsCheck` component on Settings → iScored.
  - **ScoreSyncPoller log-spam fix.** Per-account error suppression mirrors the outer pattern (logs first 3, suppresses thereafter, logs `recovered after N failure(s)` on success). `_lastPollSucceeded` reflects per-account success now (was always true). Adaptive backoff during outages NOT shipped — currently still hits iScored every 5s, just doesn't log; follow-up if outages turn out to be regular.
  - **Display labels:** "AtGames Legends" → "AtGames" (and HD/4K variants). `getPlatformDisplay` uppercase fallback for unknown ids (`fx2` → `FX2`, bare `vr` → `VR`).
- **Build state at end of v2.7.0 deploy:** backend `tsc` clean, admin-ui `vite build` clean, **109/109 tests pass**. SW `CACHE_NAME` was `arcaid-v33` (now bumped to v34 in v2.7.1).
- **Earlier arcs (v2.6.0 — step-2 cleanup, 2026-04-26):**
  - **v2.6.0** (2026-04-26) — **Drop legacy `game_library` table + complete the library=catalogue arc.** Plan: `docs/step-2-cleanup-plan.md`. 7 sequential commits (2c → 2a → 2b → 2g → 2d → 2f → 2e), each independently buildable.
    - **2c** — drop `game_room_game_library` overlay reads (`custom_platforms`, per-room `display_name`). 9 call sites lose the JOIN + `mergeEffectivePlatforms` step. `PUT /:roomId/game_library/:name/overlay` deleted. `GameLibraryService.{setRoomCustomPlatforms,setRoomDisplayName,getEffectivePlatformsForGame}` removed. `roomOverlay.test.ts` deleted.
    - **2a** — preserve `game_library.aliases` onto `global_games`. Migration 090 (`ALTER TABLE global_games ADD COLUMN aliases TEXT DEFAULT '[]'`) + migration 091 (CSV → JSON backfill keyed via `gl.global_game_id`). Production: **2523 rows** backfilled. Honest note: `game_library.aliases` is write-only metadata in the live codebase — preserved as insurance for a future search-by-alias / iScored alt-name feature. No reader switched (none exists).
    - **2b** — switch tournament/leaderboard/Discord-autocomplete reads from `game_library` to `global_games`. `LeaderboardService.getActiveLeaderboards` drops the `LEFT JOIN game_library gl` in 3 queries; image fallback collapses to `gg.local_image_path → gg.wheel_image_path → gg.image_url`. `TournamentEngine` + `TimeoutManager` auto-pick scan `global_games WHERE status='approved' GROUP BY LOWER(name)` (collapses variants). iScored `client.createGame(name, styleId)` now passes `undefined` (defaults take over). `client.applyStyle(...)` calls dropped — style-learning loop had no consumer post-2c.
    - **2g** — `GameLibrary.tsx` becomes a read-only catalogue browser. Add Game flow → `submit_to_global` only; CSV import → `submit_to_global` only. Drop edit modal, delete-selection, "Edit" + "Delete Selected" buttons, "Style ID" column, `aliases` / `style_id` / CSS-override fields on the Add form. Proposal panel: exact-match informational only ("already in catalogue, pin/activate from the table"); possible-match shows duplicates as informational rows + single "submit as new" CTA. Backend `GameLibraryService.search` switched to `global_games`. SW `CACHE_NAME` → `arcaid-v19`.
    - **2d** — DELETE `/use_global` + `/room_only` endpoints. Simplify `/submit_to_global` (insert pending `global_games` row only — no library writes). Simplify `/import-csv-commit` (only `submit_to_global` decisions; auto_link rows skipped client-side). `UseGlobalGameSchema` dropped; `ImportCsvCommitSchema.decision` narrowed to `z.literal('submit_to_global')`.
    - **2f** — drop 7 legacy admin endpoints from plan §2f plus 3 sibling super-admin endpoints. `VpsImportService` + `WizardImportService` drop the dual-write to `game_library` + the `addToRoom` calls in `/catalogue/sync-vps`+`/catalogue/sync-wizard`. `TournamentEngine` style-learning loop removed. `/admin/games-for-picker` switched its "library games" half to read `global_games`. `GameLibraryService` trimmed to 3 still-used methods (`search`, `setRoomGameStyle`, `getRoomGameStyle`). Schemas dropped: `ImportGamesSchema`, `UpdateGameSchema`, `gameFields`, `platformsField` helper.
    - **2e** — `DROP TABLE IF EXISTS game_library` via migration 092. Final reader cleanups: `/api/submit/platforms` drops the `gl` first-leg lookup; admin display_name endpoint drops the dual-write; `GlobalScoreService.fanOutFromRoomSubmission` third resolution leg → `global_games WHERE status='approved'`; `GlobalGameService.merge` drops the `UPDATE game_library SET global_game_id` repointing; boot-time `tournament_types→platforms` migration removed; `migrateToMultiRoom` step 5 removed. `catalogueBackfill.test.ts` deleted; `thinDuplicateMerge.test.ts` first test dropped `game_library` assertion; `pinEndpoint.test.ts` seeds `global_games` instead. The `CREATE TABLE` for `game_library` at top of `initDatabase` is intentionally left in place — fresh DBs need it for the early ALTER migrations (005, 006, 009, 027, 033, 039) and 091's alias backfill, before 092 finally drops it.
  - **Scope deviation from the plan:** drops only `game_library`, **not** `game_room_game_library`. The plan's column audit for the bridge table missed the per-room style overlay columns (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) — still actively read by `gameCreation.ts` + `TournamentEngine` + `StyleCatalogueService` and written by `GameLibraryService.{set,get}RoomGameStyle` + the StylePicker FE. Dropping the bridge table without re-keying that overlay onto a new `(game_room_id, global_game_id)` table would lose data and break Style assignment. Out of step-2 scope. **Followup:** style overlay re-keying sprint.
- **Build state:** backend `tsc` clean, admin-ui `vite build` clean, **109/109 tests pass**. Last verified end of v2.6.0 deploy. (Test count drop from 119/119: 4 from `roomOverlay.test.ts` deletion + 4 from `catalogueBackfill.test.ts` deletion + 1 from the dropped `game_library` assertion in `thinDuplicateMerge.test.ts`; +1 net from helper changes.)
- **Earlier arcs (v2.5.0 → v2.5.2):**
  - **v2.5.0** — **VR + Steam-pinball taxonomy + score-platform stratification + per-room contribution flow.** Coordinated bundle (score-platform required end-to-end). 7 new platform IDs (`pinball_fx_classic` replaces `pinball_fx3` for Zen rebrand; `pinball_fx_classic_vr`, `pinball_fx_midnight`, `pinball_fx_vr`, `star_wars_pinball_vr`, `zaccaria`, `zaccaria_vr`). Removed legacy `pinball_fx3` + generic `vr` bucket. `SteamPinballImportService` with curated `PACK_CONTENTS` map (78 packs → 220 tables). Required `platform` field on score tables; `resolveSubmittablePlatforms` + `ensurePlatformAllowed` re-validation; `SubmissionSheet` picker (1→chip, 2+→dropdown). Discord `/submit-score` auto-fills when 1. `GlobalGameService.findCandidates` powers per-room contribution endpoints. Super-admin Catalogue Approvals at `/admin/catalogue/approvals`. Public `GET /global/games` hard-codes `status='approved'`. Migrations 083–087.
  - **v2.5.1** — **Library = global catalogue (step 1) + display polish.** Per-room library page reads `global_games WHERE status='approved'` directly; legacy `game_room_game_library` curation overlay no longer consulted for the list view. Display names shortened (`"Pinball FX Classic"` → `"FX Classic"`). New "Platform" column on Global Game Detail leaderboard. Migration 088 flushes leaderboard caches.
  - **v2.5.2** — **Platform-data normalization sweep.** Migration 089 walks every JSON platform array and folds each entry through `normalizePlatform()`. Production: 5550 rows normalized. `GameLibrary.tsx` chips + filter row also alias-fold + dedupe at render time as defense in depth.
- **Earlier arcs (v2.3.0 → v2.4.16):**
  - **v2.3.0** — Per-room iScored / Discord configuration moved from global to `game_room_settings`. New `src/utils/secrets.ts` AES-GCM encryption pipeline keyed off `SECRETS_KEY` (env). `ENCRYPTED_SETTING_KEYS` allowlist (currently `ISCORED_PASSWORD`, `OPDB_API_KEY`, `TWITCH_CLIENT_SECRET`) controls encryption on write / decryption on read. `maskEncryptedValues` returns `[ENCRYPTED]` placeholder on the GET path. Allowlist intentional — a typo can't silently land in plaintext.
  - **v2.3.1–v2.3.3** — Discord plumbing fixes: gate slash commands and DMs on per-room `DISCORD_ENABLED`; exclude Discord-disabled rooms from cross-room queries; exclude orphan (no-tournament) games from `/list-active` and friends.
  - **v2.4.0** — **Catalogue Unification + Pin to Scoreboard.** Migration 069 backfills `global_game_id` on every relevant row (`games`, `game_library`, `game_room_game_library`). Composite UNIQUE INDEX `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(mfg,'')), COALESCE(year,0))` lets variants coexist while rejecting true duplicates. Per-room overlay (`custom_platforms`, `display_name`) lets rooms add their own platform tags without touching the shared catalogue. **Pin-to-Scoreboard:** `games.tournament_id IS NULL` + `game_room_id` (denormalized) + `display_order` + unique partial index `idx_games_pinned_unique`. Cascade on unpin: submissions/score_history/global_scores `game_id` set to NULL before DELETE so history survives. New `src/engine/gameCreation.ts` shared helper.
  - **v2.4.1–v2.4.15** — Catalogue dedup saga. Each Wizard / VPS / OPDB import surfaced a deeper layer of dedup logic that needed adjustment. Major beats: 068 multi-pass merge (legacy duplicates); 069 strict exact-match for backfill (not 4-step upsert); 070/077 ordering for orphan delete; 078–079 thin-duplicate post-backfill cleanup; 080 composite identity index; step 4 two-tier match (concrete mfg/year-agreeing rows preferred); exact year (not ±1) for concrete; richest-row tie-breaker for multi-concrete and multi-loose; full-table scan for `findByNormalizedName` (LIKE prefilter dropped — apostrophes broke it); v2.4.13 Wizard `vpxs` vs `vpxs_manual` split; v2.4.15 step-4 concrete accepts merge despite vps_id drift (VPS re-indexing case).
  - **v2.4.16** — **Catalogue UX + diagnostics.** `formatLogArg()` in `logger.ts` writes `Error.stack` to file instead of `{}` (Error properties non-enumerable, JSON.stringify was hiding every `logError(msg, err)` site for the entire life of the project). OPDB / IGDB sync routes return 400 upfront when credentials are missing (was 202 → swallowed background failure). OPDB API Key + Twitch Client ID/Secret added to Global Settings → Configuration with masked inputs. VPS importer split into `playable` (legacy game_library) and `cataloguable` (any VPS entry with a name → global_games + image download) so broken-flagged tables — Bluey, Britney Spears, Chime Speed Test Table, etc. — get their metadata + images on the global scoreboard.
- **Build state:** backend `tsc` clean, admin-ui `vite build` clean, **119/119 tests pass.** Last verified end of v2.4.16 deploy.
- **Earlier arc (v2.1.0 → v2.2.14):** identity correctness, scoreboard click-routing, Mystery Award cabinet redesign. Highlights below for context:
  - **v2.1.0** — Tournament leaderboards now read `score_history` filtered by `submitted_during_tournament_id` (best-during-window wins). Multi-score inline expand on Game Detail with sparkline + This-tournament/All-time split. Stats page Combo redesign with 4-card overview row.
  - **v2.2.0** — First-claim-wins identity: `RoomNameClaimService` resolves per-room display names, auto-suffixes collisions. Global fan-out gate blocks guest scores from reaching `/scoreboard`. `REQUIRE_DISCORD_LOGIN=true` default for new rooms. Migrations 064–066 add `room_members.display_name` + `anon_room_claims`.
  - **v2.2.1** — Winner resolution reads local DB first (iScored is fallback). Anon winners get a "claim your account" Discord message. iScored API client handles non-JSON "Access Denied" rejections cleanly.
  - **v2.2.2** — `IScoredSubmitSync` helper unifies iScored sync across all three web submission paths (tournament / freeplay / legacy community endpoint).
  - **v2.2.3** — Multi-name per browser: one `anon_token` can claim multiple display names per room (was previously collapsed to first claim).
  - **v2.2.4** — Post-Discord-login lands on `/:slug/lobby` instead of `/:slug/picks`.
  - **v2.2.5** — `conditionalRequireDiscordUser` middleware now decodes optional tokens even when the room allows guests (fixes the "logged-in user stored as COMMUNITY" regression). Pre-submit name-collision prompt. `SubmissionSheet` localStorage prefills with resolved name.
  - **v2.2.6** — Tournament card clicks go to Room Game Detail (`/:slug/games/:name`) not Global. Scorecards: usernames are Links to player stats; `+` expand icons work inline. Mystery Award tournament pool selector. `UserMenu` on Global pages. Login text normalized.
  - **v2.2.7** — Shared `DiscordLoginButton` component. Extra pointer-events reinforcement on ShowcasePodium.
  - **v2.2.8** → **v2.2.9** — Removed the inset-0 `<Link>` overlay from `GameCard` / `Scoreboard.tsx` / `GamesTabView.tsx`. Replaced with per-card-variant **title-as-Link** via `titleLinkTo` prop plumbed through `CardRouter`. Fixes the "click `+` to expand but navigates instead" problem permanently. Mystery Award header `z-[60]` + `fixed` positioning.
  - **v2.2.10** — Usernames are Links on every scoreboard card (BannerCard / MinimalCard / ShowcasePodium / ScoreList). Expand panel contrast bumped (scores 95% / dates 65%). Picks URL uses slug not UUID (`?t=daily_grind`). Pinball-button CSS family introduced. Mystery Award pool selector renamed "Tournament Pool:" and moved above the modal.
  - **v2.2.11** — Service-worker `CACHE_NAME` bumped `arcaid-v5` → `arcaid-v6`. Every subsequent UI change bumps the SW cache so it propagates without DevTools gymnastics.
  - **v2.2.12** — Mystery Award pool selector collapsed into the top nav row (no backbox overlap on mobile).
  - **v2.2.13** — **Mystery Award cabinet redesign:** `TournamentPoolTopper` component renders above the backbox like a pinball cabinet topper (orange LED glow strip, drop-down overlays backbox). Fire + Queue buttons redesigned as always-visible circular pinball-cabinet buttons (`.pinball-round-btn` family). Queue grayed out until a game is revealed. "Hit Mystery" renamed to "Fire". Queue amber/orange instead of green.
  - **v2.2.14** — Flipped Fire/Queue button positions (Queue left, Fire right).
- **Build state:** backend `tsc` clean, admin-ui `vite build` clean, **67/67 tests pass**. Last verified end of v2.2.14 deploy.
- **Data state (prod):** legacy anon rows cleaned from `global_scores`; Krobs + 6 other Discord users' Global entries restored from `submissions` after the v2.2.1 over-cleanup; one-off "mekelburgj" phantom anon claim deleted after the v2.2.5 middleware fix. Manual runbook for phantom-claim cleanup documented in `ROADMAP.md` (no automation).
- **Manual test playbook:** `tmp/manual-test-playbook-v2.2.3.md` — now bumped to v2.2.7 with section H covering v2.2.6–v2.2.10 fixes. Gitignored (tmp/).
- **Known open roadmap items (not scheduled):** Player Self-Service + Moderation (scores/comments/bans), Comments & Tips bidirectional view, iScored Sync cooldown bypass, Score Photo Persistence, Discord Bot Multi-Room Phase 5. See ROADMAP.md `## Future`.

---

### Scores/Nav Reorg — COMPLETE & SHIPPED (2026-04-17)

All 12 sprints plus Sprint 13 polish pass committed and deployed. Historical log preserved below for context. No open work in this arc.

---

**Scores/Nav Reorg — Sprint 1: Score schema migration & context-capture plumbing** — COMPLETE (2026-04-17)
- [x] Migrations 048–053: 5 context columns on `submissions`/`community_scores`/`score_history`/`global_scores`, plus new `anonymous_identities` and `merge_records` tables + indexes
- [x] `SubmissionContextService` + `normalizeSubmitterUserId()` helper (sentinel-aware: ANON/SYSTEM/COMMUNITY → null)
- [x] Write-site instrumentation (9 production sites): `CommunityScoreService`, `ScoreHistoryService`, `GlobalScoreService`, `admin.ts` backfill (×2), `rooms.ts` web community submit, `ScoreSyncPoller`, Discord `/submit-score`, `/sync-state` (API + Playwright paths). `GlobalScoreService.fanOutFromRoomSubmission()` extended with `tournamentId` + `submittedByAnonymousName`.
- [x] TypeScript types in `src/types/index.ts`: `SubmissionContext`, `AnonymousIdentity`, `AnonymousIdentityStatus`, `MergeRecord`
- [x] Invariant guard: `SubmissionContextService.assertNotMutating()` + 10 unit tests (all passing)
- [x] `scripts/wipe-test-scores.ts` — manual operator tool (null-out + optional wipe, per Q1 answer)
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean, 50/50 tests pass

**Scores/Nav Reorg — Sprint 2: Merge-reversal data model spec + MergeService skeleton** — COMPLETE (2026-04-17)
- [x] `tmp/sprint-02-merge-model.md` — merge_records field-by-field spec, freeze rule (both directions, including tournaments that complete between merge+reversal), reversal UI wireframe, API surface for Sprint 11, out-of-scope list, sign-off checklist
- [x] `src/services/MergeService.ts` skeleton — `previewMerge`, `recordMerge`, `previewReversal`, `reverseMerge`, `listMergeHistory`, `getMergeRecord` (all throw NotImplemented(Sprint 11))
- [x] Decisions locked: Q2 → (a) parallel system (legacy `merge-player` renamed to "Sync-alias rename"); Q3 → new `/:slug/admin/identity` page
- [x] Build verification: `tsc` clean (MergeService signatures compile)

Sprint 2 review gate: docs-only, no automated reviews. Ready for Justin sign-off on `tmp/sprint-02-merge-model.md`.

**Scores/Nav Reorg — Sprint 4: DiscordNicknameResolver utility + anonymous-identity write plumbing** — COMPLETE (2026-04-17)
- [x] `src/services/DiscordNicknameResolver.ts` — `resolveServerNickname(guildId, name, { fallbackToGlobal })` using `guildMembersSearch` REST endpoint (no GUILD_MEMBERS intent). 30s memoization keyed on `(guildId, lowercased query)`.
- [x] `src/engine/IdentityManager.ts` refactored to call the utility; preserves match precedence (nickname → globalName → username) with regression tests.
- [x] `src/services/AnonymousIdentityService.ts` — `upsert({ roomId, guildId, serverNickname })` keyed on `(guild_id, LOWER(server_nickname))`, falls back to `(room_id, ...)` when guild absent. Returns identity `id` for OAuth handoff.
- [x] `CommunityScoreService.submitScore()` — upserts `anonymous_identities` when submitter is anonymous, returns `{ id, anonymousIdentityId }` for Sprint 10 claim flow.
- [x] 12 unit tests for `DiscordNicknameResolver` (exact match, whitespace trim, case-insensitive, fallback precedence, memoization, empty-input / missing-token guards).
- [x] Build verification: `tsc` clean, 62/62 tests pass.

Sprint 4 review gate: plumbing — `review-code-quality.md` only (skips design/UX per plan).

**Scores/Nav Reorg — Sprint 3: Shared GameCard + SubmissionSheet + themed icons** — COMPLETE (2026-04-17)
- [x] `admin-ui/src/assets/icons/ThemedIcons.tsx` — `TrophyIcon`, `SubmitScoreIcon`, `MysteryAwardIcon`, `RoomBadgeIcon`, `CooldownLockIcon` (24×24 SVGs, `fill="currentColor"`), plus `drawCanvasStar()` helper for canvas path stars.
- [x] `admin-ui/src/components/RoomTag.tsx` — themed mini-component for room badges (16/24/32 sizes, logo or text variant, optional Link wrapping).
- [x] Emoji replacement at the 3 audit-identified sites: `ShowcasePodium.tsx:153` and `:204` Trophy (🏆) → `<TrophyIcon size={13} />`; `MysteryAward.tsx:354` Star (★) → canvas-path stars flanking "MYSTERY AWARD" text.
- [x] `admin-ui/src/components/cards/GameCard.tsx` — shared wrapper implementing §10 contract: `{ game, context, slug, onSubmit, onNavigate, slots }`. Link overlay (z-10) + always-visible submit affordance (z-20 with `stopPropagation`). Delegates to existing `CardRouter` (Banner/Showcase/Minimal). Available for Sprint 8 migration.
- [x] `GameLeaderboard` base interface extended with optional `globalGameId?: string | null` so tournament-tab cards can route to the canonical `/games/:globalGameId` when available, falling back to `/:slug/games/:gameName`.
- [x] Tournament-tab Link overlay on `Scoreboard.tsx` — all 3 render paths (grid / vertical-scroll / horizontal-scroll) wrapped with `relative group/card`, absolute-positioned `<Link>` at z-10, and themed `<SubmitScoreIcon>` button at z-20. Fills the §10 gap (Tournament cards previously lacked title→detail navigation).
- [x] `admin-ui/src/components/SubmissionSheet.tsx` — strangler-pattern consolidation of the 4 submit surfaces (`ScoreSubmitModal`, `FreeplaySubmitModal`, `GlobalScoreSubmitModal`, `ScoreSubmit` page) behind a single component with a discriminated `SubmissionTarget` union (`tournament` | `freeplay` | `global`). Dispatches to 3 endpoints, preserves all UX (OnScreenKeyboard, touch detection, photo preview, exclude-from-global). Ships alongside originals — Sprint 10 migrates call sites and removes legacy modals.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean, 62/62 tests pass. Sprint 3 emoji sweep (`\u{1F3C6}` / `\u2605` at the 3 audit sites): 0 hits in `ShowcasePodium.tsx` and `MysteryAward.tsx`. Residual ★ in `StarRating.tsx:28` is Sprint 12 final-sweep scope (out of Sprint 3 per audit).

Sprint 3 review gate: first UI sprint — all three reviews required per plan (`review-code-quality`, `review-design-fidelity`, `review-ux`).

**Scores/Nav Reorg — Sprint 5: `ENABLE_GAME_PICK_AWARD` setting + full-system cascade gating** — COMPLETE (2026-04-17)
- [x] `src/services/PickAwardGate.ts` — `isEnabled(roomId, tournamentId?)` with 5s TTL cache, AND semantics (Q5): both room setting and per-tournament `winner_picks` must be truthy. Exports `ENABLE_GAME_PICK_AWARD` key and `PICK_AWARD_DISABLED_REPLY` exact string.
- [x] `TournamentEngine.processSlotMaintenance()` — gate checked before picker-slot creation. When off, winner gets plain "Congrats!" embed (no pick language), no picker slot, no `turnToPick` dispatch. Copy in `!winnerPicks && !autoPick` and final-else branches branches on `pickAwardEnabled` to drop `/pick-game` references.
- [x] `TimeoutManager.checkTimeouts()` — per-tournament gate filter (`gateByTournament` Map) skips pending games in gated-off tournaments. Scheduler global timer stays unchanged (shared across rooms, filter is effective gate).
- [x] `NotificationService.notify()` — defense-in-depth short-circuit on `turnToPick` when gate off. Extended `NotifyParams` with optional `roomId` / `tournamentId`; legacy callers without roomId pass through existing prefs logic.
- [x] Discord commands — `/pick-game`, `/nominate-picker`, `/pause-pick` all short-circuit with exact reply `"/pick-game is not available in this game room"` (plan §8). `// TODO(§8): gate /mystery-award when command is authored (Q6 — out of scope)`.
- [x] `/api/rooms/:roomId/pick-game` web endpoint — gated with 403 before queue creation, mirrors Discord-command gate so web path can't bypass.
- [x] `/api/rooms/:roomId/pick-status` response extended with `pickAwardEnabled` for authenticated UI consumption.
- [x] `/api/portal?slug=...` (public, no-auth) extended with `pick_award_enabled` for public pages that haven't logged in.
- [x] `admin-ui/src/pages/GameAvailability.tsx` — fetches gate from `/api/portal`, hides Mystery Award button, Pick column, Pick buttons (desktop + mobile), Your Picks summary, pending banner, and PickGameModal / MysteryAward render paths. Shows disabled-state banner when gate off. Subtitle copy swaps to omit pick/mystery language.
- [x] Settings UI — `ENABLE_GAME_PICK_AWARD` row added to `TOGGLE_SETTINGS` with §8 label/description. Default off (plan §17).
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean. Grep confirms 9 PickAwardGate consumers cover every pick/winner action surface enumerated in the plan audit.

Sprint 5 review gate: all three reviews required per plan (`review-code-quality`, `review-design-fidelity`, `review-ux`).

**Scores/Nav Reorg — Sprint 6: `REQUIRE_DISCORD_LOGIN` relabel + logo-badge + orphan-on-flip** — COMPLETE (2026-04-17)
- [x] Settings UI — `REQUIRE_DISCORD_LOGIN` relabeled to "Require login for score submissions" with §15 description (internal key reused per Q7). Logo section appends §9 badge copy: "A 1:1 (square) crop is also used as this room's badge on the Global Scoreboard. Non-square logos will prompt for a square crop on upload."
- [x] Migration `054_orphaned_scores` — adds `orphaned_at TEXT` column to `submissions`, `community_scores`, `score_history`, `global_scores`; indexes on each.
- [x] `src/services/OrphanService.ts` — `orphanAnonymousRows(roomId)` / `restoreOrphanedRows(roomId)` bulk UPDATE across the 4 score tables, scoped to rows where `submitted_from_room_id = ?` AND `submitted_by_user_id IS NULL`. `handleRequireLoginFlip(roomId, prev, next)` no-ops when values match, orphans on false→true, restores on true→false.
- [x] `GameRoomSettingsService` — `set()` / `saveMany()` / `delete()` capture previous value and invoke `OrphanService.handleRequireLoginFlip()` + `invalidateLeaderboardCaches()` when `REQUIRE_DISCORD_LOGIN` changes. Delete treated as flip to "false". Cache invalidation uses `LeaderboardService.invalidateAll()` + `GlobalLeaderboardService.invalidateAll()` (broad drop acceptable — orphan flips are admin-initiated and infrequent).
- [x] Central orphan filter (`AND orphaned_at IS NULL`) applied across every public-facing leaderboard surface: `LeaderboardService.recalculate()` (both UNION ALL legs), `GlobalLeaderboardService.recalculate()` + top-games-per-game query, `CommunityScoreService` (3 methods), `ScoreHistoryService` (3 methods), `RankingService` cross-tournament scoring, plus 6 direct-SQL route-handler queries (`rooms.ts`: `/leaderboard/:gameId/submissions`, `/game-availability/:tournamentId` winner subselect + all-time-highs, `/community-leaderboards` outer + top-scores inner, `/history` ROW_NUMBER subquery; `global.ts`: active players count in `/api/rooms`, recent scores endpoint). Stats/Dashboard/Milestone/LobbyFeed queries out of Sprint 6 scope per plan.
- [x] `ImageCropper` — added optional `notice` prop. When caller passes `notice="square-badge"` and source image is non-square (>1% off 1:1), overlays a cyan info banner: "This logo isn't square. Adjust the crop to pick the square region used as this room's Global Scoreboard badge." Settings.tsx wires `notice="square-badge"` only for the logo target (bg target stays unannotated).
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean.

Sprint 6 review gate: all three reviews required per plan (`review-code-quality`, `review-design-fidelity`, `review-ux`).

**Scores/Nav Reorg — Sprint 6.5: Explicit `room_members` table + backfill + RoomMembershipService** — COMPLETE (2026-04-17)
- [x] Migration `055_room_members` — table with PK `(user_id, room_id)`, source CHECK constraint (`submission`/`admin_invite`/`claim`/`backfill`), FK to `game_rooms` ON DELETE CASCADE, index on `user_id`. Backfill in same migration (idempotent via INSERT OR IGNORE) from 3 sources: `submissions` joined via games→tournaments to get room_id (Discord-authenticated only, sentinels filtered), `community_scores` (has direct `game_room_id`), and `game_room_admins`. Backfill rows tagged `source='backfill'` per plan. user_mappings skipped — no room scope so it can't generate (user, room) pairs.
- [x] `src/services/RoomMembershipService.ts` — `addMember(userId, roomId, source)` (idempotent INSERT OR IGNORE, sentinel-aware no-op for SYSTEM/COMMUNITY/ANON/empty), `removeMember(userId, roomId)` (for Sprint 11 merge/unmerge), `isMember(userId, roomId)`, `listRoomsForUser(userId)` (joins game_rooms, computes `lastActivityAt` via correlated MAX over submissions/community_scores, orders by COALESCE(lastActivityAt, joined_at) DESC).
- [x] Wire `addMember` at 3 chokepoints: `ScoreHistoryService.log()` (covers every score path — tournament, community, sync — since every write site already calls log), `AdminService.addRoomDiscordAdmin()` (Discord admin grant → `source='admin_invite'`), and the web `/pick-game` endpoint (web pick action → `source='submission'`). Anonymous-claim flow wiring deferred to Sprint 10.
- [x] Build verification: backend `tsc` clean.

Sprint 6.5 review gate: code-only — `review-code-quality.md`. Skip design/UX per plan.

**Scores/Nav Reorg — Sprint 7: Nav restructure + UserMenu dropdown + My Rooms + Stats merge** — COMPLETE (2026-04-17)
- [x] `admin-ui/src/hooks/usePickAwardEnabled.ts` — thin hook over `/api/portal?slug=…` with shared module-level cache (per slug). Returns `{ loading, enabled }`; nav suppresses the Picks tab until loading resolves to avoid flash-of-mismatched-content.
- [x] `admin-ui/src/components/UserMenu.tsx` — real dropdown (replaces flat icon row). Avatar + username trigger; chevron indicates open state. Items: My Rooms, Friends, Scoreboard display (conditional, fires `open-scoreboard-prefs`), Room admin (conditional on `arcaid_token`), Log out. Outside-click dismiss, ESC closes and returns focus to trigger, `aria-haspopup` / `aria-expanded` / `role="menu"` / `role="menuitem"`.
- [x] `admin-ui/src/pages/MyRooms.tsx` — lists rooms user belongs to; row shows logo fallback, relative-time last activity, membership-source badge (submission/admin_invite/claim/backfill). Unauthenticated state prompts Discord OAuth with `returnPath='/my-rooms'`. Wired at `/my-rooms` in `App.tsx` inside `ViewerAuthProvider`.
- [x] `GET /api/me/rooms` endpoint (in `global.ts`) — `requireDiscordUser`, delegates to `RoomMembershipService.listRoomsForUser`. Follows existing `/api/me/*` convention (plan's wording `/api/users/me/rooms` was non-literal).
- [x] `PublicStats.tsx` reworked into merged Stats page — internal Players | Games tabs via `?view=` URL param. Players view keeps existing enhanced table + search. New Games view (`GET /:roomId/stats/games-activity`) lists per-game submissions / unique players / top score / last activity, with search. `StatsService.getGameActivityStats()` uses UNION ALL across `submissions` + `community_scores` (SQLite lacks FULL OUTER JOIN) and respects `orphaned_at IS NULL`. Admin `/:slug/admin/stats` untouched (Q9). Deleted `admin-ui/src/pages/Players.tsx` (unused).
- [x] `App.tsx` — `/:slug/players` → `PlayersToStatsRedirect` (Navigate to `/:slug/stats?view=players`, replace). `/:slug/players/:id` → `PlayerDetail` unchanged. Added `/my-rooms` route. Removed `Players` import.
- [x] `PublicLayout.tsx` — final nav: `Lobby | Scores | Picks* | Stats | Global`. "Game Picks" renamed to "Picks"; route stays `/:slug/games` this sprint (rename handled in Sprint 9). Picks hidden when `!pickAwardLoading && !pickAwardEnabled`. Standalone Admin link removed from nav (now inside UserMenu). Flat icon row (avatar + Friends + prefs + logout) replaced with `<UserMenu>`.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (3.22s).

Sprint 7 review gate: all three reviews required per plan (`review-code-quality`, `review-design-fidelity`, `review-ux`). Lead UX concerns: dropdown discoverability/keyboard accessibility, Picks-tab no-flash behaviour, Stats feels like one page.

**Scores/Nav Reorg — Sprint 8: Scores page restructure — Tournaments | All Games tabs, room filter, Mystery removal** — COMPLETE (2026-04-17)
- [x] `Scoreboard.tsx` — tabs renamed `Tournament` → `Tournaments`, `Games` → `All Games`. URL state `?tab=all-games` with legacy `?tab=games` redirect. `role="tablist"` / `aria-selected` for accessibility.
- [x] `GamesTabView.tsx` — full rewrite: removed Room Games / Browse Catalogue sub-toggle, removed Mystery Award button (moves to Picks in Sprint 9), dropped `CatalogueBrowse` + `MysteryAward` imports. Single unified data flow rendering through `CardRouter` (or legacy `GameCard`).
- [x] "Played at $tag" filter toggle — pair of buttons: "All Games" (default, unfiltered catalogue) / "Played at `<RoomTag>`" (room-scoped). URL state `?played-here=1`. `RoomTag` used inline with `size={16}`, `shortTag=slug` (slugs normalize via `slice(0,6).toUpperCase()`).
- [x] Data paths: filter OFF → `/api/global/games?status=approved` paginated (48/page, Load More); filter ON → `/api/rooms/:roomId/community-leaderboards` (100 limit, no pagination). `catalogueToLeaderboard()` helper maps `CatalogueGame` onto `GameLeaderboard` shape (gameStatus `'CATALOGUE'` distinguishes source) so both sources render through the same `CardRouter` path.
- [x] Submit dispatch: `gameStatus === 'CATALOGUE'` routes to `FreeplaySubmitModal` with Discord login gate; community/room games route to `ScoreSubmitModal`. Preserves existing per-endpoint submission semantics.
- [x] Consistent search-bar slot: both tabs render an always-visible search input above the grid. Tournaments tab filters `visibleLeaderboards` by game name client-side; empty-state message distinguishes "no games match" from "waiting for active games". All Games tab debounces to backend `?search=`.
- [x] External URL callers updated: `App.tsx` `FreeplayRedirect` → `?tab=all-games`, `GlobalGameDetail.tsx` back-links (×2) → `?tab=all-games`, `Lobby.tsx` "Play a game" link → `?tab=all-games`. Grep confirms 0 residual `tab=games` / `view=catalogue` references in `admin-ui/src/`.
- [x] Dead-code removal: `admin-ui/src/components/CatalogueBrowse.tsx` deleted (only consumer was GamesTabView).
- [x] Tournament card title→detail linking unchanged (shipped in Sprint 3; verified still present).
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (2.89s), 62/62 tests pass.

Sprint 8 review gate: all three reviews required per plan (`review-code-quality`, `review-design-fidelity`, `review-ux`). Lead concerns: tab surgery didn't regress tournament card chrome (countdown timer, badges, rankings alignment); catalogue cards render acceptably without per-room style resolution (`catalogueStyleId`/`logoStyleId` all null → falls back to catalogue image); "Played at $tag" discoverability vs. default unfiltered view.

**Scores/Nav Reorg — Sprint 9: Picks page rename + Mystery Award lift + route redirect** — COMPLETE (2026-04-17)
- [x] `admin-ui/src/pages/GameAvailability.tsx` → `admin-ui/src/pages/Picks.tsx` via `git mv` (preserves history). Export renamed `GameAvailability` → `Picks`.
- [x] Mystery Award promoted from inline header button to persistent top-level hero card at the top of Picks, using `MysteryAwardIcon` (Sprint 3 themed icon, no more lucide `Sparkles`). Hero always visible; Spin button disables when `availableCount < 2` with explanatory copy.
- [x] Page copy: h1 "Picks" + subtitle "Spin the Mystery Award, or queue your next pick from available tables." Removed inline pick-award-disabled banner (page now hard-gates).
- [x] Defense-in-depth gate (plan §3): `usePickAwardEnabled(slug)` hook → early `<Navigate to={`/${slug}`} replace />` when `enabled === false`. Loading state renders spinner to avoid flash-of-Picks-UI on disabled rooms. All residual `pickAwardEnabled` conditional checks inside the rendered body removed (dead code past the early return).
- [x] Route rename in `admin-ui/src/App.tsx`: added `<Route path="picks" element={<Picks />} />`. Added `GamesToPicksRedirect` component → `/:slug/games` 301-equivalent (`<Navigate replace>`) to `/:slug/picks`, preserving query string (`?t=<tournamentId>` from stale Discord DMs still works). `games/:name` GameDetail route unchanged.
- [x] `PublicLayout.tsx` nav item path `/${slug}/games` → `/${slug}/picks` (Sprint 7 already set label = "Picks").
- [x] Discord DM link builder in `TournamentEngine.ts:847` → `/picks`. `NotificationService.buildLink(slug, '/picks')` — old DMs with `/games` still route via the Sprint 9 redirect, no disruption during rollout.
- [x] `ViewerAuthContext.tsx:164` default return path `/${returnSlug}/games` → `/${returnSlug}/picks`. `DiscordCallback.tsx:77` `player:` state fallback → `/picks`.
- [x] `GameRoomManager.tsx:141` onboarding message: "Game Availability" label → "Picks", URL → `/picks`.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (2.89s), 62/62 tests pass.

Sprint 9 review gate: all three reviews required per plan. Lead concerns: Mystery Award hero visual matches themed-icon system (Sprint 3); disabled-gate redirect is invisible to authorized users yet hard-blocks unauthorized URL access; 301 redirect preserves tournament `?t=` query param from stale Discord DMs.

**Scores/Nav Reorg — Sprint 10: Anonymous submission runtime + cooldown messaging + legacy modal deletion** — COMPLETE (2026-04-17)
- [x] Migration `056_submission_drafts` — table keyed on OAuth `state_param`, TEXT target JSON, integer score, photo path (photos live under `data/submission-drafts/`), `excludeFromGlobal` flag, `expires_at` (5-min TTL).
- [x] `src/services/SubmissionDraftService.ts` — `create` / `get` (TTL-filtered) / `consume` (deletes row + photo file) / `cleanup` (bulk sweep). Mirrors the submission-photo persistence pattern used elsewhere.
- [x] `Scheduler.startSubmissionDraftCleanup()` — cron `*/5 * * * *` sweeps expired drafts + photo files. Logs counts when non-zero.
- [x] `POST /api/rooms/:roomId/submit/anonymous-check` — public endpoint using `DiscordNicknameResolver.resolveServerNickname()` against the room's `discord_guild_id`. Returns `{ match, serverNickname, matchedField }` or `{ match: false }` when the guild isn't configured.
- [x] `POST/GET/DELETE /api/submission-drafts/:stateParam` — CRUD with multer for optional photo. Plus `POST /api/submission-drafts/:stateParam/commit` (requireDiscordUser) that server-side commits the stored draft via `CommunityScoreService.submitScore` (tournament/freeplay) or `GlobalScoreService.submit` (global), mirrors the `submissions` upsert in the tournament submit route, then consumes the draft (removes DB row + photo file).
- [x] `admin-ui/src/components/SubmissionSheet.tsx` — rewritten as a phase state machine (`form` / `checkingCollision` / `claimPrompt` / `submitting` / `committingDraft` / `success` / `error`). Cooldown warning banner replaces the legacy full-form block (plan §13 — "Submission NEVER blocked"). Claim prompt (§15) renders when `anonymous-check` returns a match; user chooses "Log in with Discord" (uploads draft, stashes sessionStorage breadcrumb, kicks OAuth) or "Continue as guest" (direct submit). `commitDraftState` prop drives the OAuth-return path: skip form, POST `/commit`, close.
- [x] `admin-ui/src/components/PendingSubmissionWatcher.tsx` — mounted in `PublicLayout`; reads `?submit-draft=<stateParam>` (with sessionStorage fallback for the target JSON, fetching from server when stale), re-mounts `SubmissionSheet` in commit mode, clears the query param on close.
- [x] `AnonymousAvatarIcon` added to `ThemedIcons.tsx`; `PlayerAvatar` routes `SYSTEM`/`COMMUNITY`/`ANON`/empty/null sentinels through the themed silhouette (skips the Discord CDN path so we never 404 on synthetic IDs, and skips the colored-letter fallback so anonymous rows read as "not a Discord user").
- [x] Call-site migration — `Scoreboard.tsx`, `GamesTabView.tsx`, `GlobalScoreboard.tsx`, `GlobalGameDetail.tsx`, and `ScoreSubmit.tsx` (standalone page) all now use `SubmissionSheet`. `ScoreSubmit.tsx` rewritten as a thin page wrapper. `CatalogueGame` type re-exported from `GamesTabView.tsx` since `FreeplaySubmitModal` was its original home.
- [x] Strangler complete: `ScoreSubmitModal.tsx`, `FreeplaySubmitModal.tsx`, `GlobalScoreSubmitModal.tsx` deleted. Grep confirms zero residual imports across `admin-ui/src/`.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (2.96s, bundle shrank ~7KB), 62/62 tests pass.

Sprint 10 review gate: all three reviews required per plan. Lead concerns (quoting plan): claim prompt wording is load-bearing (§15 "framing matters"), themed anonymous avatar visual, draft TTL correctness (no replay-after-expiry), no double-submits across the sessionStorage + server-side + commit paths, no dangling references to deleted modals.

**Scores/Nav Reorg — Sprint 11: Merge/unmerge admin flow + self-claim OAuth hook** — COMPLETE (2026-04-17)
- [x] `src/services/MergeService.ts` — fully implemented (previously a Sprint 2 skeleton that threw `NotImplemented`). Six methods: `previewMerge`, `recordMerge`, `previewReversal`, `reverseMerge`, `listMergeHistory`, `getMergeRecord`.
- [x] **Preview / record:** Scope filter `submitted_by_user_id IS NULL AND merged_from_anonymous_identity_id IS NULL AND LOWER(submitted_by_anonymous_name) = LOWER(?)`, run across all 4 score tables (submissions + community_scores + score_history + global_scores). Room scoping: community_scores via `game_room_id`, submissions via `submitted_from_room_id OR tournament.game_room_id`, history + global via `submitted_from_room_id`. Preview returns a SHA256 hash of `(identity, target, sorted rowIds, sorted frozen tournament IDs)` — confirm must echo the same hash or the service raises `MERGE_CONFLICT` with a refreshed preview for the 409 response body (plan §4 bail-out).
- [x] **Freeze rule (§3):** On merge — rows whose `submitted_during_tournament_id` references a tournament where `is_active=0 AND end_date IS NOT NULL` stay put; snapshot stores the set as `frozen_tournament_ids_at_merge`. On reversal — a row stays if EITHER its tournament was frozen at merge time OR the tournament is currently frozen (freshly checked against the DB). Post-merge logged-in submissions aren't in the snapshot, so reversal ignores them.
- [x] **Record + reverse:** Transactional (`BEGIN`/`COMMIT`/`ROLLBACK`); bulk UPDATEs across the 4 tables with `merged_from_anonymous_identity_id = ?` guard to prevent re-applying. `anonymous_identities.status` transitions: `active → merged` on merge; `merged → active` on reversal, but only when no other live merge_records row still points at that identity. `submitted_by_anonymous_name` is never touched (§15 "preserve original name" rule). Leaderboard + Global leaderboard caches invalidated on both paths.
- [x] **Admin API (six routes under `/api/rooms/:roomId/admin/identity/*`, all `requireAuth + requireRoomAccess`):** `GET /queue` (active anon identities + row counts + potential user_mappings hint), `GET /audit?limit=N` (merge_records enriched with anon nickname + target username + summary counts), `POST /preview`, `POST /merge` (409 on preview drift), `POST /:mergeId/reverse`, `GET /:mergeId` (record + fresh reversal preview for drill-down). Activity-log events: `identity_merge` + `identity_unmerge`.
- [x] **Self-claim OAuth hook:** extended `POST /api/submission-drafts/:stateParam/commit` to scan `anonymous_identities WHERE status='active' AND LOWER(server_nickname) = LOWER(draft.playerName)` in the target room after a successful submission. Each match auto-produces a `merge_records` row with `admin_discord_user_id = target_discord_user_id` (self-claim per spec §4.2). Errors are swallowed — self-claim is best-effort, the submission itself is already committed.
- [x] **Admin UI `/:slug/admin/identity`:** new `Identity.tsx` page with two sections — Pending Claims (active anon identities, target-user input, Preview button) and Audit Chain (merge records, Reverse button for unreversed entries). Preview modal shows moving-row count + frozen-tournament groups with close dates, accepts optional reason, POSTs the merge/reverse. Nav entry added to `RoomAdminLayout` sidebar under Activity. Route wired in `App.tsx`.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (3.23s), 62/62 tests pass.

Sprint 11 review gate: all three reviews required per plan — flagged as the most complex single sprint. Lead concerns (quoting spec §8): `score_ids_snapshot` exactly matches the UPDATE'd rows (integration test territory), freeze rule honored both directions (incl. tournaments that complete between merge and reversal), preview-hash bailout on drift, reversal preview distinguishes frozen rows, self-claim path still hits the freeze rule, sync-alias rename (legacy `merge-player` route) untouched.

**Scores/Nav Reorg — Sprint 12: Global Scoreboard badges + cooldown display rules + final sweep** — COMPLETE (2026-04-17)
- [x] `GlobalLeaderboardService` — `GlobalRankedEntry` grew `origin_room_slug` + `origin_room_logo_url`; `recalculate()` and `getTopScoresForGames()` SELECTs now join `game_rooms` for slug + logo. Cache-bust migration `057_global_leaderboard_cache_bust_room_fields` clears `global_leaderboard_cache` once so stale rows (lacking the new fields) never reach clients.
- [x] **Global Scoreboard row layout (§6):** `GlobalScoreboard.tsx` `PodiumSlot` and the 4th-10th rows now render a `RoomTag` badge next to the username (`logoUrl` when available, short-tag fallback otherwise). Badge is an anchor to `/scoreboard?room=<slug>`, null-room rows render no badge. `GlobalScoreboard.tsx` + `GlobalGameDetail.tsx` both sync scope with `?room=<slug>` via `useSearchParams` → resolve slug against `/api/rooms` → set scope to room_id; URL drives state so share-links render the same filtered view.
- [x] **RANK_STYLES emoji swap:** the Trophy glyph (`U+1F3C6`) on the 1st-place podium label was replaced with plain `"1st"` text (§12 final-sweep rule).
- [x] **Cooldown display rules (§13):** `LeaderboardService.recalculate()` no longer unions `community_scores`. Tournament-card leaderboards now resolve exclusively from `submissions.game_id`, which is tournament-scoped; freeplay-style community rows that don't belong on a tournament card no longer leak in. All Games / Game Detail / Global paths are unchanged (they each have their own queries that union appropriately). Migration `058_leaderboard_cache_bust_sprint12_tournament_filter` flushes `leaderboard_cache` so existing clients don't render stale unions.
- [x] **`?room=<slug>` canonicalization (§11):** `GlobalGameDetail.tsx` reads the query param, scopes its leaderboard fetch, and re-exports changes back to the URL via `setSearchParams`. Per-row badges link to `?room=<slug>` for in-page drilldown (relative URL preserves the game context). Scope dropdown stays in sync with the URL both directions.
- [x] **Final emoji sweep (§9 Layer 9):** grep across `admin-ui/src/` for Unicode ranges `U+1F300..U+1FAFF`, `U+2600..U+27BF`, `U+2300..U+23FF`: 2 hits replaced — `★` in `StarRating.tsx` → lucide `<Star>` (with `fill="currentColor"` when filled, proper `aria-label`), `⌫` in `OnScreenKeyboard.tsx` (numeric + alpha layouts) → lucide `<Delete>` with `aria-label="Backspace"`. Post-sweep grep: **0 hits**.
- [x] Build verification: backend `tsc` clean, admin-ui `vite build` clean (2.94s), 62/62 tests pass.

Sprint 12 review gate: all three reviews required per plan — this is the capstone. Lead concerns: badge rendering degrades cleanly for null-room rows; `?room=<slug>` share-URLs behave identically after refresh; cooldown removal didn't regress tournament leaderboards for rooms with real tournament history; emoji sweep is truly zero (lucide SVGs are not emoji).

**Plan complete (12/12 sprints).** Verification plan (plan §Verification plan) smoke tests outstanding — Justin will run them against staging before commit.

---

**Scores/Nav Reorg — Sprint 13: Review-driven polish pass** — COMPLETE (2026-04-17)

All 11 deferred findings from the batched review-orchestrator run addressed. Two review-gate decisions were required from Justin: Q1 invisible 44×44 tap expansion (option b), Q2 OAuth-cancel modal (recommendation), Q3 explicit `short_tag` column (option a).

- [x] **Tap target (Sprint 3 #1):** GameCard shared component + the 3 Scoreboard inline submit buttons wrapped in 44×44 transparent `<button>` with inner 36×36 visual `<span>`. `group-hover/submit` + `group-focus/submit` drive hover state on the inner span so mobile taps land anywhere in the 44×44 box. Zero visual density change per Q1 (b).
- [x] **Discord error cache (Sprint 4 #2):** `MemoEntry` gained an `ok: boolean` flag. Transient 5xx no longer pollutes the 30s window; next call retries Discord REST. Successful empty-array results still cached (they mean "no match, don't re-fetch").
- [x] **anonymous_identities race (Sprint 4 #3):** Migration `059` adds two partial UNIQUE indexes covering the `(guild_id, LOWER(server_nickname))` and `(room_id, LOWER(server_nickname)) WHERE guild_id IS NULL` cases. `AnonymousIdentityService.upsert` switched to `INSERT OR IGNORE` + SELECT — DB-level atomicity. **5 new tests** (`src/__tests__/AnonymousIdentityService.test.ts`) cover repeated upserts, case-insensitivity, 10-parallel concurrency, null-guild room fallback, and empty-nickname rejection.
- [x] **PickAwardGate invalidation (Sprint 5 #4, #5):** `GameRoomSettingsService.set/saveMany/delete` now call `PickAwardGate.invalidate(roomId)` whenever `ENABLE_GAME_PICK_AWARD` changes. `TournamentService.update/delete` also invalidate the gate for the tournament's room so `winner_picks` flips no longer stay stale up to 5s.
- [x] **OrphanService atomicity (Sprint 6 #6):** `orphanAnonymousRows` + `restoreOrphanedRows` wrapped in `BEGIN`/`COMMIT`/`ROLLBACK`. A mid-flip crash no longer leaves half a room's anonymous history orphaned and half visible.
- [x] **UserMenu keyboard nav (Sprint 7 #7, #8):** WAI-ARIA menu pattern implemented — `ArrowDown`/`ArrowUp` cycle items, `Home`/`End` jump to bounds, `Escape` closes + restores trigger focus, `Tab` exits the menu. All menuitems carry `tabIndex={-1}` (roving-tabindex-equivalent); imperative `.focus()` moves focus without making them tab-reachable from outside.
- [x] **OAuth-cancel modal (Sprint 10 #9):** `DiscordCallback` detects `error=access_denied` + `state=player:<slug>` and rewrites the stored return URL from `?submit-draft=<state>` to `?submit-cancelled=<state>`. `PendingSubmissionWatcher` picks up both cases — commit-mode on success, cancel-modal on abort. Modal copy: "You cancelled the Discord login. Your score for _<game>_ is still saved. Submit it as a guest instead?" with `[Discard]` / `[Submit as guest]`. New endpoint `POST /api/submission-drafts/:stateParam/commit-as-guest` (no auth) consumes the draft via `CommunityScoreService.submitScore` without a Discord user id. Tournament + freeplay only (global submissions still require Discord login by design).
- [x] **Identity admin responsive (Sprint 11 #10):** Pending Claims + Audit Chain rows use `sm:grid-cols-[1fr_auto] sm:items-center` (single-column stack at <640px), `break-words` on long nickname paragraphs, `w-full sm:w-auto` on action buttons. Admin surface but now clean at 375px.
- [x] **short_tag column (Sprint 8 #11 → Q3 option a):** Migration `060` adds `short_tag TEXT` to `game_rooms`. Migration `061` cache-busts `global_leaderboard_cache`. `GameRoomService.create/update` normalizes input (trim + slice 6 + uppercase → null when empty). `GlobalLeaderboardService.recalculate()` + `getTopScoresForGames()` return `origin_room_short_tag` alongside slug + logo. Frontend passes `origin_room_short_tag || origin_room_slug` as RoomTag `shortTag` — falls back invisibly when NULL. GameRoomManager gets a "Short tag (optional, ≤6 chars)" input with a placeholder showing the slug-derived default. Zod `CreateGameRoomSchema` accepts optional `short_tag: z.string().max(6).nullable().optional()`.

Also fixed in the review pass itself (pre-Sprint-13):
- `RoomMembershipService.listRoomsForUser` — `COALESCE` → `MAX(ts) FROM (UNION ALL)` so true most-recent activity wins (was returning first-non-null).
- `/submission-drafts/:stateParam/commit` global-target branch — `photoMimeType` derived from draft extension (was hardcoded `'image/jpeg'`).

Build verification: backend `tsc` clean, admin-ui `vite build` clean, **67/67 tests pass**. Migrations 059–061 run idempotently on startup.

No open findings remaining. Plan + polish pass ready for commit at Justin's discretion.

**Sprint 10: Production Hardening** — COMPLETE
**Post-Sprint Features** — COMPLETE (deployed to production)
**Community Platform Features** — COMPLETE (deployed to production)
**Player Engagement Features** — COMPLETE (deployed to production)
**Leaderboard UX Redesign** — COMPLETE (deployed to production)

### Global Scoreboard — Phase 1: Database & Catalogue Foundation (2026-04-08)
- [x] `catalogueUtils.ts` — normalizeGameName() algorithm for dedup matching
- [x] `platformMapping.ts` — canonical platform IDs, IGDB/VPS mappings, platform groups
- [x] Database: WAL mode enabled
- [x] Database: `global_games` table with UUID PKs, all enrichment fields, indexes
- [x] Database: `global_scores` table with soft-delete, photo hash, origin tracking
- [x] Database: `global_leaderboard_cache`, `sync_logs`, `score_reports`, `user_bans`, `sessions` tables
- [x] Database: migrations 037-038 (global_game_id on game_room_game_library + games)
- [x] Database: SYNC_ALERT_CHANNEL_ID default setting
- [x] `GlobalGameService.ts` — catalogue CRUD, upsert with dedup, search, merge cascade
- [x] `GlobalGameService.upsert()` — cross-type Frankenstein fix (4-step dedup: external ID → cross-type guard → IPDB URL cross-ref → strict name match). **Verified live** (2026-04-11) with sampled IGDB import — 4688 catalogue rows, 0 Frankensteins, 0 pinball-with-video-subtype contamination.
- [x] `IGDBImportService.importFromIGDB({ limit })` + `scripts/reimport-catalogue.ts --igdb-limit N --no-truncate` — sampled additive dev imports (avoids the multi-hour full IGDB run while still exercising the dedup hierarchy)
- [x] `scripts/backfill-vps-images.ts` (1075 rows patched) + `scripts/backfill-wizard-images.ts` (342 rows patched) — one-shot image backfills against the source GitHub repos
- [x] Global score submit modal: display name field with prefill from `/api/global/me/display-name`, 409 conflict on case-insensitive username collision against other Discord users
- [x] `docs/decisions/` ADR scaffold (README + 0000-template) + ROADMAP pointer + `/update-docs` skill check for decision freshness
- [x] `SyncLogService.ts` — sync log CRUD, Discord alert on failure
- [x] `VpsImportService.ts` — updated: rich metadata extraction (themes, designers, download URLs, wheel art, tutorials, rules, features), writes to global_games
- [x] `WizardImportService.ts` — updated: parses BOTH Wizard + Manual Install sections (~1125 tables), extracts table metadata
- [x] `OPDBImportService.ts` — new: bulk import from OPDB API, local image download
- [x] `IGDBImportService.ts` — new: Twitch OAuth token management, bulk seed arcade/console games, on-demand search
- [x] Admin API routes: `/admin/catalogue/sync-*`, catalogue CRUD, sync dashboard endpoints
- [x] Build verification: backend + frontend compile clean
- [x] Catalogue admin UI page (`admin-ui/src/pages/GlobalCatalogue.tsx`, 495 lines) — overview stats, sync controls with 2s polling, search/filter/pagination (PAGE_SIZE=200), expandable rows with approve/reject/delete
- [x] VPS auto-sync cron job — `Scheduler.startVpsCatalogueSync()` runs `0 2 * * 3` in `America/Los_Angeles`, calls `VpsImportService.importFromVps()`, wired from `Scheduler.start()`

**Phase 1 status: functionally complete.** Catalogue foundation (schema + services + imports + admin UI + auto-sync) is in place and verified live.

### Global Scoreboard — Phase 2: Score Model (2026-04-11)
- [x] `global_scores` schema with origin tracking, soft-delete, ban check, exclude_from_global flag
- [x] `GlobalScoreService` — submit / fan-out / soft+hard delete / list / `isBanned()`
- [x] `GlobalScoreService.fanOutFromRoomSubmission()` — room → global with dedup, opt-in check, room+game resolution hierarchy
- [x] Fan-out wired into all 4 room submission paths: `CommunityScoreService.submitScore()`, `ScoreSyncPoller` (iScored sync), Discord `/submit-score`, web `POST /:roomId/freeplay-score`
- [x] `POST /api/global/scores` — direct global submission (Discord login + photo + ban check + display name conflict resolution + opt-out)
- [x] `GlobalScoreSubmitModal.tsx` frontend with display-name pre-fill and exclude-from-global checkbox
- [x] Discord `/submit-score` `exclude_global` boolean parameter
- [x] `GET /api/global/scoreboard` (paginated catalogue with aggregates) + per-game leaderboard endpoint
- [x] `GET /api/global/games` + `GET /api/global/games/:id` (catalogue browse)
- [x] WebSocket `emitScoreNewGlobal()` — live score toasts on the global scoreboard channel
- [x] `POST /api/global/scores/:scoreId/report` — flag scores for moderation (one open report per user per score)
- [x] Room admin Settings: `GLOBAL_SCOREBOARD_ENABLED` (default on) and `REQUIRE_DISCORD_LOGIN` (default off) toggles in the Integrations card
- [x] Room `ScoreSubmitModal` per-score "Don't post to global" checkbox + wired through `POST /:roomId/submit-score/:gameName` to `CommunityScoreService` `excludeFromGlobal` option
- [x] `DELETE /api/me/global-scores/:scoreId` — user can soft-delete their own global scores (ownership verified by `player_id === req.user.discordId`)
- [x] `globalSubmitLimiter` (10/hour per Discord user) on `POST /api/global/scores`, replacing the shared 30/min IP-based `writeLimiter`
- [x] Build verification: backend + frontend compile clean

**Phase 2 status: complete.**

### Global Scoreboard — Phase 5: Global Scoreboard Page (already implemented)
- [x] `GlobalScoreboard.tsx` (400 lines) — paginated game grid with search, sort (popular/most_scores/highest_score/most_recent/name_asc), platform group chips (Physical/Virtual Pinball/Arcade & Video), scope filter (global + per-room dropdown)
- [x] WebSocket `score:new:global` → live toast notifications with optimistic card stat update
- [x] Submit button → Discord login gate → `GlobalScoreSubmitModal` (photo + display name + opt-out)
- [x] "Load More" pagination (PAGE_SIZE=30, infinite load)
- [x] Catalogue image resolution (local path → `/api/catalogue-images/` mount)
- [x] Route wired in App.tsx: `/scoreboard` → `<ViewerAuthProvider><GlobalScoreboard /></ViewerAuthProvider>`

### Global Scoreboard — Phase 7: Game Detail Page (already implemented)
- [x] `GlobalGameDetail.tsx` (553 lines) — full game detail page at `/games/:globalGameId`
- [x] Hero: cover art + wheel overlay + title + manufacturer/year/subtype/players + description + platform badges + theme tags
- [x] Designers card, Table Authors card, References card (IPDB/VPS/OPDB/IGDB links)
- [x] Downloads section — per-format download links from VPS (vpuniverse, vpforums, etc.)
- [x] Tutorials section — embedded YouTube iframes from VPS/IGDB
- [x] Rules section — linked rules documents from VPS
- [x] Leaderboard table with avatar, score, room origin, date, photo proof link, report button
- [x] Scope filter (All rooms / per-room) on the leaderboard
- [x] Score report flow with prompt and 409 duplicate check
- [x] Submit button → Discord login gate → `GlobalScoreSubmitModal` → refresh rankings
- [x] Route wired in App.tsx: `/games/:globalGameId` → `<ViewerAuthProvider><GlobalGameDetail /></ViewerAuthProvider>`

### Global Scoreboard — Phase 6: Game Room Enhancements (complete)
- [x] Backend: `POST /:roomId/freeplay-score` endpoint (photo required, global catalogue lookup, fan-out to global_scores)
- [x] Backend: scope filter on global leaderboard (origin_game_room_id)
- [x] `REQUIRE_DISCORD_LOGIN` room setting + `conditionalRequireDiscordUser` middleware
- [x] `REQUIRE_SCORE_PHOTO` room setting
- [x] `Freeplay.tsx` — room-scoped freeplay page at `/:slug/freeplay` with catalogue search/filter, game grid, photo-required submit modal, opt-out checkbox. Nav link (Joystick icon) in PublicLayout.

### Global Scoreboard — Phase 3: User Preference System (2026-04-11→2026-04-12) — COMPLETE
- [x] `PreferencesService` exists (admin theme only)
- [x] `user_preferences` table exists
- [x] Migration 040: `scoreboard_prefs` TEXT column on `user_preferences`
- [x] `PreferencesService.getScoreboardPrefs()` / `setScoreboardPrefs()` — JSON blob merge semantics (null/empty deletes key)
- [x] Device-specific preferences: nested `{ desktop: {...}, mobile: {...} }` storage with auto-migration from flat format
- [x] `GET/POST /api/me/scoreboard-preferences?device=desktop|mobile` endpoints (requireDiscordUser)
- [x] Scoreboard.tsx merges user prefs on top of room config when playerToken present, with device detection (`window.innerWidth <= 640`)
- [x] Preference hierarchy: user preference → room admin default (via config merge)
- [x] `ScoreboardPreferencesModal` — full-featured modal with ~20 settings: card style, showcase theme, UI theme, toggles, selects, zoom, advanced number prefs, mobile-specific prefs
- [x] Gear icon in PublicLayout nav bar (between username and logout) triggers modal via DOM event (`open-scoreboard-prefs`)

### Global Scoreboard — Phase 4: JWT Refresh Tokens (2026-04-11) — COMPLETE
- [x] `sessions` table exists in schema
- [x] `auth.ts`: `generateRefreshToken()`, `createSession()`, `refreshAccessToken()`, `cleanExpiredSessions()`
- [x] Refresh rotates both access + refresh tokens, re-derives role from DB (picks up permission changes)
- [x] Discord OAuth callback issues refresh token on all paths (super_admin, room_admin, player)
- [x] `POST /api/auth/refresh` endpoint
- [x] DiscordCallback.tsx stores refresh tokens (player: `arcaid_player_refresh_token`, admin: `arcaid_admin_refresh_token`)
- [x] ViewerAuthContext auto-refresh: checks every 60s, refreshes within 5min of expiry, restores expired sessions on mount
- [x] api.ts: admin 401 handler tries refresh before redirecting to login
- [x] Logout clears refresh tokens

### Tournament Rotation Bug Fix (2026-04-12)
- [x] `TournamentEngine.processSlotMaintenance()`: max_active_games guard before creating picker slots (prevents over-fill)
- [x] `TournamentEngine.processSlotMaintenance()`: duplicate picker slot guard (skips if winner already has `[Pending Pick]`)
- [x] `TournamentEngine.autoPickAndActivate()`: max_active_games guard before auto-picking from queue
- [x] `TimeoutManager.fallbackToAutoSelection()`: max_active_games guard + orphaned picker slot cleanup
- [x] `TimeoutManager.handleTieredTimeout()`: stale slot check (verify game still exists and is QUEUED before acting)

### Scoreboard UX Fixes (2026-04-06)
- [x] Inline rankings mode — when `rankingsSticky` is off (default), RankingGroupCards render inline with game cards in all 3 layouts (grid/vertical/scroll)
- [x] Rankings card style-matching — RankingGroupCard redesigned with 3 rendering paths matching Banner (280px), Showcase (380px, theme-matched), and Minimal (380px) card styles
- [x] Rankings card layout: rank + avatar + username row, points + "Games: X" below, no column headings, "OVERALL RANKINGS" title on card
- [x] QR code alignment — rankings cards add `marginTop` equal to QR code height + 4px gap (`qrTopPad`) to align with game card borders
- [x] Game title styles expanded from 5 to 12 options (matching scoreboard title styles): default, glow, neon-magenta, chrome, fire, plasma, backglass, marquee, retro, pixel, shadow, outlined
- [x] Fire title style animation — rapidly shifting gradient (background-position animation at 1.5s)
- [x] Neon Magenta title style animation — infrequent neon flicker effect (6s cycle)
- [x] Horizontal scrollbar fix — `items-start` only applied for left/right rankings positions (flex-row), not top/bottom (flex-col)
- [x] Discord avatar fallback on rankings cards — username-based avatar lookup for players with synthetic discord_user_id (SYSTEM/COMMUNITY)
- [x] RankingService: treat "COMMUNITY" discord_user_id same as "SYSTEM" (synthetic ID handling)
- [x] Service worker cache bumped to v5

### Scoreboard Card Redesign (2026-04-05)
- [x] Style+Theme 2-level card system: Banner (280px, iScored-compatible), Showcase (380px, premium art-forward with podium), Minimal (typography-only)
- [x] Showcase themes: Glass Deck (DM Sans/Mono, dark glass, pyramid podium) and Neon Circuit (Orbitron/Share Tech Mono, circuit SVGs, chip podium, animated glow)
- [x] Theme registry (scoreboardThemes.ts) — adding themes = adding config objects, no layout code changes
- [x] CardRouter dispatcher + BannerCard + ShowcaseCard + MinimalCard + ShowcasePodium + ScoreList components
- [x] Neon Circuit inline SVG assets (circuit board background, glow nodes, scanline overlay, chip podium)
- [x] StyleThemePicker settings component (style selector → theme selector → Advanced toggle)
- [x] Dual-path backward compat: new system activates only when SCOREBOARD_STYLE is explicitly set; legacy GameCard preserved
- [x] Settings.tsx: upgrade banner for legacy rooms, switch-back link for new-style rooms
- [x] deriveScoreboardConfig() with legacy migration heuristics (fullart/banner+fill → showcase, wheel → showcase, else → banner)
- [x] ScoreboardPreview, Scoreboard, KioskScoreboard all updated with dual-path CardRouter/GameCard rendering

### Scoreboard Settings UX & Card Rendering Fixes (2026-04-02)
- [x] Multi-card preview in Settings — 3 real game cards with distinct background and identifier images from style catalogue
- [x] Scale-transform preview — cards render at full size and scale down to fit sidebar, preserving pixel-accurate layout
- [x] Grid vs Scroll preview — preview mirrors actual Scoreboard.tsx rendering logic for both layout modes
- [x] Compact score entry layout — stacked vertical format (rank/avatar/name above score) for compact card style
- [x] Sticky save button — Settings page header pinned to viewport top with backdrop blur
- [x] Tournament preset no longer overlaps in preview (scale transform renders at real width)
- [x] Settings page layout widened — 50/50 split instead of flex-1 + fixed 320px sidebar
- [x] Preset grid: 2×3 grid with Custom cell always visible (amber active, gray inactive)
- [x] Renamed "Hide Scoreboard Title" → "Hide Game Room Title" with clarified description
- [x] Footer split: "Full Leaderboard →" inside glass panel, QR code outside
- [x] Glass panel opacity slider (SCOREBOARD_GLASS_OPACITY: 0-100%, default 60%) — controls fill mode glass panels
- [x] Game title auto-hide — when identifier (header) image exists, game name text is hidden
- [x] Display name field on game_library — optional override for game name on scoreboard cards
- [x] Display name propagation from game_library → games table on activation
- [x] Game title style dropdown (SCOREBOARD_GAME_TITLE_STYLE: default/glow/shadow/outlined/backlit)
- [x] Game title visibility enhancement toggle (SCOREBOARD_GAME_TITLE_ENHANCE: dark backdrop behind title text)
- [x] Score entry style setting (SCOREBOARD_SCORE_STYLE: glass/shadow/outlined/glow) — replace glass panels with text effects to let background images show through

### Scoreboard UX Overhaul (2026-04-01)
- [x] CSS container query auto-sizing text — clamp() functions scale title and score text based on card width
- [x] Layout presets — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with "Custom" auto-detection
- [x] Live preview in Settings — renders cards with current unsaved settings, updates instantly on change
- [x] Image cropper — react-easy-crop integration for branding and style uploads with locked aspect ratios
- [x] Shared config utility (deriveCardProps) — eliminates duplicated config parsing across Scoreboard, KioskScoreboard, ScoreboardPreview
- [x] Sidebar card header style (SCOREBOARD_CARD_LAYOUT: 'sidebar') — image left of game title
- [x] Card background fill toggle (SCOREBOARD_BG_FILL: off/fill) — background image fills entire card with glass-panel styling
- [x] Card background sizing (SCOREBOARD_BG_SIZE: cover/contain/tile) — controls CSS background-size
- [x] 2-column game layout (SCOREBOARD_GAME_COLUMNS: auto/2) — forces two game cards per row on desktop
- [x] Per-game logo/background images — independent logo_style_id and bg_style_id, mix backgrounds and logos from different styles
- [x] Image type selector (both/background/logo) in StylePicker and GamePickerModal
- [x] >1T score abbreviation with tooltip for scores exceeding 999,999,999,999
- [x] Smart constraint hiding — wheel scale hidden when not wheel layout, etc.
- [x] Terminology unification — "Logo" → "Identifier", "Style" → "Art Pack"

### iScored API Integration & Wheel Icons (2026-03-31)
- [x] iScored REST API client (IScoredApiClient.ts) — lightweight HTTP replacement for Playwright scraping
- [x] Score sync poller (ScoreSyncPoller.ts) — continuous background polling with configurable interval (default 30s)
- [x] Dual-path score sync: API-preferred with Playwright fallback (controlled by ISCORED_API_ENABLED)
- [x] Hot-reload for API settings (enable/disable poller, change interval without restart)
- [x] sync-state Discord command updated: API path (single HTTP call) or Playwright path (per-game scraping)
- [x] Fire-and-forget iScored sync on web score submission uses API when enabled
- [x] Winner resolution in TournamentEngine uses API with Playwright fallback
- [x] Global settings UI: ISCORED_API_ENABLED and ISCORED_API_POLL_INTERVAL exposed in super-admin panel
- [x] Wheel icon card header style (SCOREBOARD_CARD_HEADER_STYLE: 'wheel') — pinball wheel PNGs as game identifiers
- [x] Configurable wheel icon scale (SCOREBOARD_WHEEL_SCALE: 100-200%, default 150%)
- [x] Wheel icons overflow card border (transparent background, drop shadow, proper card spacing)

### Leaderboard UX Redesign (2026-03-28)
- [x] 8 new themes: backglass, crt-green, plasma, cabinet, silverball, wizard, playfield, marquee
- [x] Admin/Public theme split (admin theme per-admin, public theme room-wide via SCOREBOARD_THEME)
- [x] Discord avatar integration (avatar_hash on user_mappings, PlayerAvatar component)
- [x] Two-column score layout option (SCOREBOARD_SCORE_COLUMNS setting)
- [x] QR codes on score cards with three-state toggle (SCOREBOARD_QR_MODE: disabled/kiosk-only/all)
- [x] Standalone score submission page at /:slug/submit/:gameId (ScoreSubmit.tsx)
- [x] Viewer rank highlight for logged-in players (cyan row)
- [x] Countdown timers on game cards showing time until next maintenance (cronUtils.ts)
- [x] Kiosk enabled toggle with frontend enforcement
- [x] Game room admin activity log at /:slug/admin/activity (RoomEventService + ActivityLog.tsx)
- [x] Game library autocomplete with fuzzy match warnings
- [x] Inline platform add from Game Library page
- [x] Settings page reorganized with inline toggles
- [x] New DB table: room_events (activity log)
- [x] New DB column: user_mappings.avatar_hash
- [x] New dependencies: cron-parser (backend), qrcode (frontend)

### UX Plan Completion & Bug Fixes (2026-03-29)
- [x] Bug fix: locked game score rejection (backend 403 on non-ACTIVE games for submit-score and community-scores)
- [x] Locked game UI on ScoreSubmit.tsx (lock icon) and ScoreSubmitModal (gameStatus prop, locked state)
- [x] PWA support: manifest.json, service worker (cache-first static, network-first navigation), PWA meta tags
- [x] "Your Best" quick stat on game cards (footer: "Your best: X (Rank #Y)" for logged-in users)
- [x] Compact card header option (SCOREBOARD_CARD_HEADER_STYLE: banner/compact — thumbnail + title bar mode)
- [x] Score toast notifications (WebSocket score:new data payload → slide-down toast on scoreboard)
- [x] Platform in-use validation on deletion (GET /admin/platform-usage/:platform, error toast with tournament names)
- [x] Global game CSS override UI (GLOBAL_CARD_STYLES_ENABLED toggle + color pickers for title/scores/border/background)
- [x] Kiosk backend enforcement confirmed working (frontend checks KIOSK_ENABLED from scoreboard-config)

### Bug Fixes & Game State Management (2026-03-30)
- [x] Bug fix: timeout/queue logic — picker slot was created even when a queued game was activated, causing erroneous pick timer + reminders
- [x] Bug fix: phantom games on iScored — erroneous picker timeout cascaded to auto-selection, creating games on iScored that weren't ACTIVE in ArcAid
- [x] Admin score deletion (Trash2 icon on leaderboard, backend DELETE endpoint with cache invalidation)
- [x] Photo upload on mobile now allows gallery choice (removed capture="environment" attribute)
- [x] Game States admin page (/:slug/admin/games) — full game state management escape hatch
  - View all games with status, tournament, iScored ID, picker info
  - Force status changes (QUEUED/ACTIVE/COMPLETED) with optional iScored sync
  - Clear picker timeouts, delete phantom entries, bulk clean [Pending Pick] slots
  - Granular iScored operations (lock/unlock/hide/unhide/delete/create)
  - Force maintenance trigger per tournament
  - Confirmation modals and activity logging for all actions

### Player Engagement Features (2026-03-27)
- [x] Discord player login on public pages (OAuth → player token)
- [x] Web-based game picking from Game Availability page
- [x] Queue management (reorder, delete, max 5 per tournament)
- [x] Queue cooldown revalidation at activation time
- [x] "Your Picks" summary card with numbered queue
- [x] Auto-merge near-duplicate games during import
- [x] Mobile-responsive Game Availability layout
- [x] Scoreboard background opacity slider

### Community Platform Features (2026-03-21 → 2026-03-23)
- [x] Public stats page with enhanced metrics (avg finish position, top 5% rate, champion streak, sparklines)
- [x] Per-game player stats lookup on game detail page
- [x] Community score submissions (scores outside tournaments, community leaderboards)
- [x] Game tips & comments (player-submitted tips and comments per game)
- [x] Discord post-score rating flow (star buttons + comment modal after /submit-score)
- [x] Score history tracking (score_history table, expandable per-player history on scoreboard)
- [x] Style catalogue system (iScored style import/upload, per-game assignment)
- [x] Kiosk mode (/:slug/kiosk, auto-refresh)
- [x] Scoreboard branding (logo upload, background upload, title customization)
- [x] Session persistence on login pages (auto-redirect with valid JWT)
- [x] Removed room-level Discord bot token/client ID/secret (global-only)
- [x] Styled admin section headings (NeonCard cyan accent)

### Sprint 10 Summary
- Tier 1 Critical: Rate limiting, DB indexes, CORS, JWT validation
- Tier 2 Code Quality: N+1 fixes, maintenance mutex, WebSocket fix, TournamentForm extraction
- Tier 4 Polish: Helmet, correlation IDs, health checks, audit logging, migration versioning
- Testing Foundation: 40 tests (Vitest, in-memory SQLite)

### Post-Sprint Features (2026-03-16 → 2026-03-19)
- [x] Discord OAuth on super-admin login page
- [x] Admin invite system (one-time invite links, 48h expiry, optional Discord DM delivery)
- [x] Discord admin management (add Discord users as room admins, log in via OAuth)
- [x] Discord username resolution everywhere (accept usernames instead of numeric IDs)
- [x] UI fixes: hide Activate on super-admin library, center single room on landing, remove redundant button
- [x] Last day of month schedule support (custom `L` marker, Scheduler runtime guard for days 28-31)
- [x] VPXS Wizard Tables import (fetches from LegendsUnchained GitHub, imports with VPXS platform)
- [x] Room-scoped game imports (VPS/Wizard imports now associate games with current room)

### Previous
**Multi-Game-Room Architecture** — COMPLETE (merged to main, deployed 2026-03-16)

## Previous Sprints

- Sprint 1 (Stabilize) — COMPLETE
- Sprint 2 (Harden) — COMPLETE
- Sprint 3 (Redesign) — COMPLETE
- Sprint 4 (Phase 8) — COMPLETE
- Sprint 5 (Discord UX + Player Portal) — COMPLETE
- Sprint 6 (Schedule UX & UAT) — COMPLETE
- Sprint 7 (Platform & Mode) — COMPLETE
- Sprint 8 (Public Player Portal) — COMPLETE
- Sprint 9 (UI Themes) — ABANDONED (Gemini), reimplemented as feature
- Feature: Ranking Groups — COMPLETE
- Feature: UI Theme System — COMPLETE
- Sprint 10 (Production Hardening) — COMPLETE
- Feature: Player Engagement (Discord login, web picking, queue management) — COMPLETE
- Feature: Leaderboard UX Redesign — COMPLETE
- Feature: UX Plan Completion (PWA, global styles, compact header, toast, platform validation) — COMPLETE
- Feature: Game State Management (admin escape hatch for game/queue/iScored issues) — COMPLETE
- Feature: iScored API Integration (REST API client, score sync poller, wheel icons) — COMPLETE
- Feature: Scoreboard UX Overhaul (presets, preview, auto-sizing, image cropper, sidebar/fill layouts) — COMPLETE
- Feature: Scoreboard Preview & UX Fixes (multi-card preview, compact stacked scores, sticky save, display names, glass opacity, title styles) — COMPLETE
- Feature: Scoreboard Card Redesign (Style+Theme 2-level system, Banner/Showcase/Minimal cards, Glass Deck/Neon Circuit themes) — COMPLETE
- Feature: Scoreboard UX Fixes (inline rankings, style-matched ranking cards, 12 game title styles, avatar fallback) — COMPLETE
- Feature: User Preferences Overhaul (device-specific prefs, expanded modal, gear button in nav) — COMPLETE
- Fix: Tournament Rotation Bug (max_active_games guards, duplicate picker slot prevention) — COMPLETE
- Feature: Mystery Award & UI Fixes (canvas-based picker, logo toggle, admin inline rankings) — COMPLETE

### Mystery Award & UI Fixes (2026-04-13→2026-04-14)
- [x] MysteryAward component — replaced PinballPicker with new canvas-based backbox component (DMD 192×48 dot grid, translite renderer with GI backlight/starburst/vignette, room logo in backglass)
- [x] Room branding integration — backglass shows `room.logo_url` from `/api/rooms`, independent of scoreboard config
- [x] "Add to Queue" integration — Discord-authenticated users can queue the randomly selected game directly from the picker
- [x] Nav rename: "Games" → "Game Picks", button: "Pick Random" → "Mystery Award" (Sparkles icon)
- [x] Page description added to Game Picks page
- [x] Scoreboard logo visibility toggle — `SCOREBOARD_LOGO_ENABLED` setting lets rooms upload logos for Mystery Award backglass without showing them on the scoreboard
- [x] Admin leaderboard inline rankings — matches public scoreboard behavior (inline ranking cards when `rankingsSticky` is off)
- [x] DMD rendering fix — removed `imageRendering: pixelated` to eliminate moiré/plaid pattern at scaled display sizes

### Lobby & Social Features (2026-04-14→2026-04-15)

**Phase 0: Bug Fixes**
- [x] Admin leaderboard "View Public Scoreboard" link
- [x] Landing page carousel clickthrough to GlobalGameDetail

**Phase 1: Lobby Core**
- [x] Migration 043: `lobby_feed_events` table with indexes
- [x] `LobbyFeedService.ts` — feed event CRUD, cursor-based pagination, 90-day cleanup, WebSocket emit
- [x] `LobbyFeedGenerator.ts` — central score event generation, hooked into all 5 submission paths
- [x] Score submission hooks: CommunityScoreService (3 web routes), Discord `/submit-score`, ScoreSyncPoller
- [x] Lobby feed API: `GET/POST /:roomId/lobby/feed` (public read, admin curated posts)
- [x] WebSocket: `join:lobby`/`leave:lobby` channels + `emitLobbyEvent()` for live feed updates
- [x] Scheduler: `startLobbyFeedCleanup()` cron job (3:30 AM, 90-day retention)
- [x] `Lobby.tsx` — public lobby page with activity stream, infinite scroll, WebSocket live updates
- [x] `AllGamesView.tsx` — Scoreboard "All Games" tab: auto-cycling carousel with room card styles (CardRouter/GameCard), search bar, left/right arrows, hover-pause
- [x] Scoreboard tab toggle (Tournament | All Games)
- [x] Lobby nav item (first position, MessageSquare icon) in PublicLayout
- [x] `community-leaderboards` endpoint enhanced — returns `GameLeaderboard`-compatible data with style resolution (room library → game_library → style_catalogue), search param, rankings array + avatar hashes

**Phase 2: Lobby Content & Admin**
- [x] Migration 044: `lobby_announcements` table
- [x] Migration 045: `community_shelf_items` table
- [x] `AnnouncementService.ts` — announcement CRUD with active/scheduled/expired status
- [x] `CommunityShelfService.ts` — shelf CRUD with reorder, URL type auto-detection
- [x] Lobby config via `game_room_settings`: social links, pinned message, feed settings
- [x] API: 12 new endpoints for announcements, shelf, and lobby config (public + admin)
- [x] `LobbyAdmin.tsx` — admin page with 5 sections: social links, pinned message, announcements, community shelf, feed settings
- [x] Lobby components: SocialLinksBar, PinnedMessage, AnnouncementCard, AnnouncementsRail, FeedItem, CommunityShelf
- [x] Full 4-zone Lobby page: social links bar → announcements rail → activity stream → community shelf

**Phase 3: Tournament & Milestone Integration**
- [x] TournamentEngine hooks: 3 lobby feed events (tournament results with winner, game rotation × 2)
- [x] `MilestoneService.ts` — threshold-based milestone detection (scores submitted, unique games, #1 positions)
- [x] Milestone events emitted from LobbyFeedGenerator on score submission

**Phase 4: Social Features (COMPLETE)**
- [x] Migration 046: `friendships` table (unidirectional follow model)
- [x] Migration 047: `notification_prefs` column on `user_preferences`
- [x] `FriendsService.ts` — friend CRUD, reverse lookup for feed events
- [x] Friends API: `GET/POST/DELETE /me/friends`, notification prefs `GET/PUT`
- [x] `Friends.tsx` — global friends page with add/remove/avatar display
- [x] Friend score events in lobby feed (targeted to friend's viewer)
- [x] Friends link (UserPlus icon) in PublicLayout avatar area
- [x] Route: `/friends` with ViewerAuthProvider
- [x] `NotificationService.ts` — Discord DM dispatch with user prefs + in-memory rate limiting (5/user/hour)
- [x] 5 notification dispatch hooks: rank dethroned (LobbyFeedGenerator), friend score (LobbyFeedGenerator), tournament win (TournamentEngine), turn to pick (TournamentEngine), tournament starting (Scheduler, 15-min check)
- [x] Discord `/arcaid-notifications` slash command — show (embed), toggle per-type, enable/disable all
- [x] Registered in DiscordClient.ts (21 commands total)

**Phase 5: Polish & Engagement (COMPLETE)**
- [x] Freeplay contextual leaders — top 5 scores shown in submit modal via `/community-scores/:gameName/leaders`
- [x] Activity indicator in nav — localStorage-based last-seen tracking, cyan dot badge on Lobby icon
- [x] Kiosk lobby ticker — scrolling ticker bar at bottom of KioskScoreboard with recent feed events, auto-refresh, CSS marquee animation
- [x] Feed coalescing — `LobbyFeedService.coalesceScoreEvents()` collapses 3+ consecutive score_posted events from same player within 1 hour into summary (query-time, DB unchanged)
- [ ] Notification rate limiting & coalescing — batch 3+ same-type notifications into summary (deferred)

### Cross-Page UX Improvements (2026-04-15)
- [x] GameDetail non-tournament support — removed bail on null stats, conditional tournament tabs, default to community tab
- [x] GlobalGameDetail room context — `?from=slug` preserves room context, back link goes to `/:slug/freeplay`
- [x] Freeplay podium cards — rewritten to match GlobalScoreboard card style (RANK_STYLES, PodiumSlot, CommunityGameCard)
- [x] Global score fan-out fixes:
  - Fixed `grl.name` → `grl.game_name` in `fanOutFromRoomSubmission()` (critical — was silently killing ALL fan-out via game_room_game_library path)
  - Added 4th fallback lookup directly against `global_games` table by name
- [x] All Games cards link to GlobalGameDetail when globalGameId exists, with room context via `?from=slug`

## Last Session

**Date:** 2026-04-17
**What happened:** Twelve-sprint Scores/Nav Reorg + batched review-orchestrator pass across all nine full gates + Sprint 13 polish pass (11 findings fixed). Plan and polish complete; 67/67 tests pass; working tree uncommitted pending Justin's commit + smoke-test decision.

**Work done this session (Sprint 12 highlights):**
- **GlobalLeaderboardService:** extended with `origin_room_slug` + `origin_room_logo_url` on `GlobalRankedEntry` (both methods that feed row rendering). Cache-bust migration clears stale cached rows once.
- **Global row layout (§6):** `RoomTag` badge in `PodiumSlot` + 4th-10th list, anchor-linked to `/scoreboard?room=<slug>`. Null-room rows skip the badge cleanly. `GlobalScoreboard.tsx` + `GlobalGameDetail.tsx` both sync scope with `?room=<slug>` via `useSearchParams`, resolving slug → room_id against the rooms list.
- **Cooldown display rules (§13):** `LeaderboardService.recalculate()` no longer unions `community_scores` — tournament cards now resolve strictly from `submissions.game_id`. Freeplay rows to the same game name no longer leak onto tournament leaderboards. Migration `058` flushes `leaderboard_cache` once so clients don't render stale unions.
- **`?room=<slug>` canonicalization (§11):** `GlobalGameDetail.tsx` has full scope ↔ URL round-trip; per-row RoomTag badges link to the filtered view.
- **Final emoji sweep (§9 Layer 9):** replaced `★` (StarRating) with lucide `<Star>` + proper ARIA and `⌫` (OnScreenKeyboard, two layouts) with lucide `<Delete>`. Post-sweep grep over Unicode emoji ranges: **0 hits**.
- **RANK_STYLES** trophy glyph on 1st-place podium label: replaced with plain `"1st"` text.
- **Build verification:** backend `tsc` clean, admin-ui `vite build` clean (2.94s), 62/62 tests pass.

**Earlier in this session (Sprints 8–11):** Scoreboard tab restructure + `RoomTag`-based "Played at $tag" filter; Picks page rename with Mystery Award hero + 301 redirect + Discord DM link rewrite; unified `SubmissionSheet` with anonymous collision prompt + OAuth draft handoff + themed anonymous avatar; MergeService with freeze-rule on both directions + admin UI + self-claim hook.

**Git state:** On `main`, uncommitted — the full 12-sprint delta sits on the working tree. Justin decides commit cadence.

**Next up:**
- Commit strategy + deploy (working tree has the full 13-sprint delta)
- Verification-plan smoke tests (plan §Verification plan) — manual, Justin-driven, staging-first
- Discord Bot Multi-Room (Phase 5) — deferred, not part of this plan

## Blockers

(none)
