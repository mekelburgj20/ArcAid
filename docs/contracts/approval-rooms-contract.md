# Contract: approval rooms (join policy + queue + view gate) + member-picker admin add — v2.39.0

Second release of the membership & privacy arc. PREREQUISITE: v2.38.0 (`room-join-leave`) merged to main — verify package.json = 2.38.0 and `POST/DELETE /api/me/rooms/:roomId` exist before starting; STOP if absent. Recon facts embedded (from main @ v2.37.1; line numbers will have drifted slightly — verify).

## Binding decisions

- Per-room setting `JOIN_POLICY` ∈ `'open'` (default, absent = open) | `'approval'`.
- **Approval rooms hard-gate VIEWING**: non-members (signed-in or guest) get room name/logo/theme + "Request to join" ONLY. No scores/leaderboards/stats/lobby/comments/games/history — server-enforced 403s.
- Viewer classes with access: room members (`room_members` any source) ∪ room admins (JWT `gameRoomIds` or `game_room_admins`) ∪ `super_admin`.
- Approvers: room owner + room admins (= existing `requireRoomAccess` semantics). No new roles.
- **Migration 116** (115 was consumed by v2.38's room_members CHECK rebuild): `join_requests` per recon shape:
  ```sql
  CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_room_id TEXT NOT NULL REFERENCES game_rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT
  );
  -- partial unique: one pending request per (room,user)
  CREATE UNIQUE INDEX IF NOT EXISTS idx_join_requests_pending ON join_requests(game_room_id, user_id) WHERE status='pending';
  ```
- Kiosk on approval rooms: NOT supported this release — the kiosk page hits the same gated endpoints and will render the FE join-gate state; add a ROADMAP.md note for a future `KIOSK_KEY` pairing mechanism. Do not build bypasses.

## D1 — The view gate (BE)

New middleware `roomVisibilityGate` (in `src/api/middleware.ts` or a sibling file):

1. Mounted ONCE: `router.use('/:roomId', roomVisibilityGate)` in `src/api/routes/rooms.ts` immediately AFTER the `portal` (~:122-143) and `scoreboard-config` (~:146-171) route registrations, BEFORE `games/:gameId/info` (~:174). Express registration order makes portal/scoreboard-config bypass it structurally. Everything below — public reads, submit paths, picks, lobby, comments, stats, history, dashboard, game_library, tournaments, games/active, AND the admin routes — passes through it.
2. Gate logic: resolve the room's `JOIN_POLICY` (via `GameRoomSettingsService`; cache per-request only — settings hot-reload matters). `'open'`/absent → next() immediately (zero added queries for open rooms beyond the settings read — consider the settings-service's existing caching; do NOT add a new cache layer).
3. `'approval'` → decode Bearer token independently (mirror `conditionalRequireDiscordUser`'s decode pattern — `requireAuth` has NOT run yet): super_admin → next(); token `gameRoomIds` includes room OR `game_room_admins` row → next(); `RoomMembershipService.isMember(userId, roomId)` (composite-PK lookup, already optimal) → next(); else → `403 { error: 'This room requires approval to join', code: 'APPROVAL_REQUIRED' }`. Guests (no token) → same 403.
4. The join-request endpoints (D2) and the existing `POST/DELETE /api/me/rooms/:roomId` live in global.ts — NOT under the gate (correct: you must be able to request while unapproved). BUT v2.38's self-join POST must now be policy-aware: joining an approval room via plain self-join → 403 with the same code (must go through a request). Update that route.
5. Add `join_policy` + `viewer_status` (`'member' | 'admin' | 'pending' | 'none'`) to the portal response (~:122-143), computed with the same logic + a pending-request lookup. Portal stays 200 for everyone.
6. `scoreboard-config`: keep serving (theme keys only, recon-verified safe). Do NOT add JOIN_POLICY to its explicit whitelist.

## D2 — Join requests (BE)

- `POST /api/me/rooms/:roomId/join-request` (`requireDiscordUser`): room must be approval-policy (400 otherwise — open rooms use plain self-join); already-member → 200 no-op `{ status: 'member' }`; existing pending → 200 `{ status: 'pending' }` (idempotent, the partial unique index backstops races); insert pending → `{ status: 'pending' }`. Rate: general limiter suffices.
- Room-admin queue (mirror the score-reports API shape, room-scoped): `GET /:roomId/admin/join-requests?status=pending|resolved` + `POST /:roomId/admin/join-requests/:id/approve` + `/deny` — `requireAuth, requireRoomAccess('roomId')`, audit-logged like other admin writes (auditMiddleware applies on the admin paths — verify it catches these; if the admin sub-path convention differs, follow the existing admin-route registration pattern in rooms.ts).
- Approve: mark approved (resolved_at/resolved_by) + `RoomMembershipService.addMember(userId, roomId, 'self_join')` — reuse v2.38's hardened non-silent path. Deny: mark denied. A denied user may request again (new pending row is allowed by the partial index).
- Notify on approve: fire-and-forget `NotificationService.notify` web-push/DM ("You've been approved to join <room>") ONLY if a suitable existing notification type fits — if none fits cleanly, SKIP (do not invent a new notification type this release; note it).
- Count endpoint for the badge: `GET /:roomId/admin/join-requests/count` → `{ pending: n }`.

## D3 — Leak closures (BE)

1. **WebSocket** (`src/api/websocket.ts` ~:40-57): FE socket connect passes the player token via Socket.io `auth` payload (currently unused). In `join:room`/`join:lobby` (and `join:game` if game→room resolvable cheaply — if not, note and skip), when the target room is approval-policy: verify token + membership (same logic as the gate, extract a shared helper `canViewRoom(userIdOrNull, roomId)`) before `socket.join`. Open rooms: unchanged, zero added latency (policy check first). Client without access: silently don't join (no error channel needed).
2. **OG meta** (`src/api/ogMeta.ts` ~:164-228): early-return null (generic shell) when the room is approval-policy.
3. **Discord cross-room read commands**: extend `buildEnabledRoomSqlFilter` (`src/utils/discordRoomFilter.ts` ~:10-39) to also exclude rooms with `JOIN_POLICY='approval'` (same pattern as the DISCORD_ENABLED exclusion). All five consumers get it automatically. ROADMAP note: guild-implies-membership refinement.
4. **Global fan-out**: `GlobalScoreService.fanOutFromRoomSubmission` — early-return when origin room is approval-policy. **Flip-to-approval scrub**: when `JOIN_POLICY` transitions open→approval (detect in the settings-save path, mirroring how REQUIRE_DISCORD_LOGIN's orphan-on-flip hook works — see `OrphanService`/`GameRoomSettingsService` ~:144), delete the room's rows from `global_scores` (by `origin_game_room_id`) and trigger the global leaderboard recalc. Flipping back to open does NOT retro-fan-out (scores resume fanning on new submissions; note in code).

## D4 — FE

1. **Join-gate screen**: `PublicLayout` (and room pages generally) branch on portal `viewer_status` — approval room + `'none'`: render an on-brand gate (room logo/name/theme, "This room requires approval to join", Request-to-join button [login-gated — show LoginButtons if guest], and after requesting → "Request pending" state from `viewer_status: 'pending'`). Members/admins see the room exactly as today. KioskScoreboard: whatever it renders when fetches 403 must be non-broken — show the same gate message (minimal handling, not a redesign).
2. **v2.38 toggle awareness**: the landing-card bookmark on an approval room where viewer is non-member becomes "Request to join" (popup/confirm per the user's original design: "This room requires approval to join — request?"), pending state shows as such (portal/`me/rooms` don't carry per-room policy on the landing list — the public `GET /api/rooms` response needs `join_policy` added [safe, non-secret] so cards can branch; verify shape).
3. **Admin queue page**: new room-admin page "Join Requests" (route under RoomAdminLayout, mirror the `identity` page structure) — pending list (name/avatar/requested-at) with Approve/Deny, resolved history below. Nav badge: extend `RoomAdminLayout`'s nav array with a `badge` prop + 60s poll of the count endpoint (copy `SuperAdminLayout` ~:14-49 pattern) — show only for approval rooms.
4. **Settings**: `JOIN_POLICY` select ("Open — anyone can view and join" / "Approval required — invisible to non-members until approved") hand-rendered beside the REQUIRE_DISCORD_LOGIN select (~:963-979 pattern), added to `DANGEROUS_KEYS`. Flip-to-approval shows a confirm dialog stating the consequences: room becomes invisible to non-members AND its scores are removed from the Global Scoreboard.
5. **Member-picker admin add**: in the room Settings admins section (usersCard), replace/augment the Discord-username/ID input with a picker listing current room members (name + avatar via existing endpoints — check what ships member lists to admins; if none exists, add `GET /:roomId/admin/members` [requireAuth+requireRoomAccess] returning room_members joined to user_profiles). Selecting a member calls the existing add-admin endpoint with their raw user id (works for both providers since v2.35.0). Keep the raw-ID input as an "advanced" fallback.

## Constraints

- Migration 116 only. No new deps. Open rooms: byte-identical behavior everywhere (gate short-circuits, WS unchanged, fan-out unchanged, commands unchanged).
- Do not touch: MergeService/user_mappings, ScoreSyncPoller internals, kiosk beyond graceful-403 handling.
- User-visible strings: "Arcaid" casing.
- Hygiene: no `git add -A`; version via Edit; no SW bump.

## Tests

- Gate: matrix (open room × all viewer classes → pass; approval room × guest/non-member/pending → 403; member/admin/super → pass). Portal viewer_status per class. Self-join on approval room → 403.
- Join requests: request → pending; idempotent re-request; approve → member + resolved; deny → denied + re-request allowed; queue endpoints authz (non-admin → 401/403); count.
- Leak closures: fan-out early-return; flip-to-approval scrub (seed global rows, flip, assert gone); discordRoomFilter excludes approval rooms; OG returns null for approval rooms. WS: unit-test `canViewRoom` at minimum; socket-level test only if the harness supports it (note either way).
- FE: whatever the harness supports cheaply (gate-screen render on viewer_status, settings confirm flow logic if extracted).
- Full suites green.

## Process

Branch `approval-rooms` off main (must contain v2.38.0). Implement D1→D5, gates (root build, backend vitest FULL, admin-ui build+vitest, docker compose build), version → **2.39.0**, no CHANGELOG edit, commit `feature:` in logical chunks, do NOT push/PR. Report: files, decisions, verbatim gates, SHAs, deviations/blockers. STOP on semantic conflicts — as v2.38 proved, escalation beats guessing.
