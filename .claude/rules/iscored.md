---
paths:
  - "src/engine/IScored*.ts"
  - "src/engine/ScoreSyncPoller.ts"
  - "src/engine/TournamentEngine.ts"
  - "src/engine/TimeoutManager.ts"
  - "src/engine/gameCreation.ts"
  - "src/engine/Scheduler.ts"
  - "src/services/IScored*.ts"
  - "src/utils/iscored*.ts"
---
# iScored integration, session registry, snapshots, cleanup — rules

Loads when you touch the iScored clients, sync poller, tournament engine/cleanup, or iScored credentials. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## API vs Playwright
- **`IScoredApiClient` (HTTP, fast) is the default for score read/write.** `IScoredClient` (Playwright) is required for game management (hide/create/delete) and is the fallback when the API can't satisfy a call. `ISCORED_API_ENABLED` gates the path.
- **`ScoreSyncPoller` runs continuous background sync** (default 10s tick) with pause/resume during maintenance. Settings hot-reload through `SettingsService`.

## Session registry
- **Every Playwright iScored mutation goes through `IScoredSessionRegistry.withSession(creds, fn)`** (singleton, `src/engine/IScoredSessionRegistry.ts`). Calls for the same iScored account chain serially, one `fn` at a time per account; the client is held across calls within a 1.5s idle TTL so cron-fire batches reuse one Playwright login. (v2.10.0, ADR 0012)
- **`new IScoredClient(...)` is allowed only inside the registry's `acquireClient`.** Every other call site (TournamentEngine, TimeoutManager, gameCreation, IScoredSubmitSync, the four rooms.ts admin endpoints, the four Discord commands, the admin backup endpoint) acquires sessions via the registry. Per-call clients caused dropdown-state-flip contention (rtx_pinball Wed 22:00 fire): `IScoredClient.deleteGame` short-circuited with `Game '<name>' not found in dropdown. Skipping delete.` and the local DB went HIDDEN while iScored kept the entry.
- **`deleteGame` returns `Promise<boolean>`.** `false` = dropdown short-circuit (entity not found), `true` = completed delete. Callers (`runCleanup`, `deleteGameCompletely`, the rooms.ts admin endpoints) branch on the result and log accurately.

## Notification-gated polling
- **Each tick fetches iScored's static `/notifications/rooms/room_<roomID>.txt` per account;** the expensive `getAllScores` fires only when the body changed or the 10 min backstop elapsed. `IScoredNotificationGate` owns the cache + decision. (v2.10.0; reason: 500K queries/month vs ~10 real scores, iScored asked 2026-04-29.)
- **roomID is auto-discovered** from the public `roomCommands.php?c=getRoomInfo&user=<slug>` endpoint at first poll (undocumented, not under `/api/`, used by iScored's own iframe). `ISCORED_ROOM_ID` env overrides for the env-fallback account only. Discovery failure = one-time WARN + backstop-only polling for that account.
- **Backstop interval** is `ISCORED_API_POLL_BACKSTOP_MS` (default 600000).

## Room snapshots
- **iScored has no undo, so every destructive path snapshots the room first.** `IScoredSnapshotService.captureBeforeMutation(client, creds, reason, roomIds)` is called INSIDE the existing `withSession` callback (reuses the session) at `runMaintenanceInternal`, standalone `runCleanup`, `deleteGameCompletely`, `unpinGameFromScoreboard`, both admin game deletes and the reconcile POST. (v2.117.0)
- **Add the hook to any new path that calls `deleteGame`.** Lock/hide toggles are reversible and deliberately unhooked.
- **Capture never throws into the caller** (ERROR log, mutation proceeds) and is debounced per account (`creds.username` lowercased, 10 min default) so a multi-tournament cron wave writes one file.
- **Snapshot = `data/iscored-snapshots/<gameroom>/<ts>.json`:** games with hidden/locked/tags via `getGamesOnIScored()` + scores via the public `getAllScores` (shared normaliser `normalizeIScoredScoreResponse` in `src/utils/iscoredScores.ts`); no photos/styles/score ids.
- **Schedule and UI:** nightly 04:00 sweep + 30-day prune in `Scheduler.startIScoredSnapshotCron`; super-admin list/snapshot-now/download/delete/restore on `/admin/backups`.
- **Restore recreates only games MISSING on iScored** (name-matched, apostrophes stripped), replays per-player bests while the game is open, then applies hidden/locked, and re-links `games.iscored_id` old to new. Dates and ids are not preservable (the API accepts name+score only).
- **Under vitest the capture is inert unless the test calls `setRootForTests`** — otherwise unrelated maintenance tests reach the real iScored API with `.env` creds.
- **Settings:** `ISCORED_SNAPSHOTS_ENABLED` (default on) / `ISCORED_SNAPSHOT_DEBOUNCE_MS` / `ISCORED_SNAPSHOT_RETENTION_DAYS` — env or global settings, no UI.

## Per-room delete kill-switch
- **`ISCORED_ALLOW_DELETE='false'` in `game_room_settings` means NO code path may `deleteGame` on iScored for that room.** `iscoredDeletesAllowed(roomId)` in `src/utils/iscoredCreds.ts` is checked BEFORE any session is acquired, at all seven `deleteGame` call sites: cleanup archives locally only; deleteGameCompletely/unpin/admin removes report `iscoredStatus:'skipped'`; sync-iscored `delete` + Reconcile POST return 409. (v2.120.0)
- **Lock/hide/create/submit/reorder are unaffected.**
- **Any new `deleteGame` caller must check it** (and add the snapshot hook). It exists because rooms can bridge to an iScored board they don't own (rtx_pinball -> the RTX group's `RTX_Pinball` room, 2026-08-20); their historical boards must survive Arcaid's cleanup rules.

