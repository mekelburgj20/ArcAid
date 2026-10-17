# Season format — plan

> **Read this first if you are picking up Season work.** It is self-contained: the owner rulings,
> the data model, the scheduler contract and the UI surfaces a fresh session needs are all here.
> The originating conversation is a Discord DM thread between the owner and GamerDad89
> (mox_s_vpx_tournaments room), 2026-10-17.
>
> Status: **design locked, build in progress on `feature/season-format`.** Last updated 2026-10-17.

## 1. What this is

A **Season** is a bounded weekly-grind rotation: one table live at a time, each for one week, for
N weeks, with every week's finishing position converted to points that accumulate into a season
standings table. The community votes on each week's table in a poll that Arcaid posts to Discord
and mirrors on the room's public page, and the poll's winner rotates in automatically.

It is **not a fourth tournament format**. A Season is a `format = 'rotation'` tournament with a
season block switched on. Rotation, announcements, winner pings, the rotation log, retained
completed cards, the ranking-group ticker and the Stats → History page all work unchanged. The
new pieces are: the bound (N tables), the points scale, the poll queue, the pause, and the
season-end announcement.

### The worked example (GamerDad89's league)

| Thing | Value |
|---|---|
| Season length | 12 tables |
| Table window | Friday 00:00 → Thursday 23:59 America/New_York (cron `0 0 * * 5`) |
| Points | 1st = 50, 2nd = 49, 3rd = 48 … (linear, top value 50) |
| Poll | Opens Monday, closes Thursday evening; 4–5 curated candidates; he breaks ties himself |
| Standings display | Ranking ticker by default; players may switch to a card in their own preferences (already shipped) |
| Last week's table | Visible but locked on the board via cleanup rule `retain` (already shipped) |
| Discord | One announcement channel per season (`tournaments.discord_channel_id`, already shipped) |
| Christmas | Season paused; no polls, no rotation |

## 2. Owner rulings (locked — do not re-litigate)

| Ruling | Consequence |
|---|---|
| Season is a rotation option, not a new format | Add columns to `tournaments`; no new `format` value. |
| Tie rule is a config option | `admin` / `random` / `first_nominated`, plus a fallback for `admin`. Runoff is NOT offered. |
| The poll is mirrored on the web AND Discord | Arcaid owns the poll; Discord is one vote source, the web is the other. Arcaid's merged tally decides. |
| Polls are curated, not open-nominated | Admin picks the candidates. No nomination form. |
| Poll open/close are configurable and polls form a queue | Each poll is a draft tied to the next slot; season-level relative defaults, per-poll absolute override. |
| Players see season standings and the current week at once | Ranking ticker + the active card. Nothing new to build. |
| Poll may run while the current table is live | Poll timing is independent of game state; only "close before rotation" is enforced. |

## 3. Data model (migration `181_season_format`)

Use the `addColumns` PRAGMA-guarded pattern from `src/database/migrations/liveEventFormat.ts`.
Extract the handler to `src/database/migrations/seasonFormat.ts`.

### 3.1 `tournaments` — season block

| Column | Type | Meaning |
|---|---|---|
| `season_table_count` | `INTEGER` | NULL = not a season. N = season of N tables. |
| `season_points_top` | `INTEGER NOT NULL DEFAULT 50` | Points for 1st place; 2nd = top−1, etc. Floor 0. |
| `season_ranking_group_id` | `TEXT` | The auto-created standings group. Pseudo-FK (no constraint, like the other ALTER-added refs). |
| `season_poll_opens_before_h` | `INTEGER NOT NULL DEFAULT 96` | Default poll open = next rotation − 96 h (Monday for a Friday rotation). |
| `season_poll_closes_before_h` | `INTEGER NOT NULL DEFAULT 3` | Default poll close = next rotation − 3 h. |
| `season_tie_rule` | `TEXT NOT NULL DEFAULT 'admin'` | `admin` / `random` / `first_nominated`. |
| `season_tie_fallback` | `TEXT NOT NULL DEFAULT 'random'` | Applied immediately when rule is `admin` (see §5.4). `random` / `first_nominated`. |
| `season_paused_at` | `TEXT` | ISO UTC. Non-NULL = paused: no polls post, no rotation fires. |
| `season_finished_at` | `TEXT` | ISO UTC. Idempotency stamp for the season-end announcement. |

