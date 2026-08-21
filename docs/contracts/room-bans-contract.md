# Contract: room-tier bans + name resolution for raw IDs + landing polish (v2.49.0)

Three workstreams. Migration budget: **122**. Version → 2.49.0. The landing-page polish
(motto centering/spacing, Global nav link in `LandingPage.tsx`) is ALREADY DONE in the working
tree — do not touch `LandingPage.tsx`; just cover it in the CHANGELOG entry.

Recon file:line refs verified against v2.48.0 — trust as starting points, re-verify before editing.

## Settled decisions (user-confirmed 2026-07-28 — do not relitigate)

1. **Room ban strips membership**: banning removes the `room_members` row and blocks re-join
   while active. The FE confirm dialog must say so explicitly.
2. **ArcAid-side only** — no Discord guild kick.
3. **Ban UI lives on the existing `/:slug/members` page**, admin-aware: Ban action + banned
   section render only for room-admin viewers.
4. Schema: nullable `user_bans.game_room_id` (NULL = global), NOT a separate table.
5. Room ban must NOT block global surfaces (Global Scoreboard, friends) or other rooms.
6. `super_admins.username` staleness: OUT of scope.

## Workstream 1 — Room-tier bans

**Migration 122** `122_user_bans_room_scope`: `ALTER TABLE user_bans ADD COLUMN game_room_id TEXT`
(nullable) + index `idx_user_bans_user_room ON user_bans(discord_user_id, game_room_id)`.

**BanService** (`src/services/BanService.ts`):
- `isIdentityBanned(providerUserId, gameRoomId?: string | null)`. Semantics: omitted/null →
  global bans only (`game_room_id IS NULL`) — preserves every existing call site's behavior;
  provided → `(game_room_id IS NULL OR game_room_id = ?)` so global bans also bite in rooms.
- Cache key becomes composite (`${providerUserId}::${gameRoomId ?? ''}`); `clearCache()` on
  writes unchanged. Identity-link candidate expansion reused unmodified.

**Enforcement**:
- `requireNotBanned` (`middleware.ts`) auto-reads `req.params.roomId` (cast `as string`, may be
  absent) and passes it to the check — zero per-route changes needed; rooms.ts and the
  room-shaped global.ts routes (`/me/rooms/:roomId`, `.../join-request`) get room-awareness for
  free, pure-global routes keep global-only behavior.
- `POST /submission-drafts/:stateParam/commit` (`global.ts` ~761): the room id lives in
  `draft.target.roomId`, not params — add an in-handler room-ban check after the draft loads
  (403, same message) for room-target drafts. The middleware's global check stays.
- **Discord commands**: `/submit-score` + `/pick-game` inline checks become room-aware — pass the
  room id from wherever each command already resolves its room context (they operate per-room
  today; trace the existing guild→room resolution in the command and reuse it). Also the
  rating/comment follow-up re-checks in submitscore.ts.

