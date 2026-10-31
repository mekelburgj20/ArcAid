# ADR 0034 — The room owner decides whether a room is listed

**Status:** accepted (owner ruling 2026-10-30), built v2.203.1 (WORK.md G7)

## Context

Two values decided whether a room appeared on the arcaid.app landing page and room lists, and a room had
to pass both:

- `game_rooms.is_public`: set by the "List this room on the landing page" checkbox at creation, and after
  that only by a super admin (`/admin/rooms` → edit → Public). No room admin could see or change it.
- `game_room_settings.ROOM_LISTED`: the owner's "Listed on Arcaid" toggle on room Settings (v2.80.0),
  absent = on.

`arcaid_witness_demo` was created with the checkbox unticked (`is_public = 0` in every daily backup from
its creation on 2026-10-23). Its owner's toggle read "on", flipping it changed nothing, and the room never
appeared. The owner ruled: "The room owner should have the full control on whether or not a room is public."

## Decision

- `ROOM_LISTED` ("Listed on Arcaid") is the ONE listing switch.
- `game_rooms.is_public` stays as a mirror, because the public room list, the portal and several FE filters
  read it. Every writer keeps the two equal through `GameRoomService`: the room settings save
  (`syncPublicFromListed`), room creation (an unlisted create stores `ROOM_LISTED = 'false'`), and the
  super-admin edit (writes `ROOM_LISTED` to match).
- Migration 201 (`roomListedSingleSwitch`) reconciles existing rooms. A private room whose toggle was never
  saved stays hidden, with the toggle now stored off so Settings tells the truth. A saved toggle wins.
  Every other room is unchanged.
- "Who can VIEW the room" stays a separate axis (`JOIN_POLICY`, approval rooms) and is not affected.
- Suspension (`suspended_at`) still hides a room regardless; that is moderation, not a listing choice.

## Consequences

- A super admin can still list or unlist a room, but the owner sees the result on their own toggle and can
  reverse it. That is the intended direction of control.
- A new code path that writes `is_public` or `ROOM_LISTED` without the other recreates the bug. The rule is
  recorded in `CLAUDE.md` (multi-tenant section).
- The super-admin room edit is still not audited (WORK.md G9).
