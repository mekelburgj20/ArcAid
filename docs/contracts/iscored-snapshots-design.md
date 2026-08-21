# iScored room snapshots — design (2026-08-20, session #86)

Owner ask (session #85): rollback safety before onboarding the RTX group onto iScored-backed tournaments.
Ordering accepted: fix (done v2.116.1) → snapshots → snapshot the RTX room → engine-scoped VR arc.

## What a snapshot is

One JSON file per iScored gameroom per capture: `data/iscored-snapshots/<gameroomName>/<ISO with : and . replaced by ->.json`
(same timestamp format as BackupManager dirs, e.g. `2026-08-20T14-03-11-123Z.json`, so the same regex parses the age).

```jsonc
{
  "v": 1,
  "capturedAt": "2026-08-20T14:03:11.123Z",
  "reason": "maintenance" | "cleanup" | "reconcile" | "admin-delete" | "delete-game" | "unpin" | "nightly" | "manual",
  "account": { "gameroomName": "rtx_pinball", "publicUrl": "...", "username": "...", "source": "room" | "env" },
  "roomIds": ["<arcaid room ids sharing this account>"],
  "gamesCaptured": true,            // getGamesOnIScored succeeded
  "scoresCaptured": true,           // getAllScores succeeded
  "scoresError": "optional message",
  "counts": { "games": 42, "scores": 913 },
  "games": [
    { "id": "105336", "name": "Bad Cats", "hidden": false, "locked": false, "tags": ["weekly"],
      "scores": [ { "name": "Krobs", "score": 12345678, "date": "...", "rank": "1" } ] }
  ],
  "orphanScores": [ /* score entries whose game id matched no game in the list — kept, never dropped */ ]
}
```

Sources (both already exist, both cheap — no DOM driving):
- games: `IScoredClient.getGamesOnIScored()` (in-page fetch `/settingsCommands.php?c=getGameNames`) — needs the authenticated session → always runs INSIDE `IScoredSessionRegistry.withSession`.
- scores: `new IScoredApiClient({ publicUrl: creds.publicUrl }).getAllScores()` — public REST, flat `{scores:[{name,game,gameName,score,date,rank}]}`. Group by `entry.game ?? entry.GameID`. Reuse the poller's normalisation: extract the private `ScoreSyncPoller.normalizeScoreResponse` (`ScoreSyncPoller.ts:541`) into `src/utils/iscoredScores.ts` as `normalizeIScoredScoreResponse(data): IScoredApiGameScores[]` and have the poller call it (pure move, no behaviour change; leave the `syncstate.ts` duplicate alone).
- NOT captured: photos, per-game style (syncStyle is DOM-driven per game — too slow for a pre-run hook), score ids (API has none).

`getGamesOnIScored()` returns `[]` on transport failure — treat `[]` as "verified empty" ONLY if a second call also returns `[]`; otherwise `gamesCaptured=false`. Always still write the file (a partial snapshot beats none) and log WARN naming what is missing.

## Triggers

1. **Pre-mutation (automatic, debounced).** `IScoredSnapshotService.captureBeforeMutation(client, creds, reason, roomIds)`:
   - never throws into the caller (catch → `logError` — ERROR not WARN, this is the safety net failing — then continue; tournaments running beats snapshots existing);
   - debounced per account key (`creds.username.toLowerCase()`, same as the registry) — skip if a capture for that key SUCCEEDED within `ISCORED_SNAPSHOT_DEBOUNCE_MS` (default 600000 = 10 min). Wed 22:00 on rtx_pinball = 4 weeklies + DG on one account → exactly one snapshot. In-memory map; `force` flag bypasses.
   - Hook sites (destructive paths only; lock/hide toggles are reversible and skipped). All are already inside a `withSession`, so pass the session's `client` — no extra login:
     - `TournamentEngine.runMaintenanceInternal` — inside the `withSession` callback, BEFORE `runMaintenanceWork` (`TournamentEngine.ts:803`). reason `maintenance`.
     - `TournamentEngine.runCleanup` standalone session (`:2151`). reason `cleanup`. (When cleanup runs inline from maintenance the maintenance snapshot already covers it — the debounce makes this free.)
     - `TournamentEngine.deleteGameCompletely` (`:412`). reason `delete-game`.
     - `gameCreation.unpinGameFromScoreboard` (`:177`). reason `unpin`.
     - `rooms.ts` reconcile POST (`:7046`) reason `reconcile`; admin deletes `:6675` and `:6748` reason `admin-delete`.
2. **Nightly cron.** New Scheduler task `__iscored_snapshot__`, `0 4 * * *` in BOT_TIMEZONE (after the 22:00 maintenance/cleanup wave and the 03:xx housekeeping crons). Iterates ALL enabled accounts: new helper `getIScoredAccounts(): Promise<Array<{ key: string; creds: IScoredCreds; roomIds: string[] }>>` in `src/utils/iscoredCreds.ts` (groups `getIScoredCredsForRooms` over `SELECT id FROM game_rooms` by `${gameroomName}::${publicUrl}` — the same grouping the poller does inline at `ScoreSyncPoller.ts:221-229`; DO NOT refactor the poller to use it in this PR). Per account: `registry.withSession(creds, client => service.capture(client, creds, 'nightly', roomIds, { force: true }))`, then prune. Gated by global setting `ISCORED_SNAPSHOTS_ENABLED` (default ON when unset — unlike backups, this must work out of the box). Failures per account isolated + logged.
3. **Manual.** Super-admin "Snapshot now" → all accounts, reason `manual`, force.

## Retention

`prune(retentionDays = ISCORED_SNAPSHOT_RETENTION_DAYS ?? 30)` per gameroom dir: delete files older than N days by parsed filename timestamp (birthtime fallback), NEVER delete the newest file in a dir. Run after nightly and after manual capture.

## Restore

Purpose: put a wrongly-deleted game (and its scores) back so the poller resumes syncing it. Super-admin only. Two steps, dry-run first, exactly like the Reconcile flow.

`IScoredSnapshotService.planRestore(snapshot, liveGames, localRows, gameIds?)` (pure):
- selected = snapshot games filtered by `gameIds` (default all);
- `alreadyPresent` = selected whose name matches a live game after normalisation (trim, lowercase, apostrophes removed — `createGame` warns iScored strips apostrophes);
- `toCreate` = the rest, each with `scoreCount` (per-player BEST only — iScored keeps one best per player and rejects lower scores, so replaying every entry is noise) and `localGameRows` = `games` rows whose `iscored_id = snapshotGame.id` (these will be re-linked).

`executeRestore(client, creds, plan)` per `toCreate` game, sequential:
1. `client.createGame(name)` → newId (iScored assigns a NEW id — cannot be preserved);
2. `client.setGameTags(newId, tag)` ONCE PER TAG (the method types one tag + Enter; do not comma-join);
3. `client.setGameStatus(newId, { hidden, locked })` from the snapshot;
4. scores: per player best, `IScoredApiClient.submitScore(newId, name, score)` when `ISCORED_API_ENABLED !== 'false'`, else `client.submitScore(newId, name, score)`. Count `submitted` / `rejected` (rejections are logged, never abort the game);
5. `UPDATE games SET iscored_id = ? WHERE iscored_id = ?` (old → new) — this is what makes the poller pick the game back up;
6. collect `{ snapshotId, newId, name, scoresSubmitted, scoresRejected, relinkedLocalGames }`; a throw on one game is recorded and the loop continues.

Known, documented losses: score DATES become restore time (iScored accepts no date); iScored game IDs change; photos are not restored; only per-player best scores come back. The admin modal states all four before the Execute button.

## API (admin.ts, router-level requireAuth + requireSuperAdmin, audited via the existing middleware)

- `GET    /api/admin/iscored-snapshots` → `[{ gameroom, name, capturedAt, reason, games, scores, size, gamesCaptured, scoresCaptured }]` newest first (parse the JSON — files are small).
- `POST   /api/admin/iscored-snapshots` → snapshot all accounts now → `{ results: [{ gameroom, ok, name?, error? }] }`.
- `GET    /api/admin/iscored-snapshots/:gameroom/:name/download` → the JSON file.
- `DELETE /api/admin/iscored-snapshots/:gameroom/:name`.
- `POST   /api/admin/iscored-snapshots/:gameroom/:name/restore` body `{ dryRun: boolean, gameIds?: string[] }` → dryRun: the plan; else the execution report. Resolve creds by `gameroom`: the account from `getIScoredAccounts()` whose `creds.gameroomName === gameroom` (404 if the account no longer exists). Runs inside `registry.withSession`.
- Param validation: `gameroom` `/^[A-Za-z0-9_-]{1,64}$/`, `name` = the timestamp filename regex + `.json`; resolve with `path.join` + verify the resolved path stays under the snapshot root (same guard style as `isValidBackupName`).

## Admin UI

`admin-ui/src/pages/Backups.tsx` gains an "iScored snapshots" section below the DB backups (same NeonCard/DataTable/NeonButton/useToast idiom): table (Gameroom · Captured · Reason · Games · Scores · a "partial" flag when either captured flag is false) with per-row Download / Restore / Delete, header button "Snapshot now". Restore opens a modal: dry-run plan (checkbox per `toCreate` game, `alreadyPresent` listed greyed), the four loss caveats, Execute → report. Two-step confirm for Delete (reuse the page's pattern).

## Tests (vitest; NO playwright — use `IScoredSessionRegistry.setClientFactoryForTests` fake client + `vi.mock('../engine/IScoredApiClient.js')` like `iscored-provenance.test.ts`)

1. capture writes the v1 shape; scores grouped under the right game; orphan scores preserved; API throw → `scoresCaptured:false` + `scoresError`, file still written.
2. debounce: second capture for the same account within the window is skipped; different account not skipped; `force` bypasses; a FAILED capture does not arm the debounce.
3. prune: deletes older-than-N, keeps newest per gameroom, ignores non-matching filenames.
4. planRestore: present-vs-missing by normalised name; per-player best; `gameIds` filter.
5. executeRestore with the fake client: create → one setGameTags call per tag → setGameStatus → submit per-player best → local `games.iscored_id` relinked; one game throwing does not stop the next.
6. param guard: traversal names rejected (400/404, no FS access).
7. `runMaintenanceInternal` invokes `captureBeforeMutation` with reason `maintenance` before any slot work (spy).
8. `normalizeIScoredScoreResponse` extraction: the existing poller tests must stay green unchanged.

## Out of scope (say so in the PR)

Photos; style capture; per-score ids; refactoring the poller onto `getIScoredAccounts`; a settings UI for the three new keys (env/global-settings only, defaults are correct).
