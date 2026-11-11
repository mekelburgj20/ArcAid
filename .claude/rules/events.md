---
paths:
  - "src/engine/EventScheduler.ts"
  - "src/engine/SeasonScheduler.ts"
  - "src/services/Event*.ts"
  - "src/services/Throwdown*.ts"
  - "src/services/SeasonPoll*.ts"
  - "src/services/DashboardService.ts"
  - "src/services/WitnessAdminViewService.ts"
  - "src/utils/openCard.ts"
  - "src/utils/discordPolls.ts"
  - "src/utils/gameLibraryDefaults.ts"
  - "admin-ui/src/components/Event*.tsx"
  - "admin-ui/src/components/Season*.tsx"
  - "admin-ui/src/components/Throwdown*.tsx"
  - "admin-ui/src/components/DismissibleNotice.tsx"
  - "admin-ui/src/pages/Event*.tsx"
  - "admin-ui/src/pages/Throwdown*.tsx"
  - "admin-ui/src/pages/Lobby.tsx"
  - "admin-ui/src/pages/RoomAdminWitness.tsx"
  - "docs/season-format-plan.md"
---
# Live Events, Throwdowns, Seasons and Pick by poll — rules

Loads when you touch the event clock, event/Throwdown services and pages, or the Season/poll queue. Cross-cutting invariants live in the root CLAUDE.md; this file is the detail for this domain.

## Live Event format (ADR 0017)

