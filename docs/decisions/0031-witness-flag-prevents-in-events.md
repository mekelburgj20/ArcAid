# ADR 0031 — In an event, a game the Witness saw start before the round opened does not count (by default)

**Status:** accepted (owner ruling 2026-10-23) · **Ships:** v2.169.0 · **Amends:** ADR 0020 and ADR 0021 for event rounds

## Context

ADR 0020 made the Arcaid Witness verdict a badge, never a gate: a `flagged` score (the table was launched
before its round opened, i.e. the player "geared up") stayed on the board at its rank with a warning. The
reason was the cost of a false flag, a wrong cabinet clock silently erasing an honest game.

On the first cross-platform test event (Witness Weekend Showdown, 2026-10-23) TomatoGrass geared up on
purpose: a Monster Bash game started at 16:53 CT and ended 34 seconds into round 1 (18:00:34). The Witness
flagged it correctly and the score took first place anyway. Every player in the test read that as the
system failing. Owner ruling: *a toggle on the tournament that defaults to "prevent", with "flag only" as
the opt-out for edge cases like a wrong clock.*

## Decision

- `tournaments.witness_flag_mode` (migration 188): `'prevent'` (default, existing tournaments included) or
  `'flag'`. Read through `normalizeWitnessFlagMode`; anything but `'flag'` is `'prevent'`.
- It acts at **standings time, not at ingest.** `EventResultService.getRoundBoard` now judges EVERY score
  of the round (not only each player's best) and, under `'prevent'`, ranks each player's best score whose
  verdict is not `flagged`. The flagged score above it is returned in `notCounted` (one per player) and the
  event page shows it struck through, "Not counted: started before the round opened". Nothing is deleted
  or refused, so:
  - switching the event to `'flag'` (or Re-verify after late evidence) recomputes from the same rows;
  - the room board, the game page and the Global Scoreboard are unchanged by this ADR (W22 covers carrying
    the verdict there).
- Only a positive `flagged` verdict is excluded. `unwitnessed` and `verified` count as before, and no
  phone or synced score is affected (they get no verdict).
- `computeStandings`, `compute` (the frozen result) and `recomputeFrozenResult` all read
  `getRoundBoard`, so standings, the frozen result and Re-verify agree by construction.

## Consequences

- Prevent can only catch what the Witness timed: cabinet ROM tables and Castcade live mode (imported PC
  tables). A no-ROM cabinet table and Castcade basic mode report one reading at exit and are never
  `flagged` (ADR 0021, v2.158.0); the host form says so.
- The false-flag risk ADR 0020 guarded against is now a host decision per event. Still owed: correcting a
  device's clock offset (exit time on the device against the server's receive time) before judging the
  launch, which would make the default safer (W20 note).
- `flagged` in the standings row (`witnessFlagged`) now means "a counted score was flagged", which under
  `'prevent'` cannot happen; it keeps its meaning under `'flag'`.
