# ADR 0024 — Auto-posted scores are deletable, and the delete survives the replay

**Status:** Accepted (2026-09-28)
**Amends:** ADR 0011 (the iScored tombstone is NOT extended to these sources), ADR 0022 (VPXS
scores from the launcher), the AtGames sync (P7).

## Context

Two sources write scores nobody typed: `score_history.source = 'vpx'` (the Arcaid Witness reads
the VPX launcher's own records on a paired cabinet, ADR 0022) and `'atgames'` (a host's "Pull
scores" reads an AtGames private tournament). A cabinet leftover that matches no room game also
lands on the Global Scoreboard directly (`VpxScoreIngestService.recordGlobal`).

Until now the per-row delete (`DELETE /api/rooms/:roomId/score-history/:historyId`) refused both
sources, for a real reason: both REPLAY. The cabinet re-sends up to seven days of score files
whenever it restarts or is re-paired, and a host may press "Pull scores" as often as they like, so
a deleted row would simply come back on the next replay.

Owner ruling, 2026-09-28: *"Players should have the option to delete their own auto-posted scores
and we need a mechanism that persists this decision in case the same score tries to auto post
again (for the same game/date/time)."*

## Decision

**Auto-posted scores are deletable under exactly the tiers a typed score is** (super_admin any row;
room_admin any row in their rooms; a player only rows whose `submitted_by_user_id` is theirs — so
an unlinked `atgames:<id>` row stays admin-only). **Every delete writes a play-scoped tombstone**
in a new table, `auto_score_suppressions` (migration 178), and **every ingest path consults it
through ONE predicate**, `AutoScoreSuppressionService.isSuppressed`.

### The match key is the play

`(source, owner_key, game_key, score, played_at)`:

- `owner_key` — the row's `submitted_by_user_id`, else its raw `discord_user_id`. That is exactly
  the player the ingest paths write on a replay (the paired account for a VPX score; the linked
  account or the synthetic `atgames:<id>` for an AtGames one).
- `game_key` — `normalizeGameName(name)`. The launcher sends up to three heterogeneous names
  (journal display name, `rom`, folder slug); the check accepts a hit on any of them, plus the room
  game's name on the room path and the catalogue name on the Global path.
- `played_at` — the play's own timestamp in SQLite UTC shape, compared at second resolution. For
  a room row it is `score_history.created_at`, which for these two sources already holds the
  launcher's game end / AtGames' submit time (ADR 0020 made ingest paths thread it through).

The suppression is **not room-scoped**. A play deleted from a room board must not reappear on the
Global Scoreboard once the table rotates off the card and the replay falls through to the leftover
path — so the VPX ingest checks it before choosing ANY destination.

### Why `played_at` may be NULL

A Global Scoreboard row carries only `submitted_at`, which is the INGEST time (`GlobalScoreService
.submit` stamps `new Date()`), not when the game was played. It cannot identify the play, so a
delete on the Global Scoreboard writes `played_at = NULL`, meaning "time unknown — match on
player + game + score alone". That is broader than a room tombstone: a later genuine play of the
same table at the exact same score would also be refused. For pinball scores that coincidence is
vanishingly rare, and it is the honest price of a row that never knew its own play time.

The room delete path does NOT add that broader tombstone when it cascades to the fanned-out global
twin — it has already written the exact one, and widening it would buy nothing.

`GlobalScoreService.restore` lifts the time-unknown tombstone its delete wrote (never a timed one a
room delete wrote for the same play), so an admin restore lets the next replay land again.

### Why the iScored tombstone is not written for these sources

`deleted_score_suppressions` (ADR 0011) exists because iScored cannot delete a score and the sync
poller would re-import it. These two sources are never pushed to iScored, so there is nothing for
the poller to re-import — and that table's MAX-score threshold would suppress every unrelated
LOWER synced score the same player later posts on that game. `deleteEvent` and a downward
`correctScore` therefore skip it for `'vpx'`/`'atgames'`; typed sources keep it exactly as before.

### Corrections

A corrected auto-posted row tombstones its OLD value (same `played_at`), in both directions: the
replay always carries the original number, and without the tombstone it would land again next to
the corrected one.

### The wire contract is unchanged

A suppressed VPX replay answers the cabinet `{ok: true, status: 'duplicate'}` — a status its
contract already knows (stop retrying, move on) — files no witness observation and fans out
nothing. `VpxIngestResult.status = 'suppressed'` exists server-side only.

## Consequences

- Deleting an auto-posted score is now permanent against replays, for the owner and for admins,
  on every delete surface: the per-row delete, the admin "wipe player from game" sweep, the ban
  content cascade, a score-report resolution, and the Global Scoreboard's self/bulk/admin
  soft- and hard-delete (the last three inside `GlobalScoreService` so no caller can forget).
- The AtGames preview and the real pull ask the same question through the shared
  `ScoreHistoryService.isDuplicate`, which now also answers "already had" for a suppressed play.
- `recordGlobal` now writes `source = 'vpx'`. Rows written before this change still carry NULL and
  are NOT backfilled: a photo-less, source-less `origin_type = 'global'` vpx/atgames row can also
  come from the OAuth draft commit (a global-target draft does not require a photo), so the shape
  does not prove a cabinet wrote it. Deleting one of those legacy rows writes no tombstone, but
  the replay is still refused: `recordGlobal` treats a SOFT-DELETED row with the same game,
  player and score as the record of removal, whatever wrote it (an admin restore clears
  `deleted_at` and the normal duplicate check applies again).
- **Identity changes move the owner key.** The key is captured at delete time. An unlinked AtGames
  row deleted as `atgames:<id>` is not matched once that account is linked (the next pull writes
  the linked account as the owner), and vice versa; a merge or identity link that re-points
  `submitted_by_user_id` does not rewrite existing tombstones. Accepted for now — recorded, not
  solved.
- Account deletion keeps the rows (a deleted tombstone would let the replay resurrect the play)
  and nulls only `deleted_by_user_id`, exactly as it treats `deleted_score_suppressions`.