## Deactivate vs. Delete
Two distinct admin actions on an ACTIVE game, both on the Tournaments admin page.
- **Deactivate** — `TournamentEngine.deactivateGame()` and `processSlotMaintenance()` (cron rotation). End-of-round semantics:
  1. `finalSyncScoresForGame()` pulls iScored scores into `submissions` + `score_history` so anything between the last poll cycle and now is captured.
  2. `setGameStatus({ locked: true })` on iScored (skipped as `'shared'` when another ACTIVE row owns the same `iscored_id`).
  3. Mark COMPLETED. `iscored_id` is intentionally KEPT non-NULL so `runCleanup` can still delete the board.
- **`runCleanup` selects EVERY `COMPLETED` game with `round_no IS NULL`** (v2.155.6). A row with no `iscored_id` (room had iScored off when it activated) archives locally straight away; a row with one goes through the delete / kill-switch / shared-session paths; no iScored session is opened when nothing remote needs deleting. Do not re-add `AND iscored_id IS NOT NULL` (native-only rooms never archived; RTX Daily Grind, 2026-09-09).
- **Event rounds are never cleanup candidates** (the event clock owns them); `isDynastyBlocked` accepts an ARCHIVED previous slot for the same reason. Archiving NULLs the purged photo's url on `submissions` and `global_scores` too.
- **Discord `/run-cleanup force:true`** runs a `scheduled`-mode tournament's pass on demand (it otherwise fires only on its cron).
- **Delete** — `TournamentEngine.deleteGameCompletely()` at `DELETE /api/rooms/:roomId/games/:id`. Destructive variant for "wrong game in wrong tournament":
  1. Final sync (same as above).
  2. `deleteGame()` on iScored (also `'shared'`-guarded).
  3. Orphan local scores: `UPDATE submissions/score_history SET game_id = NULL` and `global_scores SET origin_game_id = NULL` (ADR 0005).
  4. `DELETE FROM games`.
  Score records are kept (personal history preserved); the games row and its leaderboard are gone.

## Poller dedup
- **The duplicate-DM bug (WHO dunnit / rtx_pinball, 2026-04-27) is killed by the SyncPoller's `ORDER BY`** (status pref then `created_at DESC`, see `ScoreSyncPoller.pollOneAccount`): even when legacy rows share an `iscored_id`, the poller picks the ACTIVE one and matches the existing `submissions` row by id.
- **`finalSyncScoresForGame` is shared by Deactivate and Delete;** it never fires `LobbyFeedGenerator.onScoreSubmitted` (data capture only, no live events).