**Room-admin API** (rooms.ts, `requireAuth + requireRoomAccess('roomId')`, auto-audited — verify
auditMiddleware covers these; if rooms.ts admin writes aren't auto-audited, add explicit audit
calls matching the nearest precedent):
- `GET /:roomId/admin/bans` — active + lifted room bans (this room only), with resolved display
  names (see Workstream 2's join pattern).
- `POST /:roomId/admin/bans` — body `{ discordUserId, durationDays?, reason? }` (Zod schema).
  Writes `user_bans` with `game_room_id = roomId`; removes the `room_members` row (decision 1);
  `BanService.clearCache()`. Guards: cannot ban yourself; cannot ban a super admin; cannot ban a
  room admin of THIS room (403 with clear message — admin misbehavior is a super-admin matter).
  Reuse the existing self-ban/canonical-resolution guard logic from `admin.ts`'s global ban route.
- `POST /:roomId/admin/bans/:banId/lift` — lift (must be a ban row belonging to this room; 404
  otherwise). Lifting does NOT auto-restore membership (they can re-join).

**Super-admin Reports → Bans tab**: additive — show a scope column ("Global" or the room name;
join `game_rooms.name`) on ban rows. The add-ban form stays global-only.

**FE — `RoomMembers.tsx`** (+ its data flow):
- Viewer-is-room-admin detection via the existing admin token/role plumbing (how other public
  pages detect admin — check RoomContext / localStorage admin token precedent; do NOT invent new
  auth). Public viewers see the page exactly as today.
- For admin viewers: per-member Ban button (hidden on self, room admins, super admins) opening a
  confirm dialog — reason (optional), duration (optional, days, empty = permanent), and explicit
  text that banning removes them from the room and blocks re-joining while active.
- A "Banned" section (admin-only) listing active room bans (name, reason, when, expiry) with an
  Unban action — banned users are no longer members, so they need their own list.
- All copy uses "Arcaid" casing.

## Workstream 2 — Resolve raw provider IDs to names

Reference pattern: `RoomRosterService`/`ContentReportService`'s `LEFT JOIN user_profiles` +
fallback chain (`display_name ?? username ?? raw id`). Apply to:

1. **`AdminService.getRoomDiscordAdmins`** (the user-reported surface): LEFT JOIN `user_profiles`,
   ship `display_name`/`username`; `Settings.tsx` Discord Admins card renders the resolved name
   prominently with the raw ID as small secondary text (JoinRequests.tsx precedent). For rows with
   NO profile (admin never logged in): extend `src/utils/discord.ts`'s REST helper family with
   `fetchDiscordUserInfo(id)` returning `{ username, globalName }` (guard `isDiscordUserId`,
   best-effort, in-memory cache ~1h TTL so the Settings page doesn't hammer Discord) and use it
   server-side to fill the gap. `google:*` ids with no profile render the raw id truncated.
2. **`ScoreReportService.listBans`**: resolve `discord_user_id`, `banned_by`, `lifted_by` →
   `*_display` fields; `Reports.tsx` Bans tab (rows + the ban-confirm modal echo) renders names,
   id in `title` tooltip.
3. **`ScoreReportService.listPending/listResolved`**: resolve `reporter_discord_id`.
4. **`CommentReportService` lists**: resolve `reporter_discord_id` (comment author already has
   `comment_display_name`).
5. **GlobalCatalogue feedback queue**: resolve `reporter_discord_id` in its listing endpoint +
   `GlobalCatalogue.tsx` render.

Leave alone (by-design fallbacks, recon-confirmed): Stats fallback tier, JoinRequests secondary
id line, Identity.tsx input placeholder, invite flows, activity log.

## Workstream 3 — Docs

- CHANGELOG v2.49.0 entry covering room bans, name resolution, landing polish (motto
  centering/spacing + Global nav link).
- ROADMAP: in "Player Self-Service + Moderation", mark room-tier bans SHIPPED (v2.49.0) and leave
  the still-open items (content cascade, ban DM, anon/IP tier) clearly listed.
- Do NOT touch SPRINT_STATUS/CLAUDE.md.

## Tests

- Room-ban semantics: room ban blocks that room's submit/comment (403) but NOT another room and
  NOT a global write; global ban still blocks room writes; linked identity (google alias) banned
  in room via link graph; ban strips `room_members` row; re-join + join-request blocked while
  active; lift → re-join works; lifted/expired ban stops blocking (cache respected via clearCache).
- Guards: self-ban 4xx, room-admin target 403, super-admin target 403, cross-room lift 404.
- Draft-commit room-target check: room-banned user 403, no score rows.
- `requireNotBanned` param pickup: same middleware, room route vs global route behavior.
- Name resolution: admins list ships display fields (profile row present vs absent vs google id).
- Baselines stay green: BE 755, FE 146.

## Gates (all mandatory)

Root build · admin-ui build · full BE + FE suites · CRLF numstat check (landing edits already in
tree — their diff is expected; don't revert them) · NO commit/branch/push.

## Blockers policy

Anything contradicting this contract (auditMiddleware coverage differs, admin-viewer detection on
public pages has no precedent, guild→room resolution isn't findable in the commands) → stop and
report rather than guess.