Validation (Zod + `TournamentService.create/update`, both): `season_table_count` 1..200;
`season_points_top` 1..1000; `closes_before_h` ≥ 1 (Discord's minimum poll duration is 1 h);
`opens_before_h` > `closes_before_h`; a season requires `format = 'rotation'` AND a cadence
with a cron. **A season forces `winner_picks = 0`, `auto_pick = 0`, `max_active_games = 1`,
`eligibility_days = 0`** on save (normalise, don't reject — the form shows them locked with a
note). `eligibility_days = 0` because a community vote overrides cooldown — the fill loop's
cooldown check would otherwise hold the poll winner and stall the week. The poll is the only
queue writer; with both pick flags off the engine's existing empty-queue behaviour is "wait for
admin", which is exactly the hold-and-alert outcome a season wants. Do not add a new fallback.

### 3.2 `ranking_groups` — two additions

| Column | Type | Meaning |
|---|---|---|
| `points_top` | `INTEGER NOT NULL DEFAULT 100` | Used by `best_game_linear` only: 1st = top, 2nd = top−1 … Existing groups keep 100, so nothing changes for them. |
| `include_archived` | `INTEGER NOT NULL DEFAULT 0` | 1 = count `ARCHIVED` games too. Season groups set 1. |

**Why `include_archived` exists:** `RankingService.computeRankings` filters
`g.status IN ('ACTIVE','COMPLETED')`. Cleanup archives completed tables under `retain`,
`immediate` and `scheduled`, so on a 12-week season with default cleanup, week 1's points would
silently vanish once that table is archived. The season group counts archived games. The flag
defaults off so no existing room's standings change on deploy; flipping the default later is a
separate decision.

**Rank semantics change (deliberate, global):** per-game placement for points switches from
`ROW_NUMBER()` to `RANK()` so tied scores share the place and both receive the higher points
(1st, 1st, 3rd). Pinball score ties are rare; where they happen, breaking the tie alphabetically
is indefensible. CHANGELOG notes it.

### 3.3 Poll tables (new)

```sql
CREATE TABLE IF NOT EXISTS season_polls (
    id TEXT PRIMARY KEY,
    tournament_id TEXT NOT NULL,
    slot_no INTEGER NOT NULL,                 -- 1-based position in the poll queue
    status TEXT NOT NULL DEFAULT 'draft',     -- draft | open | resolved | cancelled
    question TEXT,                            -- NULL = "<tournament name> — week <slot_no> table"
    opens_at TEXT,                            -- ISO UTC; NULL = derive from season defaults at tick
    closes_at TEXT,                           -- ISO UTC; NULL = derive
    discord_channel_id TEXT,                  -- NULL = tournament's channel
    discord_message_id TEXT,                  -- set when posted
    posted_at TEXT,
    tie_rule TEXT,                            -- NULL = tournament default
    result_game_name TEXT,                    -- the table that won (after tie handling)
    result_queued_game_id TEXT,               -- the games row queueGame created
    tied INTEGER NOT NULL DEFAULT 0,          -- 1 = resolved by fallback, admin may still override until rotation
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_season_polls_slot ON season_polls(tournament_id, slot_no);

CREATE TABLE IF NOT EXISTS season_poll_candidates (
    poll_id TEXT NOT NULL,
    position INTEGER NOT NULL,                -- 1..10 (Discord's answer cap); also "first nominated" order
    game_name TEXT NOT NULL,
    global_game_id TEXT,
    discord_answer_id INTEGER,                -- Discord's answer id once posted
    PRIMARY KEY (poll_id, position),
    FOREIGN KEY (poll_id) REFERENCES season_polls(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS season_poll_votes (
    poll_id TEXT NOT NULL,
    user_id TEXT NOT NULL,                    -- CANONICAL identity (IdentityLinkService.resolveCanonical)
    position INTEGER NOT NULL,                -- candidate position
    source TEXT NOT NULL,                     -- 'web' | 'discord'
    voted_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (poll_id, user_id),
    FOREIGN KEY (poll_id) REFERENCES season_polls(id) ON DELETE CASCADE
);
```

Votes are identity-stable rows (same doctrine as `leaderboard_cache` / `event_result`): never
bake a display name in; resolve with `resolveProfiles` at read.

## 4. Season standings (ranking group)

- `TournamentService.create/update` with a season block and no `season_ranking_group_id`
  creates a ranking group: name `"<tournament name> — Season"`, `rank_method = 'best_game_linear'`,
  `points_top = season_points_top`, `best_n = season_table_count`, `min_games = 1`,
  `include_archived = 1`, bound to the tournament via `ranking_group_tournaments`, same
  `game_room_id`. Stores the id back.
- Later edits to `season_points_top` / `season_table_count` propagate to the group's
  `points_top` / `best_n` and call `RankingService.invalidate` for that group (config change,
  not data change — the watermark does not cover these columns).
- `RankingService.calculatePoints('best_game_linear', rank)` becomes `points_top + 1 − rank`,
  floored at 0. `RANK_METHOD_INFO.best_game_linear.description` is rewritten to say "starts at
  the group's top value (default 100)". The Rankings admin page gets a `points_top` field shown
  only for `best_game_linear`, and an "Include archived games" checkbox.
- Deleting the tournament cascades the group through `ranking_group_tournaments`; the group row
  itself is deleted by `TournamentService.delete` when `season_ranking_group_id` is set.
- A player who misses a week scores 0 for it, by absence. No explicit zero rows.

## 5. The poll queue

### 5.1 Lifecycle

```
draft ──(opens_at reached, season not paused)──► open ──(closes_at reached)──► resolved
  │                                                                               │
  └── cancelled (admin)                                       queueGame() ◄───────┘
                                                                     │
                                            rotation cron activates the queued table
```

`SeasonPollService` (new, `src/services/SeasonPollService.ts`) owns CRUD, tally, resolve and tie
handling. `SeasonScheduler.tick()` (new, `src/engine/SeasonScheduler.ts`) is a per-minute task
registered in `Scheduler` beside `EventScheduler`, stateless and at-least-once safe: every flip
is `UPDATE … WHERE status = <expected>` acted on only when `changes === 1`.

### 5.2 Timing

- Each tick, for every active, unpaused, unfinished season: take the lowest-`slot_no` `draft`.
  If its `opens_at` is NULL, derive both times from the **next** rotation after now
  (`nextRotationIso` in `src/utils/cronUtils.ts`) minus the season offsets, and persist them so
  the admin page shows real times. A draft with explicit times keeps them.
- Validation on save (season defaults and per-poll overrides): `closes_at < next rotation`,
  `opens_at < closes_at`, `closes_at − opens_at ≥ 1 h`. Refuse, name the rotation time.
- Post when `opens_at ≤ now`. Close when `closes_at ≤ now`. Resolve immediately on close, NOT at
  rotation time, so a tie surfaces hours before Friday and a failed resolve is visible.
- The Discord poll duration is `ceil((closes_at − posted_at) / 1 h)`, capped at 768 h. Discord
  will expire it on its own clock; Arcaid also calls expire at close so the two agree.
- **After posting, `closes_at` may only move EARLIER** (Discord cannot extend a poll) and the
  candidate list is frozen (Discord cannot edit answers). The UI disables those fields on an open
  poll and offers "Close now" and "Cancel and repost".
- Polls stop when `resolved` polls for the tournament ≥ `season_table_count`. A draft beyond the
  bound is left as draft and the admin page says why.
- One day before a derived `opens_at` with no draft prepared, post ONE reminder to the season
  channel ("No candidates prepared for the week N poll — it opens tomorrow"). Idempotent via a
  `season_polls` row with `status='draft'` and zero candidates created by the reminder itself
  (the admin fills it in). No DM.

### 5.3 Discord side — REST, no gateway intent

All Discord I/O goes through `@discordjs/rest` exactly like `sendChannelMessage` in
`src/utils/discord.ts` (token from env, `Routes.*`). Put it in `src/utils/discordPolls.ts`:

| Call | Route | Used for |
|---|---|---|
| Post poll | `POST Routes.channelMessages(channelId)` with `{ content, poll: { question: {text}, answers: [{poll_media: {text}}], duration, allow_multiselect: false, layout_type: 1 } }` | open |
| Read voters | `GET Routes.pollAnswerVoters(channelId, messageId, answerId)` (paginate on `after`, `limit=100`) | every tick while open, and once at close |
| Expire | `POST Routes.expirePoll(channelId, messageId)` | close |
| Edit tally line | `PATCH Routes.channelMessage(channelId, messageId)` `{ content }` | after each tick that changed the merged tally |

The posted message `content` carries the combined tally and the web link, e.g.
`**Week 5 table poll** — vote here or at <room url>/season · Combined: Attack from Mars 7 · Medieval Madness 3`.
The poll widget's own counters will undercount (web votes cannot be injected into Discord — there
is no API to vote on behalf of a user; verified against discord.js 14.27 typings), which is why
the content line exists. **Verify on the first live post that message content on a poll message
is editable**; if Discord refuses, drop the tally edit and keep the link.

