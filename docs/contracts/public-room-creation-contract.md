# Contract: Public self-serve room creation (v2.33.0)

Orchestrator contract for the implementing agent. Recon facts embedded — verify line numbers before editing (drift expected; semantics binding).

## Goal

Anyone can create a game room from the public landing site after signing in with Discord. Creator automatically becomes the room's admin. Guardrails: per-user cap, per-user rate limit, reserved slugs, kill switch. Rooms created this way are standalone (Discord/iScored off — v2.32.0 mode) and upgradeable later via Settings.

## Deliverables

### D1 — Backend: `POST /api/rooms` (public create endpoint)

In `src/api/routes/global.ts` (non-scoped router; `GET /api/rooms` public list already lives there ~:810):

- Route: `POST /rooms`, middleware chain: `requireDiscordUser` → new `roomCreateLimiter` (see D2). NOTE from recon: `requireDiscordUser` (middleware.ts ~:136-153) accepts `role:'player'` tokens — intended; the guardrails are the protection.
- New Zod schema `PublicCreateRoomSchema` in `src/api/schemas.ts`: `{ name: min1 max100, slug: min1 max50 regex /^[a-z0-9_]+$/ + reserved-slug refine, description: max500 default '', is_public: boolean default true }`. Do NOT accept `logo_url`, `discord_guild_id`, `short_tag`, or `mode` from the public payload.
- Reserved slugs: export `RESERVED_ROOM_SLUGS` const from `src/api/schemas.ts` (or a small util if cleaner): `['admin','login','auth','invite','privacy','terms','friends','account','scoreboard','games','api','assets','kiosk','submit','create','createroom','room','rooms','settings','static','public','www','arcaid','help','about']`. Refine rejects with a clear message ("This name is reserved"). (Hyphenated route segments like `my-rooms`/`create-room` can't collide — the slug regex excludes hyphens.)
- Kill switch: read global setting `PUBLIC_ROOM_CREATION_ENABLED` via `SettingsService`; treat `'false'` as disabled → `403 { error: 'Public room creation is currently disabled' }`. Default (unset) = enabled. Do NOT seed the setting; no super-admin UI for it (DB/settings-endpoint managed if ever needed).
- Per-user cap: before create, `SELECT COUNT(*) FROM game_room_admins WHERE discord_user_id = ? AND role = 'owner'`; if >= 3 → `403 { error: "Room limit reached (3). Contact the site admin if you need more." }`.
- Slug uniqueness: reuse the existing pattern (`GameRoomService.getBySlug` → 409), same as `admin.ts` ~:59-60.
- Creation: call `GameRoomService.create({..., mode: 'standalone'})` and grant the creator `AdminService.addRoomDiscordAdmin(roomId, discordId, 'owner')` **atomically**. Recon: these are separate DB calls today — wrap in an explicit transaction using the idiom already in `GameRoomService.delete` (~:135-160). Preferred shape: add an optional `ownerDiscordId` param to `GameRoomService.create` that does the admin-grant inside its own transaction (keeps the transaction inside the service layer, where the file's idiom lives); the route then makes one call. Note: `addRoomDiscordAdmin` also seeds `room_members` via `RoomMembershipService.addMember` — keep that behavior (inside or immediately after the transaction; if pulling it inside is awkward, after-commit is acceptable since `room_members` is convenience, not authorization).
- Response: `{ success: true, room: { id, slug, name } }`.
- Audit: this endpoint is NOT under the admin audit middleware — acceptable (room creation is self-evident from the DB row + owner grant). Do not wire auditMiddleware here.

### D2 — Rate limiter

In `src/api/rateLimit.ts`: `roomCreateLimiter`, cloned from `globalSubmitLimiter`'s per-discordId pattern (~:66-79, `keyGenerator: req.user?.discordId || ipKeyGenerator(req.ip)`, must be mounted AFTER `requireDiscordUser`): **3 per hour per user**. Same comment discipline as the existing limiter.

### D3 — FE: `/create-room` page

- New route in `admin-ui/src/App.tsx`: `<Route path="/create-room" element={<ViewerAuthProvider><CreateRoom /></ViewerAuthProvider>} />` — mirror how `/my-rooms` is wrapped (~:179-189).
- New page `admin-ui/src/pages/CreateRoom.tsx`, cloning `MyRooms.tsx`'s auth-gate pattern: not signed in → explainer + "Sign in with Discord" button (`loginWithDiscord('__createroom__', '/create-room')` — recon confirmed arbitrary state strings are safe; server never reads state). Signed in → the form.
- Form fields: Room Name (required), URL slug (auto-derived from name: lowercase, spaces/invalid chars → `_`, editable; live client-side regex feedback), Description (optional), "List this room on the landing page" checkbox (→ `is_public`, default checked). Copy notes: mention the room starts web-only and "You can connect Discord and iScored later in the room's Settings." Submit → `POST /api/rooms` with `usePlayerHeaders()` bearer headers.
- Error handling: 409 → inline "That URL is taken"; 403 → show the server message (cap / disabled); 400 → Zod message (incl. reserved).
- **Post-create redirect:** call `loginWithDiscord(room.slug, `/${room.slug}/admin/dashboard`)`-equivalent — i.e. trigger the EXISTING room-admin Discord OAuth redirect flow so the standard `DiscordCallback` path mints their `room_admin` token and lands them on the new room's admin dashboard. Recon: `DiscordCallback.tsx` ~:134-139 already routes room_admins to `/${slug}/admin/dashboard`; the OAuth hop is instant for an already-authorized Discord session. Study `ViewerAuthContext.loginWithDiscord` (~:161-186) vs the admin login initiator — use whichever initiator the room-admin login page uses (bare-slug state) so the callback treats it as an admin login, NOT `player:<slug>`. If the existing initiators can't express "bare slug state + admin redirect" cleanly from this page, replicate the redirect URL construction locally (client id via `/api/auth/discord`, scope `identify`, state = bare slug) rather than modifying shared auth code.
- Do NOT modify `DiscordCallback.tsx` or `auth.ts` — the whole point of this flow choice is zero new auth surface. If that turns out to be impossible, STOP and report a blocker.

### D4 — FE: landing page button

`admin-ui/src/pages/LandingPage.tsx`: a "Create Game Room" affordance — (a) a button next to the "Game Rooms" header (~:110-114) or a dashed-border "+ Create Game Room" card appended after the room grid (~:121-126) — implementer's visual call, match the page's existing card/button idiom; (b) also wire the empty-state (~:116-119) to point at it ("No game rooms yet — create the first one"). It is a plain `<Link to="/create-room">` — NO auth plumbing on the landing page itself. Always visible (kill switch handled server-side; the create page surfaces the 403 if disabled).

## Constraints

1. NO migration — next free stays 113. Ownership = `game_room_admins.role='owner'` (existing free-text column; `addRoomDiscordAdmin` already types `'admin' | 'owner'`).
2. No `role === 'owner'` authorization branching anywhere — owner is data, not privilege, this release. No self-delete path (explicitly out of scope).
3. Super-admin create path (`POST /admin/rooms`, GameRoomManager) unchanged — no cap, no reserved-slug enforcement there (super-admin is trusted; do NOT add the refine to `CreateGameRoomSchema`, only to the new public schema).
4. Existing `GET /api/rooms` response shape unchanged.
5. Repo hygiene: NEVER `git add -A`; version bump via Edit tool; no SW bump; backend CommonJS / admin-ui ESM.

## Tests / gates

- Backend: new test file for the public create endpoint if the harness supports route-level tests (check existing `src/__tests__/` patterns — there are route/service tests; follow the closest precedent, e.g. mock DB service-level tests for: cap enforcement at 3, reserved slug rejection, kill-switch 403, owner-grant written atomically with room). If route-level testing has no precedent, service-level tests on the new `GameRoomService.create` owner-grant path are the minimum.
- Full backend vitest green (`s12-account-deletion` flake acceptable if main also flakes). Admin-ui build + vitest green. Root build + `docker compose build` green.

## Process

1. Branch `public-room-creation` off current `main`.
2. Implement D1→D4. Gates. Version → **2.33.0** (Edit tool). No CHANGELOG edit.
3. Commit(s) `feature:` prefix. Do NOT push, do NOT open PR.
4. Final report: files + per-file summary, discretionary decisions, verbatim gate results, commit SHA(s), deviations/blockers. STOP on semantic conflicts — don't guess.
