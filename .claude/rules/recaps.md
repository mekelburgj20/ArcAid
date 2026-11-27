---
paths:
  - "src/services/RunRecap*.ts"
  - "src/services/RunRollupService.ts"
  - "src/services/SeasonRecapService.ts"
  - "src/utils/runRecap*.ts"
  - "src/utils/machinePlay.ts"
  - "src/types/runRecap.ts"
  - "src/api/routes/recaps.ts"
  - "admin-ui/src/components/recap/**"
  - "admin-ui/src/components/RecapPrivacySection.tsx"
  - "admin-ui/src/lib/recap*.ts"
  - "admin-ui/src/lib/runRecapTypes.ts"
---
# Run recaps, "By the numbers" (B31) — rules

Loads when you touch run recaps: `RunRecapService`, the recap routes, the Discord recap text, the recap preferences, the recap UI. Plan (the contract, with every name and rule): `docs/run-recap-plan.md`. Cross-cutting invariants live in the root CLAUDE.md. One section per slice; a slice writes only inside its own section.

## B31.1 — service, endpoints, Discord text, two preferences

- **A run is one `games` row with `tournament_id IS NOT NULL` and status ACTIVE / COMPLETED / ARCHIVED.** A pinned board, a QUEUED/SCHEDULED game, a Throwdown or another room's game answers 404. Its rows are EXACTLY the board's rows: a rotation run reads `score_history` by (room, `submitted_during_tournament_id`, name) plus `gameRunWindowByIdSql`; an event round reads `EventResultService.roundRowsWhere` (extracted from `getRoundBoardDetail`, so the recap and the round board share one predicate). Never `score_history.game_id` for a rotation run. Nothing is cached per run: a delete or correction shows on the next read.
- **"A game" is a Witness play, and the ONE definition is `src/utils/machinePlay.ts`** (`MACHINE_PLAY_SOURCES = ['vpx']`, `isMachinePlay`, `machinePlaySql`). `atgames` is NOT a play source (one best per player, not one game). The planned global rankings read the same file: no other file lists play sources. Typed / synced rows (`tournament`, `community`, `sync`, `atgames`) count only for best score, finish place and the who-led timeline, never for games, average, median, sessions, streaks, personal bests, per-day counts or an award. `created_at` of a `vpx` row is the game's END time: copy says "games ... between", never "started".
- **Identity key = the board's own partition:** rotation `COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))`; event round `EventResultService.IDENTITY_KEY_SQL`. The key ships as `RecapPlayerRef.key` (a React key, the detail route) and is never rendered. Names and avatars attach at READ from the hydrated `LeaderboardService.getRunStandings` entries; a name is never stored.
- **Compute is pure** (`runRecapCompute.ts`: no DB; it imports `isMachinePlay` and the score formatters of `runRecapText.ts`). Sessions: a gap over `SESSION_GAP_MIN` (20) starts a new one. A new leader needs a STRICTLY greater best; the leader improving is a lead step, not a lead change. A personal best counts game #1. Awards: tie of up to 3 shares, 4 or more omitted, every qualifying award in catalogue order (9 ids, so the opt-in Night owl / Early bird are never squeezed out); the Discord text trims awards to 4 only under its character budget.
- **Privacy is enforced server-side before anything is serialized (owner ruling 2).** `user_preferences.recap_play_stats` (NULL = shown, 0 = hidden) and `recap_time_of_day` (1 = on). A hidden player's stat fields are `null`, they win no award, and their Witness rows are excluded from EVERY aggregate (totals, per-day, facts), so volume cannot be inferred by subtraction; they stay in standings and the lead timeline. Clock times (per-game `time`, `hours`, Night owl / Early bird) exist only for opted-in players. `PreferencesService.getRecapPrefsFor(keys)` reads the union of raw + canonical ids (hidden if ANY says hidden; time of day from the canonical id). Every recap-pref setter bumps `getRecapPrefsVersion()` (B31.4's cache watermark).
- **Event rounds under `witness_flag_mode = 'prevent'`** drop every `flagged` row from the recap entirely (best, standings, timeline AND play counts), through `getEventRoundOverlays`' verdicts. Rotation runs remove nothing.
- **One zone per run:** `resolveTimezone(cadence.timezone, roomTimezone)`; day keys are `YYYY-MM-DD` local, DB times are parsed with `dbTimeMs` (bare = UTC). Per-day buckets list zero days; a span over 14 days buckets by week (Monday).
- **Routes (`src/api/routes/recaps.ts`, public reads, `roomVisibilityGate`):** `GET /api/rooms/:roomId/runs/:gameId/recap`, `.../recap/players/:playerKey`, `GET /api/rooms/:roomId/tournaments/:tournamentId/runs/live`. Later slices insert ONLY between their own `// ===== B31.n ... =====` markers.
- **`RunRecapService.summarizeRuns(roomId, filter)` is the bulk read** B31.3 and B31.4 consume (computed runs + one `RecapPlayerRef` per key); they never query score rows themselves.
- **Discord text** (`runRecapText.ts`): `buildRunRecapText` (<= 4000, Nitro copy), `splitRecapForBot` (<= 2000 per bot message, max 3, at section boundaries, never inside a code block). No emoji; names `display_name ?? iscored_username`; names are cut to 16 code points only inside code blocks; markdown in names is escaped outside them. The footnote always says only Witness games count for games / averages / medians.
- **Links:** server `tournamentRunRecapUrl` (`publicLinks.ts`) ≡ FE `tournamentRecapPath` (`lib/tournamentLinks.ts`): the results link plus `&recap=1`. Change both.
- **Shared types live twice:** `src/types/runRecap.ts` ≡ `admin-ui/src/lib/runRecapTypes.ts` below the `// ==== BODY` marker (parity test). `lib/recapFormat.ts` `formatRecapScore` ≡ server `abbrevScore`.
- **Migration 224** adds the two columns and creates `run_recap_posts` (B31.5's ledger) so B31.5 never touches `database.ts`.
- **The fixture** `src/__tests__/fixtures/run-recap-lis.json` is an ANONYMIZED real run (Player A.., fake ids; scores and times real). Never commit real names or ids from prod extracts.

## B31.2 — the recap on the run view

(placeholder: B31.2 fills this section)

## B31.3 — a player's runs and a table's runs

- **`RunRollupService` only reduces `RunRecapService.summarizeRuns`** (never score rows). Routes: `GET /api/rooms/:roomId/players/:identifier/runs` and `.../tables/:gameName/runs` (B31.3 marker block of `recaps.ts`).
- **Player identifier = the `/stats/enhanced/player/:identifier` rule:** a provider id is the key; a name is `[user_mappings.discord_user_id (NOCASE) if any, 'iscored:' + lower(name)]`. Two keys in one run: the better finish. Active runs first, then newest end first.
- **Privacy is the compute's:** a hidden player (ANY key with `recap_play_stats = 0`) gets `games`, `average`, `best_game_no` null and `play_stats: 'hidden'`; their Witness games are already absent from `detail` and `facts.most_games`, so the table median and "most games in one run" cannot leak them. Best, finish and field stay (standings facts).
- **Table roll-up:** completed/archived runs only (an active-only table has `runs: 0` and the panel renders nothing); typical winning score = median of the runs' winning bests; median game = median of visible Witness games; even counts round the mean of the middle two.
- **FE:** `components/recap/PlayerRunsList.tsx` (mounted after Recent Scores) and `TableRunsPanel.tsx` (before Past Results), both `roomFetch` + `useRetryingLoad`, render nothing until an answer; links through `tournamentRecapPath`.

## B31.4 — season recap and room records

- **`SeasonRecapService` only REDUCES `RunRecapService.summarizeRuns`** (`seasonRecap(roomId, tournamentId)`, `roomRecords(roomId)`); it never queries score rows to compute a figure. Completed runs only. Hidden players already carry null games and are out of every run aggregate, so no volume award names them and their games are in no total; a standings line with a hidden player has `games: null`.
- **Season awards** (`SEASON_MIN`): Most runs won (>= 2), Played every table (>= 3 runs; more than 3 players: empty `player_keys`, detail "N players"), Most games (>= 10 shown), Closest finish, Most lead changes (>= 3), Biggest comeback (>= 25%), Biggest winning margin. Player ties share up to 3, 4 or more omit the award. Run-level awards pick one run (a tie goes to the earliest finished) and carry a `run` link. Biggest margin is the same ratio as Closest finish read from the other end, so it is skipped when it would name the same run (owner Q2 default). `detail` never holds a name.
- **Room records cache** is `Map<roomId, { watermark, value }>` and stores ids only. The watermark is `COUNT/MAX(id)/SUM(score)` of the room's `score_history` + count/last end of finished games + `getRecapPrefsVersion()` (a delete moves COUNT, a correction SUM, an opt-out the version). `resolveRefs` attaches names AFTER the cache read (one small lookup by key: `submitted_by_user_id`, else the `iscored:` alias row, else a `user_mappings` alias, then `resolveProfiles`), so a rename never needs a recompute. `clearRoomRecordsCache()` is for tests.
- **UI:** `components/recap/SeasonRecapView.tsx` (tournament page, `?view=numbers`; also exports `namesOf`), `components/stats/RoomStatsView.tsx` (the Stats "Room" tab, `?view=room`; WORK.md B7 adds its sections BELOW `RoomRecordsSection`) and `RoomRecordsSection.tsx`. Names come from the response's `players` by key; a key is never rendered.

## B31.5 — post the recap to Discord when a run ends

- **A run's recap is posted by a SWEEP, never a hook in the close paths** (five places close a run; `TournamentEngine` / `EventScheduler` are untouched). `RunRecapPostService.sweep` (Scheduler `startRunRecapPostSweep`, every minute, reentrancy flag) takes COMPLETED / ARCHIVED rotation and event-round runs of a room whose `end_date` is 10 min to 6 h old (`RECAP_POST_SETTLE_MS`, `RECAP_POST_MAX_AGE_MS`) with no `run_recap_posts` row, and for rooms with `DISCORD_RUN_RECAPS_ENABLED` on (read only through `parseRunRecapsEnabled`, `src/utils/discordRunRecaps.ts`; off = NO ledger row, so turning it on later still posts runs inside the window).
- **The ledger is the idempotency:** `INSERT OR IGNORE` the claim, act only on `changes === 1`; the row ends `posted` (channel, message ids), `skipped` (`no_channel`: Discord off / a `none` route; `no_scores`: no players) or `failed` (`send_failed` / `exception`), and a failed run is never retried. Channel = kind `recaps` through `resolveAnnouncementChannelId` (the tournament's `recaps` route, else its own `tournament` route (`none` = quiet), else the catch-all, then the room route, else the room Tournament posts route, else the room default). Text = `splitRecapForBot(buildRunRecapText(recap, {maxChars: DISCORD_COPY_MAX, link}), DISCORD_BOT_MAX)`; chunk 1 to the channel (a forum makes a post titled "<game> by the numbers"), the rest into its thread, `allowed_mentions: {parse: []}`.
- **Activity:** like score posts, only a FAILED send is an activity row (`sendChannelMessage` -> `recordBotPostFailure`); a success or skip is read from `run_recap_posts`, not the Activity tab.