- **Shape.** `tournaments.format` is `'rotation'` or `'event'`. An event is time-boxed: N rounds, each ONE `games` row pre-created with `round_no` + `scheduled_start_at`/`scheduled_end_at` and status **`SCHEDULED`** — deliberately not `'QUEUED'`, which 16 non-test files consume (pick queue, TimeoutManager, the `queue_order` backfill, reconcile). Rounds are `games` rows so all ~15 existing `games`+`tournament_id` readers work unchanged.
- **Events register NO cron.** `cadence = {"timezone": tz}`; `Scheduler` skips `format = 'event'` OUTRIGHT (start-up, `scheduleTournament`, the 15-min sweeps) and `runMaintenance` refuses one, whatever the cadence says (W33; TWR Tournament #1 got a cron by a Format flip and maintenance rotated its live round out).
- **Format is fixed once created** (`TournamentFormatLockedError` → 409 `FORMAT_LOCKED`, both directions); only `EventService` writes the `format` column.
- **One open-card rule** (`src/utils/openCard.ts`): a card is open when the game is ACTIVE and the tournament has not FINISHED (`event_finished_at`). The room board, `SubmissionGameResolver` (a finished event's leftover card resolves COMPLETED), witness `loadCandidates` and `getDeviceTarget` all read it. **`is_active = 0` is NOT "closed"**: on a rotation it is a PAUSE, which only stops rotating (owner ruling 2026-10-25), so never filter score acceptance on it. Finishing an event also closes its leftover non-round ACTIVE games (`closeLeftoverCards`).
- **The clock** is `EventScheduler.tick()` (`src/engine/EventScheduler.ts`), a per-minute task registered beside the timeout checker. Stateless + at-least-once safe: every flip is `UPDATE … WHERE status = <expected>` acted on only when `changes === 1`, every announcement is guarded on an idempotency stamp (`checkin_announced_at`, `event_finished_at`).
- **The status flip precedes iScored board creation** — a bad-creds Playwright login costs ~40s and the tick is reentrancy-guarded, so board-first would hold the round shut and delay the next minute too.
- **`EventSubmissionGate.checkEventSubmission` is THE one enforcement point** — called before ANY write by the three web submit routes and Discord `/submit-score`. A new submit path means a new call site; skipping it makes every window in that room advisory.
  - **Precedence (an event never shadows rotation):** ACTIVE event round wins → else a SCHEDULED round gates ONLY when no rotation game of that name is ACTIVE in the room → else full passthrough. `EventService` also refuses the name clash at save time, but a rotation can activate the name later, so the runtime rule is the backstop.
  - **`ScoreSyncPoller` is not gated** (synced scores have no play time); they're filtered out of standings instead.
- **A round must be a catalogue game (v2.233.0, A34; owner 2026-11-08: block it).** The admin save routes call `EventService.checkRoundGames` BEFORE writing anything (the PUT updates the tournament row first, so a later refusal would half-save): a name with no approved `global_games` row (case-insensitive) is refused `400 GAME_NOT_IN_CATALOGUE`, a match is rewritten to the catalogue's spelling, and a round KEEPING its stored name is exempt (older events stay editable). `createOrUpdateEvent` stamps `games.global_game_id` via `catalogueIdForName` (only an unambiguous name). Not enforced inside `createOrUpdateEvent` (Throwdowns and tests save through it); route-level event tests seed names with `seedCatalogueGames`. The FE picker is `GameNameInput` in `EventSettingsFields` (visible listbox, AtGames chip), never a `<datalist>` (phones barely show it).
- **Thread the stamp.** When the gate returns an `event`, the caller MUST thread `tournamentId` + `gameId` into `ScoreHistoryService.log` — that stamp is the only thing keeping two rounds of the same table apart.
- **One grace, one helper.** `tournaments.end_grace_sec` (default 60; exit-to-submit hosts use 120-180) is resolved by `eventEndGraceSec()` in the gate module and used by BOTH the gate's accept window and the scheduler's close step. Never hand-copy the default.
- **Check-in identity is canonical** (`IdentityLinkService.resolveCanonical`) on both write and read, or a Google check-in won't match a Discord submit. Check-in closes at round 1 start (no separate column); `source='admin'` is the straggler path and deliberately bypasses the late-check-in guard.
- **`event_result` is identity-stable rows ONLY** — same doctrine as `leaderboard_cache`; never bake a name or avatar in, `resolveProfiles` attaches them at read. Finishing sets `is_active = 0` so the alias-link freeze gate treats it as a completed tournament.
- **`min_elapsed_sec` produces a HOST-FACING BADGE, never a rejection** — Arcaid sees submit time, not play time. Don't let anything turn it into enforcement.
- **Round timing is the runner's, never the public's (A42, v2.239.0, ADR 0038; owner 2026-11-10).** The event page board and the Discord round-results post print no time-since-round-open; Room Admin → Activity does, as `round_time` on each `score_landed` / `witness_ingested` row of an event round (`ActivityLogService.roundTimings`, read time, from `scheduled_start_at`; a Witness row times from `details.playedAt`). The payload's `elapsed_sec` still feeds the ⚡ check.
- **`applyLibraryDefaults`** (`src/utils/gameLibraryDefaults.ts`) is shared by `TournamentEngine.activateGame` and the event round start; a creator that skips it renders an unstyled card.
- **Room Admin dashboard reads an event as ROUNDS** (W24): `DashboardService` shows the live round, else the next SCHEDULED one, else the last played, with `event_state` + the round window, and takes the leader from `EventResultService.getRoundBoard` (never `submissions`); a rotation row carries none of those keys.
- **Events lead with the TOURNAMENT** (W30): event page header, `EventBanner`, tournament invite page and the Discord event posts' footer show the tournament first and the room beneath it; a Throwdown has no room line.

## Check-in lobby (v2.159.0)

- **Grading.** `EventLobbyService.roster(event, rounds, now)` grades every `tournament_participants` row while the state is `upcoming`/`checkin` (empty after round 1 starts): `ready` / `table_open` / `no_checkin` / `no_cabinet`, from `witness_devices` (unrevoked), the latest `witness_checkins` per device since the window opened (`checkin_opens_at`, else the earliest check-in bounded to 24 h), and the newest OPEN `witness_observations` session (`exit_ts IS NULL`, ≤ 4 h old).
  - **A session launched BEFORE the latest check-in is a missed exit, never "open"** (the check-in proves the cabinet was idle). STRICT by owner ruling: green only with no table open.
- **Delivery.** Rides on `GET /:roomId/events/:id` as `lobby` (public) and on the host `participants` route as `witness`. The ONE renderer is `components/EventLobbyRoster.tsx` (`LOBBY_STATUS_META` is the copy). Per device type (W19): `lobbyCopyFor(status, deviceType)` words `no_checkin`/`table_open`/`offline` for a cabinet (tile) or a desktop (close VPX, Castcade checks in by itself); the roster ships `deviceType` + `devices[]`, and a multi-device row shows one dot per device.
- **`GET /witness/checkin` is ALSO the event check-in.** `EventLobbyService.checkinFromWitness` writes the participant row when the device's designated tournament is an event in its check-in window (same window rule as the web button; a rotation target or no target does nothing) and appends `· CHECKED IN · READY` to `sendingTo`.
- **Heartbeat.** `GET /witness/heartbeat` stamps `witness_devices.heartbeat_at` and, like check-in, `app_version`/`app_version_at` from an optional `v=` (W60; malformed is ignored, never a 400; a silent device reads "build unknown" on Account Settings / the runner page). It answers the current `sendingTo` line — `describeTarget` plus the lobby suffix via `EventLobbyService.lobbyFromHeartbeat` (W28), the READ-ONLY twin of `checkinFromWitness` (one shared `lobbyForDevice`), plus the attempts-left suffix from `AttemptService.deviceLine` on both check-in and heartbeat (W43).
  - The `deviceLine` game set is `VpxScoreIngestService.openLimitedGames`, the same candidate/routing/entry/window/exclusion filters `match` uses, so the line can never name a game a play would not land on.
  - A heartbeat runs while tables are played and must NEVER write a participant row.
  - The lobby reads `offline` ("Witness not responding") when a device that has EVER heartbeated has been silent > `HEARTBEAT_STALE_SEC` (5 min); a NULL `heartbeat_at` (pre-1.0.4 cabinet) is exempt, never offline.
  - The cabinet's `restarts=N` / `partial=1` land on the game observation (`witness_observations.restarts`/`partial`, migration 180) and ride the verdict as informational fields.
- **The runner's view** (W5): `GET /rooms/:roomId/admin/witness/devices` → `WitnessAdminViewService.roomDevices` lists every paired device of a member (or direct entrant) with online/last check-in/open table and the SAME routing words as "Your scores go to", plus each live event's lobby counts. Device state loads through the ONE helper `roster` uses (`EventLobbyService.loadDeviceState`), so the two can't drift; page `/:slug/admin/witness`, polled 20 s.

## Throwdowns — room-less events (ADR 0018)

A **Throwdown** is a player-created challenge with no game room: a `format='event'` tournament with `game_room_id IS NULL`, `checkin_required = 0` and ONE round, addressed by `tournaments.throwdown_code` at `/throwdown/:code`. It is the SAME object as a hosted Tournament Event, so the round clock, boards, standings, frozen result and public page are all reused — there is no parallel implementation, and adding one would be the mistake this design exists to avoid.

- **`score_history.game_room_id` is NULLABLE** (migration 164) — that one column was the entire cost of going room-less (`tournaments`/`games`/`submissions` already tolerated a null room). **Any new query that groups or filters by room must decide what a NULL room means** rather than assume every score has one. `ScoreHistoryService.log` takes `gameRoomId: string | null` and skips the room-membership write when null.
- **A Throwdown writes `score_history` ONLY** — never `community_scores`, whose room column is still NOT NULL. Safe because `score_history` is already the physical union every read path uses and `EventResultService` reads by `submitted_during_tournament_id` alone.
- **`checkThrowdownSubmission`** in `EventSubmissionGate` is the room-less sibling of `checkEventSubmission`, keyed on the tournament id instead of `(room, game name)`. Both resolve the window through ONE shared `evaluateWindow` — two copies of "is it open yet" would drift on the buzzer. A room-scoped event is deliberately NOT reachable through the room-less path (it would skip check-in).
- **Deliberately absent:** iScored sync, room name claims, check-in, and notifications (the link IS the notification). Global-scoreboard fan-out is NOT absent (ADR 0023, v2.153.0): a Throwdown score fans out like any other, through `fanOutFromRoomSubmission` (null-room tolerant, dedup on `origin_game_room_id IS ?`, recorded as `origin_type='global'` since a room-less challenge has no room chip).
- **First-click-wins rematch** is enforced by the UNIQUE index on `rematch_of_tournament_id`, not by the service's pre-flight — that check exists so the second clicker is handed the existing link rather than an error.
- **Codes** avoid `0`/`O`/`1`/`I`/`l` — read aloud on streams, retyped from phones.
- **Personal rooms were REJECTED** (ADR 0018): they eat the flat public slug namespace, make the share link read as somebody's room URL, and give every room-scoped feature an "except personal rooms" caveat. Do not revive that idea.

## Seasons and Pick by poll (ADR 0025 + 0026)

Plan: `docs/season-format-plan.md` (§12 implementation notes, **§13 the split**).

- **Two INDEPENDENT switches** on a `format='rotation'` tournament (owner ruling 2026-10-18, ADR 0026): a **Season** (`season_table_count IS NOT NULL`, migration 181 — the BOUND) and **Pick by poll** (`poll_picks = 1`, migration 182 — a Game ROTATION METHOD beside winner-picks/auto-pick). Neither is a new format; rotation, announcements, the pick queue, retained locked cards and the ranking ticker are reused untouched.
- **Pick by poll, not the season, forces** `winner_picks=0`, `auto_pick=0`, `max_active_games=1`, `eligibility_days=0` — the poll is the only queue writer. Both player pick paths (web and Discord `/pick-game`) refuse a poll-picked tournament via `pollPickedRefusal` (`POLL_PICKED`, v2.211.0; admin on-behalf queueing stays open). An empty queue = the engine's existing "wait for admin" hold; a community vote overrides cooldown. A Season alone forces nothing.
- **A Season** auto-creates a ranking group (`best_game_linear` — labelled **"Countdown"**, id unchanged — seeded `points_top=50`, `best_n` = table count, `include_archived=1`); the season's scoring lives on that group (the form has no points field, `tournaments.season_points_top` is UNREAD, season saves sync only `best_n`, `RankingService.update` locks only `best_n`). Points placement is RANK semantics everywhere.
- **`ranking_groups.include_archived` exists because `computeRankings` filters `ACTIVE,COMPLETED`** and cleanup archives completed tables — without it week 1's points vanish; it defaults off for every other group.
- **Season end/pause.** The season ends when derived COMPLETED+ARCHIVED rotation tables reach the count (stamp `season_finished_at` once, announce top 3, nothing activates after). `season_paused_at` (Season-only — pause on a poll-only tournament is a 409) skips both the poll tick and `runMaintenance`.
- **The poll queue.** Names are HISTORICAL and serve poll-only tournaments too: `season_polls`/`_candidates`/`_votes`, `SeasonPollService`, the per-minute `SeasonScheduler` (selects `poll_picks = 1`; `EventScheduler` doctrine — `UPDATE … WHERE status=` + `changes===1`), `/season` routes, `season:poll` event. It derives each draft's open/close from the next rotation minus `poll_opens_before_h`/`poll_closes_before_h` (renamed from `season_poll_*` by migration 182; per-poll absolute override for a holiday gap), posts a native Discord poll via REST (`src/utils/discordPolls.ts` — no gateway intent), reads voters every tick, expires at close, **resolves at close, never at rotation**, and queues the winner through `TournamentEngine.queueGame`.
- **Arcaid owns the merged tally**: votes key on the CANONICAL identity, a **web vote beats a Discord vote**, and the bot edits the message content above the poll with the combined count.
- **"Poll Tie-breaker" (`poll_tie_rule`) has three options and NO fallback** (`season_tie_fallback` is an unread column): `random`, `first_nominated`, and `admin`, which **HOLDS** — queues nothing, marks the poll `tied=1` with no result, tells the channel an admin must choose; the rotation's existing "No Table Queued" hold IS the admin alert.
  - `can_choose` = tied AND (nothing queued OR the queued row still QUEUED); `choose` queues / swaps via `removeQueuedGame` + `queueGame`; a held tie blocks the next poll until the rotation it fed has passed.
- **One poll per rotation**; on a poll-picked SEASON polls stop once resolved-with-result polls reach the bound (a poll-only rotation polls forever). The "No Table Queued" embed is suppressed whenever a real QUEUED row exists (never season-gated).
- **Surfaces.** `TournamentForm` ("Pick by poll" checkbox + poll fields in Game Rotation; "Run as a Season" = table count only); `SeasonPanel` on the admin Tournaments page (button "Season" or "Polls"; progress/pause only for a season, queue only when poll-picked); `SeasonPollCards` (the voting card) on the public **Lobby** (owner ruling 2026-10-18: it pushed the card rail down on Scores), which joins `room:<id>` for `season:poll` + `useLiveRefresh`; a one-line `SeasonPollLobbyNudge` ("Vote in the Lobby →") stays on the public Scoreboard; both share `fetchOpenSeasonPolls`; `points_top`/`include_archived` show on the Rankings page.
