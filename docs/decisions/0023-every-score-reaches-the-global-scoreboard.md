# ADR 0023 — Every score reaches the Global Scoreboard, unless the player opts out

**Status:** Accepted (2026-09-01)
**Amends:** ADR 0016 P2 §3c (the `'sync'` bar is KEPT and its reasoning sharpened), ADR 0018
(Throwdowns explicitly deferred this decision), ADR 0022 (VPXS scores).

## Context

The Global Scoreboard is the one place a player's results are seen by people outside the room they
play in. Which scores reached it had accumulated by history rather than by design:

| Where the score came from | Reached Global? | Why |
|---|---|---|
| Web tournament / event submit | yes | the original path |
| Freeplay, community score | yes | same service |
| Discord `/submit-score` | yes | same fan-out |
| **Throwdown** | **no** | ADR 0018 deferred it: "a product call, not an implementation detail" |
| **AtGames cabinet sync** | **no** | listed as "deliberately absent", a product call |
| **VPXS cabinet score in a tournament** | **no** | never wired up (ADR 0022 only wired the room-less fallback) |
| iScored sync | no | ADR 0016 P2 §3c — no provenance |

Read as a list of rules that is arbitrary. Read from the player's chair it is worse: **the same
score counts for your public record or not depending on which format you happened to play in.** Play
Bad Cats in a Throwdown and it vanishes; play it in freeplay and the world sees it. Nothing about
that difference is something a player would predict or want.

Owner ruling, 2026-09-01: *wherever you played a game, no matter what format, you should be rewarded
by having the world see how well you did — unless you explicitly opt out.*

## Decision

**Format never decides whether a score is published. The player decides.**

Every path that records a score for a real, linked account fans out to the Global Scoreboard:
tournament, event round, Throwdown, AtGames cabinet, VPXS cabinet. The single control is the
existing account preference `user_preferences.share_to_global` (default on), with the existing
per-submission checkbox still overriding it for one score where a submit form exists.

### The one exception, and why it is not about format

**iScored-synced scores stay out.** ADR 0016 P2 §3b forces `engine`/`device` to `unknown` for them,
because a score scraped off an iScored board carries no evidence of how it was played. The Global
Scoreboard ranks strangers against each other and splits boards by engine; an `unknown` row cannot
be placed honestly on any of them. That bar is about **missing provenance**, not about where the
score came from — which is exactly why it survives a decision that abolishes every other exclusion.

Every newly included path has the opposite property: an AtGames cabinet score knows its cabinet, a
VPXS score came out of the VPX launcher on a paired device, a Throwdown score was submitted by a
logged-in human through Arcaid's own form.

### Two guards that are not preferences

- **An unlinked cabinet account is never published.** `atgames:<id>` with no
  `user_identity_links` row has nobody to credit. Publishing it under a synthetic name on a
  site-wide board is worse than the score not appearing, and unlike a missing score it cannot be
  fixed after the fact. The score still lands on the room board, where the context makes it
  legible; linking the account later claims it.
- **Rooms keep their own switch.** `GLOBAL_SCOREBOARD_ENABLED = 'false'` on a room still suppresses
  fan-out from that room. A room owner opting their whole room out is a different decision from a
  player opting themselves out, and both remain available.

### One helper, not five copies

The newly-included paths have no submit form, so none of them can ask the player at submit time —
the account preference is the only voice available. `GlobalScoreService.fanOutAutomatedScore` is the
single place that resolves it and refuses an unlinked identity. Three call sites reach it
(`AtGamesEventSyncService.writeScore`, `VpxScoreIngestService.ingest`,
`ThrowdownScoreService.submit`); a fourth that hand-rolled the preference lookup would be a bug the
day somebody changed the rule.

## Consequences

- **`fanOutFromRoomSubmission` now tolerates a null room.** Its dedup uses `IS` rather than `=` so it
  stays NULL-safe, and a room-less score is recorded as `origin_type = 'global'` — which is what a
  Throwdown, belonging to no room, actually is.
- **The Global Scoreboard gets busier**, including with scores nobody typed. That is the point: the
  board becomes a record of what people played rather than a record of which submission form they
  happened to use.
- **The opt-out carries more weight than it used to.** Its copy was updated to say so plainly, since
  a player who set it a month ago set it against a narrower rule.
- **`'sync'` remains the one refusal**, enforced inside the fan-out rather than at its call sites, so
  a future caller cannot reinstate it by accident.
