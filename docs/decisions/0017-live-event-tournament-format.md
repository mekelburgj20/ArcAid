# ADR 0017 — Live Event tournament format: rounds are `games` rows, `SCHEDULED` is a status, aggregation is read-time

**Status:** Accepted (2026-08-24)
**Scope:** Arc 1 of the three-arc Private/Live Tournaments plan. Arcs 2 (AtGames private-tournament API
sync) and 3 (on-device Witness app) build on this model and are out of scope here.

## Context

RTX Discord (2026-08-23) wants **short, synchronized stream-night competitions**: a 30–75 minute window,
or three 25-minute rounds averaged, or four tables in one night. The failure mode they want closed is
**"gearing up"** — grinding a score for hours before the window opens, then submitting the instant it
starts. Their workaround today is a dummy "sign-up" tournament whose submitters are the only ones who
count, plus a host who can't compete because they're busy verifying.

Every tournament in ArcAid until now is a **perpetual cron-rotated slot machine**. `tournaments` has no
start, no end, no duration, no participants, no format column — `cadence.cron` is the only schedule that
exists, and `type` is the iScored tag, not a cadence. Critically, **no submit path compares a timestamp to
any window**: the web `/submit-score` upsert matches `g.status IN ('ACTIVE','COMPLETED')`, so a score
posted after a game finished still lands on the finished board. There is no `played_at` anywhere —
every timestamp is submit time.

Two domain facts bound what is achievable:

- **AtGames cabinets are exit-to-submit.** A score uploads only when the player fully exits the table.
  So a cabinet timestamp is approximately *game-end* time, and a player mid-ball at the buzzer must exit
  before the cutoff or the score never existed. There is no realtime device feed to be had, even in
  principle.
- **No API exposes game duration or game start time** (verified in Phase 0 against AtGames' own
  endpoints). Duration is derivable only on-device.

Therefore **Arcaid cannot prove gear-up from outside the cabinet.** The honest ceiling for Arc 1 is:
exact server-clock windows, check-in before the start, and an elapsed-since-round-start figure on every
score so a host can see the implausible ones. Anything stronger requires Arc 3.

## Decision

### 1. A round is a `games` row, not a `tournament_rounds` table

One `games` row per round, pre-created at save with `round_no`, `scheduled_start_at`,
`scheduled_end_at`.

Every read path in the app already keys on `games` + `tournament_id`: the scoreboard cards,
`LeaderboardService`, `TournamentScoresService`, Game Detail, the Discord read commands, chat responses,
OG meta, `ScoreSyncPoller`, `ScoreHistoryService`'s tournament auto-stamp, `ScoreRankService`. Rounds
inherit all of it for free. A separate table would have required patching roughly fifteen readers, each
an opportunity for an event round to be invisible somewhere.

The cost is that "a game" now sometimes means "a round", and `games.name` can repeat within one
tournament. That is handled in decision 4.

### 2. `SCHEDULED` is a new `games.status`, deliberately not `QUEUED`

A pre-created round must be visible to admins and the event page before it opens, and invisible to
everything else. Sixteen non-test files act on `'QUEUED'` — the pick queue, `TimeoutManager`, the
`queue_order` backfill in `initDatabase`, iScored reconcile. Reusing `QUEUED` would have put rounds into
players' pick queues.

`games.status` has no CHECK constraint (`GameStatus` is a TypeScript union), so this needed no table
rebuild.

### 3. Events carry no cron

An event's `cadence` is `{"timezone": tz}` with no `cron`. `Scheduler.scheduleTournament` already treats
a missing `cron` as "no cadence configured" and skips the tournament, which keeps `runMaintenance`,
`processSlotMaintenance` and `TimeoutManager` away from event rounds. This is load-bearing, not
incidental: those paths exist to rotate games, and would rotate the rounds out from under the schedule.

Every `cadence` reader in the codebase already tolerated a missing `cron` before this change; only the
Zod schema demanded one.

The clock is instead a dedicated per-minute `EventScheduler.tick()`, registered beside the picker-timeout
checker. It is stateless, so `Scheduler.reload()` churn is free, and **at-least-once safe**: every status
flip is a guarded `UPDATE … WHERE status = <expected>` acted on only when `changes === 1`, and every
announcement is guarded on an idempotency stamp (`checkin_announced_at`, `event_finished_at`). A
container restart mid-tick therefore cannot double-start a round or freeze a second result.

**The status flip precedes iScored board creation.** The advertised window is the product promise; the
iScored mirror is a convenience. A Playwright login against a misconfigured account costs ~40 seconds
(measured), and because the tick is reentrancy-guarded, doing it first would hold the round shut for that
time *and* push the next minute's work behind it.