A gateway `GuildMessagePolls` intent + `messagePollVoteAdd` events would make the mirror
instant; the per-minute REST read is the backstop that always works and is enough for v1.
Do not add the intent in this release.

The bot needs **Send Messages** and **Send Polls** in the season channel. A 403 on post logs a
WARN naming the channel and leaves the poll `draft` with `posted_at` NULL so the next tick
retries; after 3 failures the poll is marked `cancelled` and a plain-text message explains why.

### 5.4 Votes, merge, tie

- Web vote: `POST /api/rooms/:roomId/season-polls/:pollId/vote { position }`, `requireDiscordUser +
  requireNotBanned + roomVisibilityGate`, poll must be `open`. Upserts `(poll_id, canonical user,
  position, 'web')`. `DELETE` withdraws. Room membership is NOT required (the Discord poll has no
  such gate either).
- Discord sync: each tick, for each answer, fetch voters; map each voter id through
  `IdentityLinkService.resolveCanonical`; upsert `source='discord'` rows **only where no `web`
  row exists for that user**. A web vote wins over a Discord vote for the same person (the web
  vote is the explicit, Arcaid-authenticated act; Discord gives no vote timestamps so "latest
  wins" is not implementable). Discord voters who disappear (vote removed) are deleted if their
  row is `source='discord'`.
- Tally = count per position over `season_poll_votes`. Winner = max. Tie (two or more at max):
  - `random`: pick uniformly among the tied, seeded by the poll id so a re-run is stable.
  - `first_nominated`: lowest `position` among the tied.
  - `admin`: apply `season_tie_fallback` NOW, queue that table, set `tied = 1`, and post to the
    season channel: "Tie between X and Y. Fallback picked X. Admins can change it before the
    table starts: <admin url>". The admin page shows the tied candidates; choosing another
    **swaps the queued game** (`TournamentEngine` removes the queued row, `queueGame` the new
    one) while the row is still `QUEUED`. No DM, no interaction buttons, no race with the cron.
- Eligibility at resolve: the winner must still be an approved catalogue game that passes the
  tournament's platform rules (same check as admin activate). If not, fall to the next-ranked
  candidate and say so in the announcement. If none qualify, leave the poll `resolved` with no
  result and post a WARN-level message; the rotation then holds (empty queue, both pick flags off).
- Queue write: `TournamentEngine.queueGame(tournamentId, gameName, styleId?, iscoredId?)` with
  no picker. Store the returned game id in `result_queued_game_id`.
- Announcement on resolve goes through `resolveAnnouncementChannelId` (honours the `'none'`
  sentinel). Copy: `**Next up: Attack from Mars** (won the week 6 poll, 7 votes to 3). Starts
  Friday 12:00 AM ET.` Names the tournament in title and body (v2.157.1 rule).

### 5.5 Candidate picker

`GET /api/rooms/:roomId/tournaments/:tournamentId/season/candidates?q=&unplayed=1` returns
approved catalogue games that pass the tournament's platform rules (catalogue platforms ∪ room
tags, same union as the admin activate-game picker), with `played_before: boolean` computed over
this room's `games` rows of ANY status (including ARCHIVED). `unplayed=1` filters them out. Max
10 candidates per poll (Discord's cap).

## 6. Rotation, pause, season end (`TournamentEngine`)

- **Pause.** `runMaintenanceInternal` early-returns `skipped` with summary
  `season paused` when `season_paused_at IS NOT NULL` (recorded in `maintenance_runs` like any
  other skip). The current table stays ACTIVE and open; an admin who wants it closed uses the
  existing lock affordance. `SeasonScheduler.tick` skips paused seasons entirely. Resume clears
  the stamp; a draft whose derived times are now in the past is re-derived from the next rotation.
- **Season end.** In the slot loop, before activating the next table: if
  `COUNT(games WHERE tournament_id = ? AND status IN ('COMPLETED','ARCHIVED') AND round_no IS NULL)`
  ≥ `season_table_count` (counting the table just completed), do NOT activate anything; stamp
  `season_finished_at` (UPDATE … WHERE season_finished_at IS NULL, act on `changes === 1`) and
  announce the final top 3 from `RankingService.getRankings(season_ranking_group_id)` with
  `resolveUserMention` pings. The tournament stays `is_active = 1` so the retained cards and the
  ticker keep rendering; the cron keeps firing and keeps skipping (`skipped: season finished`).
- **Count is derived, never stored.** The game rows are the record; a `deleteGameCompletely`
  ("wrong table") correctly un-counts a week.
- `announceGameActivated` is unchanged — the queued table activates through the existing path.

## 7. API (all under `/api/rooms/:roomId`, admin = `requireAuth + requireRoomAccess`)

| Method & path | Auth | Purpose |
|---|---|---|
| `GET  /tournaments/:tournamentId/season` | public (`roomVisibilityGate`) | Season summary: config, progress (`tables_done`, `table_count`), paused/finished, current open poll (candidates + tally + `my_vote` when logged in), next derived open time. |
| `GET  /tournaments/:tournamentId/season/polls` | admin | Full poll queue with candidates, tallies, status. |
| `POST /tournaments/:tournamentId/season/polls` | admin | Create a draft (candidates, optional times/channel/tie rule). |
| `PUT  /tournaments/:tournamentId/season/polls/:pollId` | admin | Edit a draft; on an open poll only `closes_at` (earlier) is accepted. |
| `POST /tournaments/:tournamentId/season/polls/:pollId/:action` | admin | `close` (expire now + resolve), `cancel`, `repost` (cancel + clone as new draft), `reorder` (`{slot_no}`), `choose` (`{position}` tie override while QUEUED). |
| `POST /tournaments/:tournamentId/season/:action` | admin | `pause`, `resume`. |
| `GET  /tournaments/:tournamentId/season/candidates` | admin | §5.5. |
| `POST /season-polls/:pollId/vote` / `DELETE` | player | §5.4. |

Admin writes audit through `auditMiddleware` like every other admin write. Zod schemas in
`src/api/schemas.ts`. The season summary rides on the existing public tournaments list as a
`season` sub-object too (`tables_done`, `table_count`, `paused`, `finished`, `open_poll_id`), so
the scoreboard can decide whether to render the poll card without a second round trip.

## 8. UI

### 8.1 Admin — `TournamentForm.tsx`
A "Season" section under the rotation settings: enable toggle, table count, points for 1st,
poll opens/closes (hours before rotation, with the derived "Monday 12:00 AM ET → Thursday 9:00 PM
ET" echo computed from the cadence), tie rule + fallback, and a note that winner-picks /
auto-pick / max-active are fixed for seasons (fields shown disabled).

### 8.2 Admin — `TournamentDetail.tsx` → new `SeasonPanel.tsx`
Progress ("Week 6 of 12"), pause/resume, the poll queue as an ordered list (status chip, times,
candidates, live tally, Discord link), draft editor with the candidate picker (search, "not yet
played" filter on by default, 10 max, drag to order = first-nominated order), per-poll
open/close override, Close now / Cancel / Repost, and the tie override when `tied = 1` and the
queued game is still QUEUED.

### 8.3 Public — `SeasonPollCard.tsx` on `Scoreboard.tsx`
Rendered above the cards when the room has an open poll: question, candidates with vote counts
and a bar, the viewer's current vote highlighted, one tap to vote (login prompt via the existing
viewer auth flow when logged out), "Vote on Discord instead" link to the message, closes-in
countdown. Refreshes through `useLiveRefresh` plus a `season:poll` socket event emitted on every
tally change (`getIO()` → `room:<id>`). Mobile first: single column, 44 px targets. Theme tokens
only.

### 8.4 Rankings admin page
`points_top` input (only for `best_game_linear`), "Include archived games" checkbox. The
season-created group is editable like any other but shows "Managed by <tournament>" and locks
`best_n` / `points_top` to the season config.

## 9. Tests (vitest, `src/__tests__/`)

- `season-ranking-points.test.ts` — linear from `points_top`; `include_archived` on/off; RANK()
  tie shares points.
- `season-poll-resolve.test.ts` — tally merge (web beats discord, discord removal), each tie rule,
  seeded random stability, eligibility fall-through, `queueGame` called once, idempotent re-tick.
- `season-scheduler.test.ts` — derived times from cadence + offsets, close-before-rotation
  validation, pause skips, bound stops polls, reminder idempotency.
- `season-rotation-end.test.ts` — season end stamps once and announces once, pause skips
  maintenance with a `skipped` run row, derived count ignores event rounds.
- `discordPolls.test.ts` — REST bodies (poll shape, duration cap, pagination of voters) against a
  mocked `REST`.
- Admin-UI: `SeasonPanel.test.tsx` + `SeasonPollCard.test.tsx` basics (render, vote call, locked
  fields on open poll). Run the whole admin-ui suite (`npx vitest run`) — see CLAUDE.md on why.

## 10. Build order

1. **Slice A — backend** (migration, types, service + scheduler, Discord REST adapter, engine
   hooks, routes, tests). Lands on `feature/season-format` first; everything else builds on its
   API.
2. **Slice B — admin UI** and **Slice C — public poll card + Rankings page fields**, in parallel
   worktrees off the branch once A is green.
3. Version `2.161.0`, CHANGELOG, CLAUDE.md "Season" paragraph (short — point here), ADR 0025
   "Season is a rotation option with a poll queue" (why not a format; why Arcaid owns the poll;
   why `admin` tie applies the fallback immediately; why `include_archived` defaults off).

## 11. Known limits (accepted for v1)

- Discord's poll counters undercount web votes; the content line carries the merged tally.
- Vote mirror latency is up to one minute (REST read per tick). Gateway events are a later upgrade.
- No per-player "you voted" notification. The link is the notification.
- `season_ranking_group_id` is a pseudo-FK like the other ALTER-added references.
- The reminder posts to the channel, not as a DM — admins read the channel anyway.

## 12. Implementation notes (Slice A, 2026-10-17)

The truth as built, for the UI slices and later sessions.

- **Audit.** `auditMiddleware` is not mounted, so season writes call `AuditService.log` directly:
  `season.poll_create`, `season.poll_update`, `season.poll_<action>`, `season.pause`, `season.resume`.
- **Ranking.** The SQL `ROW_NUMBER()` in `RankingService.computeRankings` is the best-score-per-player
  dedup and stays; RANK() placement (ties share a place) is done in the JS loop.
- **The poll bound** counts resolved polls that actually queued a table
  (`SeasonPollService.countResolvedWithResult`) — a poll that resolved with no eligible winner does
  not use up a week. Season END is the separate derived count of COMPLETED/ARCHIVED rotation games
  (`countTablesDone`, event rounds excluded).
- **One poll per rotation.** No draft is derived or posted while a poll is open, or while a resolved
  winner is still QUEUED.
- **Explicit poll times** are validated against the next rotation after max(now, `opens_at`); a
  `closes_at` in the past is refused.
- **Post-failure strikes.** The 3-strikes counter for failed Discord posts is in memory (resets on
  restart).
- **Season lock.** The server refuses edits to `best_n` / `points_top` on the season-managed ranking
  group; they follow the tournament's season block.
- **Candidate picker** also filters by tournament `mode`, and keeps `played_before` as the admin's
  own repeat guard (cooldown is not applied — see the last ruling below).
- **Content-line link** points at the room's main page.
- **`TournamentEngine.removeQueuedGame(id)`** exists for pulling a queued table.
- **`choose`** posts an updated "Next up" embed.
- **Ruling: no-queue embed guard.** `processSlotMaintenance` skips the "No <Table> Queued" embed
  (both the manual-only and the winner-picks-without-winner sites) whenever the tournament has a real
  QUEUED row (`[Pending Pick]` placeholders excluded). The poll winner is not in the winner's own
  queue, so the cascade never fires it — the fill loop activates it moments later. A genuinely empty
  queue still posts the embed, unchanged.
- **Ruling: `eligibility_days = 0`.** Forced on season save (§3.1) — a community vote overrides
  cooldown.
