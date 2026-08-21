# S22 Phase 2 — Admin Action Tools: Suspend / Rename-reset / Ban Enforcement (v2.44.0)

**Contract for the implementing agent. Written by the orchestrator from the 2026-07-26 recon (§E room-visibility seams, §G identity/ban enforcement points) + the Phase 1 (v2.43.0, PR #112, merged) foundations. Same escalation rule: contradictions between contract and code → STOP and report, don't guess. Mechanical drift (line numbers, import paths) → handle and note as DEVIATIONS.**

## Ground rules

- Branch: `s22-moderation-phase2` off current `main` (which contains merged Phase 1 @ `7d1a81245`). Version → **2.44.0** (Edit tool on package.json, never Write/node-rewrite).
- **Never `git add -A`.** Explicit paths only.
- **CRLF discipline (CLAUDE.md gotcha, updated this session):** both Write AND Edit tools can flip CRLF→LF on large backend files. After each commit batch check `git diff --numstat main...HEAD` vs `git diff -w --numstat main...HEAD` — must be byte-identical; fix with `unix2dos` if not.
- Migration number **119** is next free. Claim `119_room_suspension`.
- Gates: root `npm run build`, `cd admin-ui && npm run build`, backend vitest, admin-ui vitest, `docker compose build`.
- New admin endpoints in `src/api/routes/admin.ts` (blanket `requireAuth, requireSuperAdmin` at ~line 41 gates them; `auditLog` at server.ts:132 auto-audits all authed writes).
- Phase 1 pieces you will build on: `contentBlocklist.ts` (`assertNameAllowed`, `containsBlockedTerm`), the Reports page (`admin-ui/src/pages/Reports.tsx`), `ContentReportService`, the existing bans endpoints (`GET /admin/bans`, `POST /admin/bans`, `POST /admin/bans/:banId/lift` at admin.ts ~1287-1330, now with `CreateBanSchema`/`BanActionSchema` Zod from the Phase 1 fix round).

## Design decisions (settled by orchestrator — do not relitigate)

1. **Suspension is a `game_rooms` COLUMN, not a settings key.** It's super-admin-imposed moderation state, not room config: must survive settings tooling, and must be cheap to join in listings. Migration 119: three idempotent `ALTER TABLE game_rooms ADD COLUMN` — `suspended_at TEXT`, `suspended_by TEXT`, `suspended_reason TEXT`. `suspended_at IS NOT NULL` = suspended.
2. **Suspension blocks everyone except super-admins** — including the room's own admins ("hidden + inaccessible pending review"). Room admins see a clear "suspended" message, not a generic 404.
3. **Ban enforcement = block token issuance** (login callbacks + refresh) **+ room creation.** NOT yet extended into per-submit/comment paths (that's the fuller roadmap "C. Admin ban" workflow, later) — blocking token issuance covers the practical abuse case since all identified writes need a token; note the residual (an unexpired access token keeps working until refresh, ≤ its short TTL).
4. **Ban checks consider linked identities**: check BOTH the raw provider id AND `IdentityLinkService.resolveCanonical(id)` against active bans (a ban row may name either side of a link).

## 1. Migration 119 + suspension enforcement seams

Recon mapped the seams (no single gate function exists — each independently enforces; you must touch all):

1. **`roomVisibilityGate`** (`src/api/middleware.ts:192-216`, mounted `rooms.ts:197`): if room suspended and token role ≠ `super_admin` → `403 { error: 'ROOM_SUSPENDED' }`. This covers the whole room-scoped API surface incl. room-admin subroutes (verify the gate actually sits before the admin subroutes; recon says it's mounted at router level after portal/scoreboard-config — if admin subroutes bypass it, add the check to `requireRoomAccess` too and note it).
2. **`GET /api/rooms`** (`global.ts:928-930` → `GameRoomService.getPublic()`): exclude suspended rooms from the public listing.
3. **Portal** (`GET /api/portal`, `global.ts:580-622`, deliberately gate-exempt): when suspended, return a minimal `{ suspended: true, name, slug }` shape (no settings/config/scores) so the FE can render the suspended shell. Room's own `/:roomId/portal` variant (rooms.ts:121): it registers before the gate — give it the same minimal-shape behavior.
4. **WebSocket** (`canJoinRoomChannel`, `src/api/websocket.ts:20-32`): suspended → false (all three join handlers flow through it).
5. **Discord room filter** (`discordExcludedRoomIds`, `src/utils/discordRoomFilter.ts:14-22`): add suspended rooms to the exclusion union (needs a `game_rooms` query joined alongside the existing settings reads).
6. **OG meta** (`src/api/ogMeta.ts`): when the resolved room is suspended, skip tag injection (serve the generic shell).

NOT in scope: scrubbing the room's historical `global_scores` fan-out (suspension hides the room, not its players' global history) — document this in the PR body.

**Admin endpoints:** `POST /api/admin/rooms/:roomId/suspend` body `{ reason?: string(max 500) }` and `POST /api/admin/rooms/:roomId/unsuspend`. Sets/clears all three columns (`suspended_by` = acting super-admin id from token). 404 unknown room; suspend when already suspended → 409 or idempotent 200, pick one and test it (recommend idempotent 200 updating reason).

**FE:**
- `GameRoomManager.tsx`: Suspend/Unsuspend button per room (ConfirmModal, destructive styling, optional reason input) + a visible "SUSPENDED" badge on suspended rooms.
- `Reports.tsx` room-report rows: a "Suspend room" quick action (same confirm), shown only when not already suspended; refresh row state after.
- Public shell: `PublicLayout.tsx` — when portal returns `suspended: true`, render a minimal centered message ("This room has been suspended pending review.") in place of the page content, styled like the existing approval-gate shell (`isGated` branch is the model). No login CTA needed.

## 2. Admin display-name override

- `PATCH /api/admin/users/:userId/display-name` body `{ displayName: string | null }` (Zod schema in schemas.ts). `null` → clear (render falls back to username/id). Non-null → run the SAME validation as self-service: reuse `UserProfileService.setDisplayName`'s checks (length 2-32, regex, uniqueness vs `user_mappings`, `assertNameAllowed`) — extract/parameterize rather than duplicate (e.g. an internal `setDisplayNameFor(userId, value, { actor })` that both paths call). 404 when the user has no `user_profiles` row.
- FE: on `Reports.tsx` player_name-report rows, a "Reset display name" action → confirm → PATCH with `null` (the common moderation action; free-text rename can go through the same prompt later — Phase 2 ships clear-to-null only, keep it simple). Show the result inline.

## 3. Ban enforcement (token issuance + room creation)

- New `src/services/BanService.ts` (or extend `ScoreReportService` if cleaner — your call, note it): `isIdentityBanned(providerUserId): Promise<{ banned: boolean; reason?: string; expiresAt?: string }>` — active = `lifted_at IS NULL AND (expires_at IS NULL OR expires_at > now)`. Check raw id AND `IdentityLinkService.resolveCanonical(id)` (and, if the id IS canonical, any provider ids linked TO it — query `user_identity_links` both directions).
- **Enforcement points** (recon §G):
  1. Discord OAuth callback (`src/api/routes/auth.ts` ~:102-215, canonical resolution at :154): after identity resolution, before token minting → banned = reject. Match the callback's EXISTING error pathway (how does it surface e.g. OAuth denial to the FE? redirect with error param vs JSON — investigate and mirror; message "This account is banned."). Do NOT write profile rows for a banned login.
  2. Google OAuth callback (~:341-430, canonical at :398): same.
  3. `refreshAccessToken` (`src/api/auth.ts:100`): banned → refuse refresh (401 with a distinct code so the FE lands on login rather than retry-looping — check how `api.ts` handles refresh failure; it should already redirect to login on refresh 401).
  4. `POST /api/rooms` (`global.ts:1012`, right after discordId extraction ~:1014): banned → 403 with the ban message, before the kill-switch/cap checks.
- **Bans tab on Reports page:** fourth tab "Bans" — lists active + past bans (existing `GET /admin/bans`), add-ban form (provider id + optional reason/durationDays → existing `POST /admin/bans`; client-side hint that `iscored:*` ids are refused — the Phase 1 route check 400s them; ALSO add the same `iscored:*` 400 to `POST /admin/bans` itself if Phase 1 only covered the score-report ban route — verify), lift action (existing `POST /admin/bans/:banId/lift`, confirm modal). On player_name-report rows add a "Ban identity" quick action (only when `target_user_id` present), reusing the same confirm+reason UI.
- Pending-count badge unchanged (bans aren't "pending" items).

## 4. Tests

- **Suspension seams** — clone `room-visibility-gate.test.ts`'s `makeApprovalRoom` pattern into `makeSuspendedRoom` (direct UPDATE of the columns): guest/player/room_admin all 403 `ROOM_SUSPENDED` on room-scoped API; super_admin passes; `GET /api/rooms` omits the room; portal returns the minimal suspended shape (and NOT settings/config fields); WS `canJoinRoomChannel` false (unit-level is fine); `discordExcludedRoomIds` includes it. Suspend/unsuspend endpoints: super-admin-only (room_admin 403), audit row created (assert via `audit_log` if cheap), unsuspend restores access (fail-on-revert).
- **Display-name override** — set (valid), set (blocked term → 400), set (taken → conflict), clear (null), non-super-admin 403.
- **Ban enforcement** — refresh path: seed active ban → refresh refused; expired ban → allowed; lifted ban → allowed; ban on the OTHER side of an identity link → still refused (both directions). Room creation: banned → 403. OAuth callbacks: if the existing test suite has a callback-mocking pattern, add one banned-login case per provider; if no such pattern exists, unit-test `isIdentityBanned` thoroughly + the refresh/room-create integration, and note the callback gap as a DEVIATION rather than building new OAuth mock infrastructure.
- FE: Reports page Bans tab render test; suspended-shell render test if cheap.

## 5. Docs

- `CHANGELOG.md` 2.44.0. ROADMAP: mark S22 layer 3 shipped (suspend/rename-reset/ban-at-login); leave the fuller "C. Admin ban" workflow items (room-tier bans, content cascade, per-submit enforcement, ban DM) open with a note that token-issuance blocking shipped in 2.44.0. Do NOT edit SPRINT_STATUS.md.

## Out of scope (do not build)

Room-tier (per-room) bans, ban content cascade/hiding, per-submit/comment isBanned extension, ban Discord DM notification, automated LLM screening, free-text admin rename of display names (clear-only), kiosk KIOSK_KEY, comment reports, any Phase 1 rework beyond what §3 explicitly names.
