# ADR 0018 — Throwdowns are room-less: one column, not a personal room

**Status:** Accepted (2026-08-24)
**Builds on:** ADR 0017 (Live Event format). A Throwdown *is* an event; this ADR is only about where one
lives when there is no game room.

## Context

The ROADMAP carried a spec for **player-to-player challenges without a game room**: pick a game, get a
shareable link, "let's see who can beat me on Medieval Madness", with challenge-back and rematch after.
Separately, ADR 0017 built the Live Event format — time-boxed rounds with server-clock enforcement — for a
room admin hosting a stream night.

The owner's call (2026-08-24) was that these are one product, not two: *"They are born of the same goal so
why have two separate iterations?"* That is right, and the engine settles it — a challenge is a
time-boxed competition on one game, which is exactly an event with one round.

What remained was a genuine question: **where does a room-less event live?** The original design note
listed three options and called them all awkward:

1. room-less tournaments (nullable `game_room_id`) — *"heavy, the engine assumes rooms everywhere"*;
2. auto-created hidden "personal rooms" — reuses everything, but *"needs creation-cap/cleanup thinking"*;
3. a new lightweight `private_tournaments` table with its own boards.

## Decision

**A Throwdown is a `format='event'` tournament with `game_room_id IS NULL`, `checkin_required = 0` and one
round, addressed by a short code.** Option 1 — and it turned out to cost one column, not an engine rewrite.

### Personal rooms were considered first, and rejected

The "one personal room per player, provisioned invisibly" design was drafted and discarded. It solved the
UX question (the player never sees a room) but not the structural ones:

- **Personal rooms eat the flat public slug namespace.** `arcaid.app/<slug>` is one space; every casual
  challenger would permanently claim a slug a real game room could then never have.
- **The share link would read as somebody's room URL** — wrong shape for a thing whose entire job is being
  shared with people who have never heard of game rooms.
- **Every room-scoped feature grows an "except personal rooms" caveat** — the room directory, `/api/me/rooms`,
  the super-admin Game Rooms manager, reports, stats. That tax is invisible now and painful in a year.
- `RoomNameClaimService` is first-claim-wins *per room*, so every participant would take a name claim in the
  creator's room.

### "The engine assumes rooms everywhere" was mostly false

Checked against the schema rather than assumed:

| | room-nullable already? |
|---|---|
| `tournaments.game_room_id` | yes — nullable, no FK |
| `games.game_room_id` | yes — nullable, no FK (ALTER-added, migration 102) |
| `submissions` | yes — no room column at all |
| `score_history.game_room_id` | **no — `NOT NULL` + FK. The only blocker.** |
| `community_scores.game_room_id` | no — but **avoidable** |

`EventResultService` already reads purely by `submitted_during_tournament_id`, so boards and standings were
room-agnostic before this ADR existed. `community_scores` is avoided rather than rebuilt: a Throwdown writes
`score_history` alone, which is fine because `score_history` is already the physical union every read path
uses.

So the whole cost was **migration 164**, making one column nullable.

### Migration 164 is deliberately paranoid

`score_history` is the hottest table in the app, and SQLite cannot drop `NOT NULL` in place. The rebuild:

- **is a `handler`, not a `sql:` entry** — the migration loop wraps `sql:` in a try/catch that *swallows*
  errors, and a half-migrated `score_history` loses scores silently;
- **transforms the stored `CREATE TABLE`** instead of hand-writing a column list. The table has grown ~10
  columns by ALTER; migration 077 (the closest precedent) hardcoded its list, which here would risk quietly
  dropping whichever column was added last;
- **asserts row counts before the `DROP`**, so a short copy never reaches the point of no return;
- **replays indexes from `sqlite_master`**, so one added after this was written still survives;
- **restores the AUTOINCREMENT high-water mark.** `DROP TABLE` deletes the table's `sqlite_sequence` row, so
  the rebuilt table would resume from `MAX(id)` and reuse the ids of deleted rows. `score_history.id`
  addresses the per-row score-delete endpoint, so a reused id means a stale request deletes a *different*
  score. Found by a test; do not remove the restore.
- **keeps the FK** — only `NOT NULL` goes. SQLite does not enforce a foreign key on a NULL, so room-scoped
  rows keep their `ON DELETE CASCADE`.

### What a Throwdown deliberately does not do

- **No global-scoreboard fan-out.** `GlobalScoreService.fanOutFromRoomSubmission` is room-keyed by
  construction. Whether a casual two-click challenge belongs on the site-wide board is a product decision,
  not an implementation detail, so it is not made here. Room events are unaffected.
- **No iScored sync** — iScored boards belong to rooms.
- **No room name claim** — with no room there is nothing to claim against, so the player's global display
  name is used.
- **No check-in** — participants are whoever opens the link and scores. A roster is friction on a thing
  whose point is two clicks.
- **No notifications in v1** (owner call). The link *is* the notification: the creator shares it themselves.
  That removes the "mass DM at 3am" risk by not building the thing that causes it. Fan-out for
  rematch/challenge-back stays opt-in, and the real fix when wanted is quiet hours — blocked on Arcaid
  storing no per-user timezone anywhere.

### One page, both shapes

`EventDetail` reads the room context **optionally** and renders a hosted event at `/:slug/events/:id` and a
Throwdown at `/throwdown/:code`. `ThrowdownDetail` is a three-line wrapper. This is the payoff of making a
Throwdown the same object: a second copy of the boards, the standings and the countdown would drift apart
within a release.

### First-click-wins rematch is enforced by an index

`rematch_of_tournament_id` carries a UNIQUE index. The service's pre-flight check exists so the second
clicker is handed the *first* rematch's link rather than an error — two rematches of one challenge would
split the field in half — but the database is the authority, not the check.

## Consequences

- `score_history.game_room_id` is nullable, so **any new query that groups or filters by room must decide
  what a NULL room means** rather than assuming every score has one.
- `ScoreHistoryService.log` takes `gameRoomId: string | null` and skips the room-membership write when null.
- Throwdown codes avoid `0`/`O`/`1`/`I`/`l`: they get read aloud on streams and retyped from phone screens,
  where an ambiguous glyph becomes a dead link with no way for the player to tell what went wrong.
- The ROADMAP's "private tournaments" entry is satisfied by this arc and no longer a separate plan.
