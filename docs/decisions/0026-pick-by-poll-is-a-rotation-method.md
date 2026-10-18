# ADR 0026 — Pick by poll is a rotation method, and "admin decides" holds

**Status:** Accepted (2026-10-18)
**Amends:** ADR 0025 (§1's forcing, §3's gate, §4's fallback). Everything else in 0025 stands.

## Context

v2.161.0 (ADR 0025) shipped the community poll as part of a Season: `season_table_count IS NOT
NULL` gated the whole poll queue, a Season forced winner picks / auto-pick off, one active slot and
a 0-day cooldown, and a tie under the `admin` rule applied `season_tie_fallback` straight away so a
table was always queued.

Looking at the shipped form on 2026-10-18 the owner ruled that this conflated two different
things. A **Season** is a bound — N tables, standings, a pause, an end. **Picking by poll** is how
each next table is chosen — the same kind of decision as "winner picks next game" or "auto-pick".
A host should be able to run an endless weekly rotation that the community votes on, or a
twelve-week season whose tables an admin or the winner chooses. And "admin decides" should mean
what it says: when the vote ties, an admin decides — nothing is chosen for them.

## Decision

1. **Pick by poll is a Game Rotation method, independent of Seasons.** The poll queue is gated on a
   new `tournaments.poll_picks` (migration 182), not on `season_table_count`. In the form it is a
   third checkbox in Game Rotation beside "Winner picks next game" and "Auto-pick if no selection";
   its open/close hours, the plain-language echo and the tie-breaker sit under it.
2. **The forcing moves to the poll.** `poll_picks = 1` forces `winner_picks = 0`, `auto_pick = 0`,
   `max_active_games = 1`, `eligibility_days = 0` (same reasons as ADR 0025 §1). A Season alone
   forces nothing; it keeps its ranking group, pause, bound and season-end announcement. The
   season's poll bound ("polls stop once resolved polls reach the table count") applies only when
   both are on.
3. **The poll columns lose their `season_` prefix** — `poll_opens_before_h`,
   `poll_closes_before_h`, `poll_tie_rule` (renamed in place; every existing season backfilled to
   `poll_picks = 1`, since every season was poll-picked). The API field names follow the columns.
   Module, table, socket-event and route names (`SeasonPollService`, `SeasonScheduler`,
   `season_polls*`, `season:poll`, `/season`) are kept: renaming them is churn with no behaviour.
4. **"Admin decides" holds; there is no fallback.** The tie-breaker ("Poll Tie-breaker") has three
   options: `admin` (no table is queued until an admin chooses), `random`, `first_nominated`. A tie
   under `admin` resolves the poll with `tied = 1` and no result, queues nothing, and tells the
   channel an admin must choose and no table starts until then. The rotation's existing empty-queue
   behaviour (the "No Table Queued" embed, wait for admin) IS the admin alert — nothing new was
   built. `POST …/polls/:id/choose` queues the chosen tied candidate (or swaps a still-QUEUED
   choice); `can_choose` = tied AND (nothing queued yet OR the queued row is still QUEUED). A held
   tie keeps the next poll from being derived until the rotation it fed has passed.
   `season_tie_fallback` is gone from the API, UI and payloads; the column stays, unread.
5. **Pause stays a Season control.** `season_paused_at` is only settable on a Season (409
   otherwise); a poll-picked Season still honours it in the poll clock and in maintenance.

## Consequences

- A poll-only rotation polls forever; nothing bounds it and nothing "finishes".
- A tie under `admin` can now hold a rotation with an empty queue — deliberately. The host sees the
  channel notice hours before the rotation and the "No Table Queued" alert at it.
- The tournaments-list `season` sub-object and `GET /season` serve both shapes: `poll_picks` is in
  both; `table_count`/`tables_done`/`progress` are null for a poll-only tournament.
- `hasRealQueuedGame` (the "No Table Queued" suppression when a real QUEUED row exists) was never
  season-gated and still is not — so it already covers poll-picked tournaments.

## Alternatives rejected

- **Keep the poll inside the Season.** It forced every poll-picked rotation to invent a table count,
  and every season to run a poll whether the host wanted one or not.
- **Keep a fallback for `admin`.** A fallback that picks a table means the admin did not decide; the
  "never stuck" property it bought is already provided by the rotation's existing empty-queue hold,
  and `random` / `first_nominated` remain for hosts who want an automatic answer.
