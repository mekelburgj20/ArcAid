# Contract: move room-ban management into the room admin area (v2.49.1)

v2.49.0 put the Ban/Unban UI on the PUBLIC `/:slug/members` page behind a cosmetic admin check.
Server gating was and is correct (`GET/POST /:roomId/admin/bans*` require `requireAuth +
requireRoomAccess`), but admin controls belong in the admin area: the user went looking in the
room admin settings and couldn't find them, and admin code paths on a public page are a
standing leak risk. No API changes — this is a UI relocation.

Patch release: version → 2.49.1. No migration.

## Settled (user-directed 2026-07-29)

1. Ban management moves INTO the room admin area. The public `/:slug/members` page becomes
   purely public again.
2. Non-admins must never see the banned list (already true server-side — keep it that way).

## Work

### A. New room-admin page: Members

- `admin-ui/src/pages/admin/` (match wherever the room-admin pages live — e.g. the same folder as
  the Join Requests / Identity pages; follow the existing convention exactly) → `RoomAdminMembers.tsx`.
- Route registered under the room admin routes (`App.tsx`, alongside `join-requests` / `identity`)
  at `${basePath}/members`.
- Nav entry in `RoomAdminLayout.tsx` `navItems`, placed in the people cluster next to
  **Join Requests** / **Identity** (label "Members", a lucide icon consistent with that cluster —
  `Users` is taken by Identity; pick something sensible like `UserCog` or `UsersRound`).
- Page content (move, don't reinvent — lift the working pieces out of the current
  `RoomMembers.tsx`):
  - Member roster with per-member **Ban** button (hidden for self, room admins, super admins,
    already-banned).
  - Ban confirm dialog: optional reason, optional duration in days (empty = permanent), and the
    explicit copy that banning removes them from the room and blocks re-joining while active.
  - **Banned** section listing active room bans (name, reason, when, expiry) with **Unban**.
  - Same endpoints as today (`GET /rooms/:roomId/members` for the roster,
    `GET/POST /rooms/:roomId/admin/bans`, `POST /rooms/:roomId/admin/bans/:banId/lift`), all via
    `lib/api.ts`.
  - Admin auth comes from the layout (the page only renders inside `RoomAdminLayout`), so DROP the
    `resolveViewerClaims` token-sniffing entirely — no cosmetic admin detection needed here.

### B. Public members page returns to public-only

- `admin-ui/src/pages/RoomMembers.tsx`: remove ALL admin affordances — `resolveViewerClaims`
  helper + `isAdmin`, the admin data fetch (`refreshAdminData`, bans + room-admin-ids state), the
  Ban button, the ban/unban modals, and the Banned section. The file should end up close to its
  pre-v2.49.0 shape (check `git show HEAD~1 -- admin-ui/src/pages/RoomMembers.tsx` — the version
  before the room-bans commit — and keep any unrelated improvements that landed since).
- Its header/blurb should read as a public roster again (no mention of bans).
- Keep the SERVER-side roster ban-filtering (`RoomRosterService`) exactly as is — banned players
  stay hidden from the public roster.

### C. Discoverability pointer

- `admin-ui/src/pages/Settings.tsx` "Users" card (the ADMIN-accounts card the user originally
  went looking in): add a one-line pointer under the card's existing description — e.g.
  "Managing players (including bans)? See **Members**." with a `<Link>` to `${basePath}/members`.
  Do not move or duplicate any ban UI into Settings; a pointer only.

### D. Docs

- CHANGELOG: v2.49.1 entry — ban management moved from the public members page to a dedicated
  room-admin **Members** page; note explicitly that the endpoints were always admin-gated so no
  data was ever exposed (this matters for anyone reading the history).
- Do NOT touch SPRINT_STATUS / ROADMAP / CLAUDE.md.

## Tests

- Existing backend suite must stay green (798) — no API changes expected; if a test referenced the
  public page's admin behavior, update it to the new page.
- FE suite green (146). Add a small test for the new admin page if the existing room-admin pages
  have test precedent; if none of them do, skip rather than inventing a harness.
- Verify by grep that `RoomMembers.tsx` no longer references bans, admin tokens, or
  `resolveViewerClaims`.

## Gates

Root build · admin-ui build · full BE + FE suites · CRLF numstat check · NO commit/branch/push.

## Blockers policy

If the room-admin page/route/nav conventions differ from what's described (folder layout, route
nesting, how pages get `roomId`), follow the ACTUAL convention and note the deviation — do not
force the structure described here. Stop and report anything that contradicts the contract
semantically.
