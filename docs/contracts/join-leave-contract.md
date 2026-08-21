# Contract: explicit room join/leave (v2.38.0)

First release of the membership & privacy arc (see ROADMAP "Room membership & privacy arc"). No migration — `room_members` already exists. Design decided with the user 2026-07-25.

## Semantics (binding)

- Membership sources today: `'submission'` (implicit, on score submit — KEEP), `'admin_invite'`, room-creation owner grant. This release adds `'self_join'`.
- **Join** = insert into `room_members` with `source='self_join'` (reuse `RoomMembershipService.addMember` — verify its conflict behavior; joining an already-member room is a no-op, NOT an error).
- **Leave** = delete the caller's `room_members` row for that room. Leaving does NOT touch `game_room_admins` (admin/owner grants are separate — an owner who leaves just drops the room from My Game Rooms; document with a comment). Leaving does NOT delete scores/claims. Re-submitting a score later implicitly re-joins (existing behavior, unchanged).
- Signed-in users only (any provider — `requireDiscordUser`). Guests see no join affordance.

## D1 — Backend

In `src/api/routes/global.ts` (near `/me/rooms`) or rooms.ts if a room-scoped route fits better — implementer's call, note it:

- `POST /api/me/rooms/:roomId` (join): `requireDiscordUser`; validate the room exists (404 else); `addMember(discordId, roomId, 'self_join')`; respond `{ success: true }`. Idempotent.
- `DELETE /api/me/rooms/:roomId` (leave): `requireDiscordUser`; delete own membership row; `{ success: true }` even if no row existed (idempotent).
- Add a `leaveRoom`/`removeMember` method on `RoomMembershipService` if none exists (check first).
- Rate limiting: the general limiter suffices (cheap idempotent writes) — no new limiter.

## D2 — Frontend

1. **Landing page room cards** (`LandingPage.tsx` / the `RoomCard` in it): signed-in users get a small bookmark-style toggle on each card — public-grid cards show "add" (e.g. lucide `BookmarkPlus` or `Plus`-in-circle, consistent with the page's icon idiom), cards in "My Game Rooms" show a "member" state (e.g. `BookmarkCheck`) that on click leaves (with a tiny inline confirm or immediate + toast-like feedback — implementer's UX call, keep it lightweight; NO heavy modal). After join/leave, the two sections re-split immediately (refetch `/api/me/rooms` or optimistic update of the local list — optimistic preferred, revert on failure).
   - The toggle must NOT hijack the card's main click-through to the room (stopPropagation; adequate hit area separation; keyboard accessible).
   - Guests: no toggle rendered.
2. **Room public pages** (`PublicLayout.tsx` header or the room home): a compact "Add to My Rooms" affordance for signed-in non-members. Implementer may place it in the UserMenu dropdown as a room-contextual item (e.g. "Join this room" when on a `/:slug/*` page and not a member) OR as a small header button — pick the least-cluttered option given S20/S21's mobile-width constraints (header space is tight on phones; the menu item is likely safer). Note the choice. Member state needs a corresponding "Leave this room" in the same spot.
   - Membership state for the current room: fetch `/api/me/rooms` once (or reuse if PublicLayout already has it — it does NOT today; a small hook `useMyRooms()` shared between LandingPage and PublicLayout is welcome if it simplifies).
3. **MyRooms page** (`MyRooms.tsx`): add a leave affordance per room row/card (same idempotent DELETE).

## Constraints

- No migration, no new deps, no new settings. `'submission'`-source implicit membership unchanged.
- Do not touch: join-policy/approval anything (that's v2.39), admin grants, room creation.
- Terminology: user-visible strings say "Arcaid" if the app name appears (new casing standard); avoid the name where possible.
- Hygiene: no `git add -A`; version via Edit; no SW bump.

## Tests

- BE: join/leave route tests following the existing route-test harness (supertest pattern from api-public-room-creation.test.ts): join → appears in /me/rooms; join twice → idempotent; leave → gone; leave non-member → 200 idempotent; guest → 401; leave does NOT remove a game_room_admins row (seed one, leave, assert intact).
- FE: the split/optimistic-update logic if extracted purely; component test for the toggle if cheap per existing precedent.
- All suites green (backend full, admin-ui build + vitest).

## Process

Branch `room-join-leave` off main — **verify main's package.json reads 2.37.1 before starting** (the z-index fix must be merged; STOP if not). Implement, gates (root build, backend vitest, admin-ui build+vitest, docker compose build), version → **2.38.0**, no CHANGELOG edit, commit `feature:`, do NOT push/PR. Report: files, decisions (esp. D2.2 placement), verbatim gates, SHA, blockers.