### 4. One submission gate, and it never shadows rotation

`EventSubmissionGate.checkEventSubmission` is the single enforcement point, called before any write by
all three web submit routes and the Discord `/submit-score` command. A game that is not an event round
returns `{ok: true}` with no event, and the rotation path runs exactly as it did before.

Both formats key on `(room, LOWER(game name))`, which creates a collision risk. Precedence:

1. an **ACTIVE** event round always wins;
2. otherwise a **SCHEDULED** round gates only when no rotation game of that name is ACTIVE in the room;
3. otherwise the rotation path is untouched.

Rule 2 matters: without it, a round scheduled for tomorrow on a popular table would make *today's*
rotation submissions fail with "the round hasn't started". `EventService` also refuses the collision at
save time, but a rotation can activate the name after the event was saved, so the precedence rule is the
runtime backstop.

When the gate accepts an event submission it returns the resolved round, and the caller **must** thread
`tournamentId` + `gameId` into `ScoreHistoryService.log`. That stamp is what keeps two rounds of the same
table apart.

**`ScoreSyncPoller` is not gated.** A synced iScored score has no play time and no trustworthy submitter
identity; refusing it would lose real scores from rooms that bridge to an iScored board. Instead synced
rows land on the round and are filtered out of the *standings* when the event requires check-in and the
name maps to nobody.

### 5. One grace value, one helper

`tournaments.end_grace_sec` (default 60) is the late-submit grace after a round's scheduled end, resolved
by `eventEndGraceSec()` — used by **both** the gate's accept window and the scheduler's round-close step.
Hand-copying the default in either place would let a round close while the gate was still accepting, or
the reverse.

The default is 60s for phone-submit frenzies. Exit-to-submit hosts ("exit at the buzzer, then type in what
the exit screen showed") set 120–180s.

### 6. Check-in is keyed on the canonical identity

`tournament_participants.user_id` is always `IdentityLinkService.resolveCanonical(...)`, on both the write
and the read side. A player who checks in on the web with Google and submits from Discord is one person;
without this they would be two rows and the second action would be refused.

Check-in closes at round 1's start — there is no separate `checkin_closes_at` column. Stragglers are
handled by an admin adding them with `source='admin'`, which deliberately bypasses the late-check-in
guard. That *is* the sanctioned override.

### 7. Standings are computed at read time; the frozen result holds identity keys only

No cache in v1. When the event finishes, the standings are frozen into `tournaments.event_result` with
**display fields stripped** — identity keys, scores and round positions only.

This is the same doctrine that governs `leaderboard_cache` and `global_leaderboard_cache` since v2.74.0
(S24.1): baking a name or an avatar into stored JSON re-creates the profile-edit invalidation storm and
the bug where an avatar change never reached the board at all. `resolveProfiles` attaches names and
avatars on the way out.

Aggregation: `best` = best single round; `sum` = Σ round bests, missing rounds count 0; `average` = mean,
**but only over players who scored in every round** — everyone else moves to an `incomplete` section,
because averaging a partial set ranks a one-round sniper above someone who competed all night.

Finishing sets `is_active = 0`, which gives the event the "completed tournament" semantics `MergeService`
and the alias-link freeze gate already understand: its scores stop being re-attributed by later identity
links, so a frozen result stays frozen.

## Trust model — state this plainly

`min_elapsed_sec` produces a **host-facing hint**, never an automatic rejection. Arcaid sees submission
time, not play time. A score that arrives 30 seconds into a 25-minute round is suspicious; it is not
proven to be geared, and a fast legitimate game exists. The badge is a receipt for social enforcement on
a stream, not anti-cheat.

What Arc 1 *does* guarantee is the part that is actually mechanical: nothing is accepted outside the
server-clock window, and nobody who did not check in before the start counts in the standings.

Arc 3's on-device witness would make gear-up detection exact by supplying launch time — and even then it
is a client-side witness on hardware the player controls (root is free on those cabinets), so it catches
casual gear-up and nothing more. Do not oversell either.

## Consequences

- `games.name` is no longer unique-ish within a tournament. Anything that resolves a game by name inside
  one tournament must now also consider `round_no` / `game_id`.
- A new submit path is a new gate call site. A submit path that skips the gate silently makes every
  window in the room advisory.
- Any new `games.status` consumer must decide explicitly what it does with `SCHEDULED`.
- The ROADMAP's room-less "private tournaments / challenge back" spec layers on top of this as *an event
  in a hidden room*; this design deliberately does not preclude it.
- `applyLibraryDefaults` was extracted from `TournamentEngine.activateGame` so rounds and rotation games
  get identical catalogue styling. Both creators must call it; a round that skips it renders unstyled.
