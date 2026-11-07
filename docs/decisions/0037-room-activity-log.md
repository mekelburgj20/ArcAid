# ADR 0037 — One room activity log: a filterable timeline of what happened, for room admins and the super-admin

**Status:** accepted (owner-approved spec 2026-11-07, interview), to be built as WORK.md G14

## Context

A room admin asking "why didn't Krobs' score post from his PC?" or "when did Krobs last post?" has no
answer in the UI. The facts are recorded, but in seven places, most of which the room admin cannot see:

| Fact | Store | Visible to a room admin |
|---|---|---|
| Scores, rotations, completions, settings, admin logins | `room_events` → Room Admin → Activity (no filters; pruned at **7 days** by `Scheduler`) | yes |
| Every Witness/Castcade play that reached the server, with outcome + reasons | `witness_evidence` | no (only the player's own "Where your plays went") |
| Limited-attempts ledger | `attempts` | partly |
| Check-ins, heartbeats, launches | `witness_checkins`, `witness_devices`, `witness_observations` | current state only |
| Rotation decisions | `rotation_events` | yes (Rotation log panel) |
| Admin writes | `audit_log` (no room column) | no |
| Server text log | `data/arcaid.log` | super-admin, last 200 lines only |

Some events leave no trace at all: a typed or Discord score refused by a gate (not a member, out of
attempts, platform, event closed) returns an error and is gone; a bot post that fails for a channel
permission is only a log line; a slash-command refusal is ephemeral.

And one class can never be explained server-side: a score the player's own software refused before
sending (Krobs' VPW Twilight Zone, W94, refused inside Castcade). The server can only show the launch and
the missing score.

## Decision

1. **One append-only table, `activity_log`** (migration 209), written at the existing choke points rather
   than assembled at read time from the seven stores. Read-time stitching would avoid duplicate data but
   makes keyword search and filters slow and fragile across differently-shaped tables, and the refusals
   need a new store either way.
2. **Room scope is decided at write time** and stamped on the row (`game_room_id`, nullable for
   server-level and room-less rows). A device event belongs to a room when the device's routing at that
   moment includes the room (designated to it, or "All my rooms" with the player a member). A later
   routing change never rewrites history.
3. **Rows store identity-stable ids, never names** (`canonical_user_id`, `tournament_id`, `game_id`), plus
   denormalized `tournament_name` / `game_name` / `table_name` for rows that outlive their target (as
   `rotation_events` does). Player labels resolve at read through `resolveUserLabels`; the player filter
   matches every alias and the display name.
4. **What a room's log holds:** score outcomes (landed, corrected, deleted, voided, refused by this room's
   gates, any source); device activity (check-in, online/offline transitions — never one row per
   heartbeat — launch/exit, pair/unpair) for devices routed here; admin actions and bot failures/refusals
   (slash-command refusals, posts the bot could not make, with the Discord error); tournament lifecycle
   (rotations, picks, polls, rounds, winners). Successful bot commands are NOT logged.
5. **A Witness/Castcade play that matched none of a room's tournaments and went to Global is NOT in that
   room's log.** It is in the super-admin view, with its reason.
6. **Every row has a `severity`** (`info` / `problem`); the "Problems only" filter is `severity = 'problem'`
   (refusals, failed bot posts, a device going offline, unmatched plays, a launch with no score).
7. **A log write never fails the action it describes.** It is caught, and failures are counted and shown
   on the super-admin view, because a silently swallowed write is this codebase's known failure mode.
8. **Retention: 90 days**, pruned daily. Source tables (`score_history`, `attempts`, `witness_evidence`, …)
   are not touched. On ship, a one-time backfill fills the last 90 days from the existing stores (what
   they still hold; `room_events` only has 7).
9. **Readers:** the room admin (their room, replaces Room Admin → Activity) and the super-admin (all
   rooms, room filter, plus server events: sync jobs, the iScored poller, bot errors). Same page component.
   Filters: player, date range, tournament, game, event type, free-text keyword, Problems only. Filters
   live in the URL (shareable link); CSV export of the filtered rows; live updates through
   `useLiveRefresh`. Times in the room timezone (`resolveTimezone`).
10. **What room admins never see:** IP addresses, device tokens, raw ids, and plays a member's device
    routed to another room.

## Consequences

- "Why didn't X's score post?" becomes a filter: player = X, Problems only. For a client-side refusal it
  reads "launched 21:14, exited 21:52, no score arrived", which points at the client but cannot say why.
  Closing that needs the client to report its local refusals (W95, Castcade side).
- Each new event source must write its row; a write path added later without one is invisible in the log.
  The rule goes in the rule files beside the score write-path invariant.
- `room_events` and today's Activity page are superseded; whether `room_events` is retired or kept for its
  other readers is decided in the build.
