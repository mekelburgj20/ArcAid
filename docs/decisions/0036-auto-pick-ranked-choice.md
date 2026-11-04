# ADR 0036 — Auto-pick is ranked choice over the room's queues, then a weighted roam

**Status:** accepted (owner-approved spec 2026-11-03), built v2.219.0 (WORK.md A25)

## Context

When nobody picks the next table (no winner, winner picks off, or every picker's window expired), Arcaid
auto-picks. Both auto-pick sites — `TournamentEngine.autoPickAndActivate` and
`TimeoutManager.fallbackToAutoSelection` — filtered the catalogue (mode, platform rules, the 60/120-day
cooldown) and then drew uniformly at random from whatever survived. On 2026-11-03 the owner described the
result as a dart board: a room full of players with tables lined up in their queues would get a table none
of them had asked for, because the draw ignored the queues entirely, along with every rating and every
signal of what the room actually plays.

A simulation of this ranking against the production database put Attack from Mars at 10 points from 4
different queues, with the next table, Space Shuttle Deluxe, at 2. The uniform draw gave Attack from Mars
the same chance as any other eligible table.

## Decision

One pure ranking function, `rankAutoPick` in `src/utils/autoPickRanking.ts`, fed by one loader,
`AutoPickSignalService.load`. Both sites keep their filters exactly as they were and replace only the
random draw.

0. **Pool.** The site's eligible set minus names already ACTIVE in this tournament.
1. **Ranked choice over the queues.** Each player's QUEUED rows in this tournament are walked in
   `queueOrderSql()` order. Rows not in the pool are skipped (a held head is on cooldown, so it does not
   waste the vote); a table queued twice counts once. The player's 1st, 2nd and 3rd remaining tables score
   3, 2 and 1 (`TIER1_POINTS`, `TIER1_DEPTH = 3`); totals add across players. The top total wins
   outright, ties broken by the Tier 2 weight, then by the earliest-queued contributing row (`MIN(rowid)`;
   `games.created_at` is not reliable on old databases). The winning rows are consumed: every contributing
   QUEUED row of the pick is deleted, each affected queue is compacted and nudged like any other engine
   consumption, and the announcement credits the players by name ("from the queues of A, B and C").
2. **Weighted roam** (only when no queue scored). `weight = ratingAdj × (1 + ln(1 + roomPlayers))`, with
   `ratingAdj = (BAYES_C × siteMean + sum) / (BAYES_C + count)` over per-user averages (`BAYES_C = 5`,
   unrated = the site-wide mean, 4.0 when there are no ratings at all) and `roomPlayers` the distinct
   players who ever posted a score on the table in this room. Drawn over the names that are not benched.
   - **Bench (a), low rating:** a member of this room gave the table a per-user average ≤ 2
     (`LOW_RATING_MAX`), unless at least 3 raters (`BENCH_CLEAR_MIN_RATINGS`) average ≥ 3.0
     (`BENCH_CLEAR_MIN_AVG`).
   - **Bench (b), thin turnout:** once the tournament has ≥ 10 rounds (`THIN_MIN_ROUNDS`), a table whose
     most recent run drew fewer than half (`THIN_FRACTION`) the median participation. Participation is
     counted the way the tournament boards count it (tournament attribution + name + `gameRunWindowSql`).
3. **Benched tables**, same weighted draw, only when Tiers 1 and 2 are both empty.

The audit row keeps `eventType: 'game_activated'` and its `source`, and gains `details.autoPick =
{ tier, points, contributors, tally, weight, benchReason, poolSize }` (raw ids, resolved at read).

## Consequences

- The top of Tier 1 is deterministic: the same queues give the same pick, and a room can see why.
- Queues are spent. A player whose queued table is auto-picked loses that row, the same as when their own
  win promotes it; the credit line in the announcement says so.
- A queue vote outranks the bench: a table a member rated low still wins if the queues chose it.
- The thin-turnout rule is the unvalidated part. It is guarded by the 10-round minimum and judges only a
  table's most recent run, but its threshold has not been tuned against real rooms; revisit it once rooms
  have run it.

## Rejected

- **Ownership as a signal** (My Tables inventory). Owning a table is not wanting to play it this week, and
  the inventory is anonymous by ruling; it would also tilt the board toward whoever filled in My Tables.
- **A single blended score** over queues, ratings and reach. It hides why a table won and lets a pile of
  weak signals outvote what players explicitly asked for.
- **A 10% wild card** at every auto-pick. The roam already exists for when nobody asked; adding chance on
  top of a clear queue choice is the dart board again.
- **Requiring a pick to submit a score.** Coupling score entry to the queue punishes players who just want
  to play.
