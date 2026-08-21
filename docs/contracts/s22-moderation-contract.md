# S22 Phase 1 — Content Moderation: Reports Queue + Blocklist (v2.43.0)

**Contract for the implementing agent. Written by the orchestrator from the 2026-07-26 recon report. Do not deviate silently — if you hit a contradiction between this contract and the code, STOP and escalate back with the specifics rather than guessing.**

## Phasing decision (context, not tasks)

S22 ships as two PRs:
- **Phase 1 (THIS contract, v2.43.0):** report backbone (rooms + player names) → super-admin Reports queue (which ALSO wires the existing, currently-consumerless score-reports admin API into the same page) + input blocklist.
- **Phase 2 (separate contract, v2.44.0):** admin action tools — suspend room, force-rename schema hardening, admin display-name override, ban-identity enforcement expansion (login/refresh/room-create via `IdentityLinkService.resolveCanonical`).

Phase 1's queue has partial teeth already: the score-reports tab exposes the existing dismiss/soft-delete/hard-delete/ban endpoints, and room renames can be done through the existing GameRoomManager. Full teeth land in Phase 2.

## Ground rules

- Branch: `s22-moderation-phase1` off current `main`. Version bump root `package.json` → **2.43.0** (use Edit, never a Write/`node -e` rewrite — CRLF).
- **Never `git add -A`** in this repo (huge untracked `data/` dirs). Stage explicit paths.
- Migration number **118** is confirmed free. Claim `118_content_reports`.
- Do NOT touch the existing `score_reports` / `user_bans` table schemas. We wire FE to their existing endpoints as-is.
- Gates before declaring done: `npm run build` (root), `cd admin-ui && npm run build`, backend vitest, admin-ui vitest, `docker compose build`.
- All new admin endpoints go in `src/api/routes/admin.ts` — the router-level `requireAuth, requireSuperAdmin` at admin.ts:40 gates them for free. `auditLog` middleware (server.ts:132) auto-audits every authed write — no extra wiring.

## 1. Migration 118 — `content_reports`

One unified table for room + player-name reports (NOT two tables; the shape is identical and the queue renders them together):

```sql
CREATE TABLE content_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL CHECK (target_type IN ('room','player_name')),
  target_key TEXT NOT NULL,              -- service-computed dedup key, see §2
  game_room_id TEXT REFERENCES game_rooms(id) ON DELETE CASCADE,  -- the reported room, or the room context of a name report (NULL for global-surface name reports)
  target_user_id TEXT,                   -- provider id of the reported identity when known (name reports)
  target_name TEXT,                      -- snapshot at report time: room name (room reports) / display name (name reports)
  reporter_user_id TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT
);
CREATE UNIQUE INDEX idx_content_reports_open_dedup
  ON content_reports(target_key, reporter_user_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_content_reports_status ON content_reports(target_type, resolved_at);
```

The partial UNIQUE index is the anti-spam mechanism — this is the **join_requests pattern** (migration 116), deliberately NOT the score_reports app-level SELECT-then-INSERT (recon found ROADMAP overstated score_reports' shape; no DB constraint exists there). Rely on the index: INSERT and catch the constraint violation → 409.

## 2. `ContentReportService` (new, `src/services/ContentReportService.ts`)

- `submitRoomReport({ roomId, reporterUserId, reason? })` — verifies room exists; snapshots `game_rooms.name` into `target_name`; `target_key = 'room:' + roomId`.
- `submitNameReport({ roomId?, targetUserId?, targetName, reporterUserId, reason? })` — `targetName` required (the offending string as seen); `target_key = 'name:' + (targetUserId ?? (roomId ?? 'global') + ':' + targetName.toLowerCase())`. If `targetUserId` present, key on identity (name changes shouldn't dodge dedup); else key on room+name.
- `list({ status: 'pending'|'resolved', type?, limit, offset })` — enrich with reporter + target `user_profiles` (display_name/username) the same way `GET /:roomId/admin/join-requests` does (rooms.ts:3714).
- `dismiss(id, adminId)` / `resolve(id, adminId, resolution)` — set `resolved_at/resolved_by/resolution` ('dismissed' vs the passed note). No cascade actions in Phase 1.
- `pendingCount()` — content_reports open count; the route layer adds score_reports' open count (see §3).
- Reason max length 500; trim; store NULL if empty.

## 3. Endpoints

**Public submit (in `global.ts`, NOT rooms.ts — room reports must work for non-members of approval rooms, who can see name/logo via portal; the visibility gate must not block reporting):**
- `POST /api/global/rooms/:roomId/report` — `writeLimiter, requireDiscordUser` (passes for Google-provider tokens too — ids are namespaced through the same claims). Body Zod: `{ reason?: string(max 500) }`. 404 unknown room, 409 duplicate open report (unique-index violation), 200 `{ ok: true }`.
- `POST /api/global/report-name` — `writeLimiter, requireDiscordUser`. Body Zod: `{ roomId?: string, targetUserId?: string, targetName: string(1..64), reason?: string(max 500) }`. Same 409 semantics. Model both schemas in `schemas.ts` next to the existing report schema.
- Per-reporter open-report cap: 20 open content reports max (mirror `GameFeedbackService`'s `MAX_OPEN_REPORTS_PER_USER`), 429 beyond.

**Super-admin (in `admin.ts`):**
- `GET /api/admin/reports?status=pending|resolved&type=room|player_name&limit&offset`
- `GET /api/admin/reports/pending-count` → `{ pending }` — **sum of open content_reports + open score_reports** (one badge for the whole Reports page).
- `POST /api/admin/reports/:id/dismiss`
- `POST /api/admin/reports/:id/resolve` — body `{ resolution: string }`.

Score-report admin endpoints already exist (admin.ts:1214-1284: list/dismiss/soft-delete/hard-delete/ban) — reuse untouched.

## 4. Super-admin Reports page (FE)

- New `admin-ui/src/pages/Reports.tsx`, route child of `/admin` in `App.tsx` (lazy import like siblings), nav entry in `SuperAdminLayout.tsx` nav array (after Approvals) with a pending-count badge using the **exact existing idiom** at SuperAdminLayout.tsx:36-44 (fetch on mount + 60s `setInterval`, silent `.catch` — badge is best-effort). Point it at `/admin/reports/pending-count`.
- Tabs: **Rooms | Player Names | Scores** (+ a Resolved toggle per tab, like JoinRequests.tsx's resolved-history section).
  - Rooms/Names tabs consume the new §3 endpoints. Each row: target name snapshot, room link (open `/:slug` in new tab where applicable), reporter, reason, age (`timeAgo` — copy JoinRequests.tsx's helper or extract if trivial). Actions: **Dismiss**, **Resolve** (prompt-free inline input for the resolution note — no `window.prompt`, S20 direction). For room reports also render a shortcut link to the existing Game Rooms manager page (where rename/delete already live) — that's Phase 1's "action".
  - Scores tab consumes the EXISTING `GET /admin/score-reports` + action endpoints (dismiss / soft-delete / hard-delete / ban). Ban action needs a small confirm with optional durationDays/reason inputs (endpoints accept `{durationDays?, reason?}`). Use `ConfirmModal` — destructive actions (hard-delete, ban) must confirm.
- Model the page on `JoinRequests.tsx` (structure) + `GlobalCatalogue.tsx`'s feedback queue (tabs within a page). NeonCard/NeonButton styling, `api.get/post` from `lib/api.ts`.

## 5. Report affordances (public FE)

Keep placement minimal and discreet; signed-in users only (any provider), hidden for guests:
- **Room:** a small "Report room" link in `PublicLayout`'s footer area (near Privacy/Terms) on room-scoped pages → opens a tiny modal (reason optional) → `POST /api/global/rooms/:roomId/report`. On 409 show "You've already reported this room."
- **Player name:** a flag affordance on the room player page (`/:slug/players/:name` header area) → same modal pattern → `POST /api/global/report-name` with `{ roomId, targetUserId (when the page knows the identity), targetName }`. If the page only knows the name string, send name-only — the service handles both.
- Build ONE shared `ReportContentModal` component (target-agnostic: title/label props) — do not fork two modals. Reuse ViewerAuthContext for the token; if not signed in, don't render the affordance at all.

## 6. Blocklist (prevention at input)

**New from scratch — recon confirmed zero existing profanity/normalization infrastructure. `normalizeGameName` is catalogue-specific; do not reuse it.**

- `src/utils/blocklistTerms.ts` — the curated data module: `export const BLOCKED_TERMS: string[]`. Policy: **unambiguous hate slurs only** (terms with essentially zero false-positive risk as substrings). Seed a modest starter set of the unambiguous racial/ethnic/homophobic slurs; keep it a plain reviewable array so the operator can extend it. Do NOT include general profanity (Scunthorpe problem — reports handle creative/ambiguous abuse).
- `src/utils/contentBlocklist.ts`:
  - `normalizeForBlocklist(input)`: Unicode NFKD → strip combining marks (diacritics) → strip zero-width chars (`​-‍﻿`) → lowercase → l33t fold (`0→o 1→i 3→e 4→a 5→s 7→t $→s @→a 8→b !→i`) → then produce TWO views: separator-collapsed (remove spaces/`.`/`_`/`-`) and raw-normalized.
  - `containsBlockedTerm(input): boolean` — substring check of each term against both views.
  - `assertNameAllowed(value, kind)` — throws a coded error `NAME_NOT_ALLOWED` (message: "This name isn't allowed." — do NOT echo the matched term).
- **Wire into every chokepoint (server-side only; FE just surfaces the error message):**
  1. `PublicCreateRoomSchema` (schemas.ts:143) — refine on `name` + `slug`.
  2. `CreateGameRoomSchema` (schemas.ts:109) — same refine (super-admin create).
  3. `PUT /api/admin/rooms/:roomId` (admin.ts:72) — **currently has NO Zod schema** (recon risk #2). Add a minimal `UpdateGameRoomSchema` covering exactly the fields `GameRoomService.update` whitelists (name, slug, description, is_public, logo_url, discord_guild_id, short_tag — all optional), with the blocklist refine on name/slug. Do not change `GameRoomService.update` behavior otherwise.
  4. `CreateTournamentSchema` / `UpdateTournamentSchema` (schemas.ts:17-48) — refine on `name`.
  5. `UserProfileService.setDisplayName` (UserProfileService.ts:92) — `assertNameAllowed` before the existing checks; surface as a coded error alongside the existing `DISPLAY_NAME_TAKEN` handling (check how users.ts:42-61 maps coded errors → HTTP and follow it).
  6. `RoomNameClaimService.resolveAndClaim` (RoomNameClaimService.ts:60-127) — reject the DESIRED name before the claim/suffix loop (both Discord + anon paths). Also apply in `checkAvailability` (the SubmissionSheet pre-check) so the FE learns before submit; verify SubmissionSheet renders the failure as its message rather than crashing — a generic "name not allowed" rendering is fine.
- Blocklist is prevention-only: NO retroactive scan of existing data (reports are the retroactive mechanism).

## 7. Tests

Backend (clone the `join-requests.test.ts` bootstrap: `setupTestDb()` + bare express + dynamic router import + `signToken` helpers):
- `content-reports.test.ts`: submit requires auth (401 guest); room report happy path; duplicate open report → 409; resolved report allows re-report; name report keyed by identity vs by name; admin list/dismiss/resolve require super-admin (403 for room admin); pending-count sums content + score reports.
- `score-reports-admin.test.ts` — **first-ever coverage** of the existing endpoints the new FE consumes (recon risk #7: they ship untested): seed a score report, exercise list → dismiss, and the ban action creating a `user_bans` row. Smoke-level is fine; do not refactor the service.
- `contentBlocklist.test.ts`: normalization cases (l33t, diacritics, zero-width, separator-insertion), clean-name negatives (incl. a Scunthorpe-style embedded-profanity name that must PASS, since general profanity is excluded), and one chokepoint integration each for room create + display name + claim path (fail-on-revert: assert the 4xx coded error).
- admin-ui: follow the existing co-located vitest convention; a Reports-page render test with mocked api + a ReportContentModal test are sufficient.

## 8. Docs

- `CHANGELOG.md` entry for 2.43.0.
- ROADMAP: mark the S22 layer-1/layer-2 items as shipped-in-2.43.0 (leave layer 3/Phase 2 items open); update the "S11 non-Discord admin comment moderation" item ONLY if you touched it (you shouldn't — out of scope).
- Do NOT edit SPRINT_STATUS.md (orchestrator owns it).

## Out of scope (do not build)

Suspend room, force display-name reset, ban enforcement expansion, comment reports, catalogue feedback changes, automated LLM screening, any `score_reports`/`user_bans` schema change, room-admin self-rename.
