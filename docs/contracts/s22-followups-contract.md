# Contract: S22 follow-ups — per-submit ban enforcement + comment reports + homoglyph hardening + Arcaid casing sweep (v2.47.0)

Four workstreams, one release. Migration budget: **120** (verified free — array ends at 119 in
`src/database/database.ts`). Version bump root `package.json` → 2.47.0. CHANGELOG entry covering
all four.

Recon file:line references below were verified 2026-07-27 against v2.46.0 — trust them as
starting points, re-verify before editing (line numbers may drift a few lines).

## Settled decisions (do not relitigate)

1. **One ban check:** `BanService.isIdentityBanned` (link-graph-aware) is the ONLY ban predicate.
   `GlobalScoreService.isBanned` (raw query, no link resolution, `GlobalScoreService.ts:71-81`)
   is retired — its call site delegates to BanService.
2. **Ban-check caching:** add a 10s in-memory TTL cache inside `BanService` following the exact
   existing idiom (`PickAwardGate.ts:23-51` / `NotificationService.flagCache`). Add
   `BanService.invalidate(providerUserId)` and call it from every ban-create/unban write path
   (grep `user_bans` INSERT/DELETE/UPDATE writers: `ScoreReportService.banUser`, the Reports admin
   ban/unban endpoints) so a fresh ban takes effect immediately despite the cache.
3. **Ratings endpoint (`rooms.ts` ~2556, x-user-id only, no JWT):** OUT of scope — cannot ban-gate
   an unauthenticated path. Leave as-is.
4. **Room-tier bans, ban→content cascade, ban→DM:** OUT of scope (ROADMAP-deferred items — do not
   pull in).
5. **comment_reports uniqueness:** partial unique index `WHERE resolved_at IS NULL` on
   `(comment_id, reporter_discord_id)` — follow the shipped `content_reports` pattern
   (`database.ts:1937-1955`), NOT ROADMAP's literal `UNIQUE(...)` sketch.
6. **Comment-report queue is super-admin-only** (matches the existing Reports page authorization).
   Room-admin visibility is future work.
7. **Homoglyph scope = cross-script confusables ONLY** (Cyrillic/Greek→Latin lookalikes).
   Doubled-letter and `*`/`+`-separator evasion stay accepted-open gaps — do not touch.
8. **Casing direction: "ArcAid" → "Arcaid"** (per the 2026-07-25 decision recorded in ROADMAP.md
   ~line 86). The two existing "Arcaid" strings in `auth.ts` (~240, ~576) are already CORRECT —
   leave them. Stylized all-caps wordmark occurrences (ARCAID / ARCAıD) are logo styling — leave.

## Workstream 1 — Per-submit ban enforcement

**New middleware** `requireNotBanned` in `src/api/middleware.ts`: no-op when `req.user?.discordId`
is absent (anonymous writers aren't bannable); otherwise `BanService.isIdentityBanned` → 403
`{ error: 'This account is banned.' }` (exact string used at login, `auth.ts` ban checks).
Composes after `requireDiscordUser` / `conditionalRequireDiscordUser` like `requireRoomAccess`.

**Apply to these route chains** (recon-verified handler locations):
- `rooms.ts`: `POST /:roomId/community-scores/:gameName` (~1365), `POST /:roomId/submit-score/:gameName`
  (~1486), `POST /:roomId/freeplay-score` (~1608), comments create (~2070), pick/queue writes
  (~667, ~826, ~853), catalogue proposals (~2327, ~2348).
- `global.ts`: `POST /global/scores` (~1448 — replace the `GlobalScoreService.isBanned` gate per
  decision 1), score report (~1654), game feedback (~1695), room report (~1735), name report
  (~1768), global rating (~1827), comments (~1887, ~1913), friends (~158), join-request (~269).
  (`POST /rooms` ~1043 already checks — align it to the shared middleware if trivial, else leave.)
- **Discord commands** (no Express chain): inline `BanService.isIdentityBanned` at the top of
  `execute()` in `/submit-score` (`submitscore.ts`) and `/pick-game`, and before the rating/comment
  follow-up writes (`submitscore.ts` ~367-502). Banned → ephemeral reply "This account is banned."

Sanity note: with submits blocked at the gate, the room-submission global fan-out path stays
implicitly clean — no fan-out-side check needed.

## Workstream 2 — Comment reports

- **Migration 120** `comment_reports`: mirror `content_reports` columns
  (id, comment_id, reporter_discord_id, reason, created_at, resolved_at, resolved_by, resolution)
  + the partial unique index (decision 5) + index on `resolved_at IS NULL` lookups as content_reports has.
- **`CommentReportService`** mirroring `ContentReportService.ts` (create w/ dupe-open-report
  rejection, list open/resolved w/ comment body + game/room context joined from `game_comments`,
  resolve dismiss/remove).
- **Report endpoint:** `POST /global/comments/:id/report` (`requireDiscordUser` + `requireNotBanned`,
  same rate limiter as the other report endpoints — check how room/name report POSTs are limited
  and match). 404 if comment doesn't exist.
- **Admin endpoints** in `admin.ts` (already under `requireAuth, requireSuperAdmin` at router
  level): list + resolve. `remove` resolution calls `CommentService.deleteComment` directly and
  resolves the report; `dismiss` resolves only. Both auto-audited (router already has
  auditMiddleware — verify it covers these; if admin writes auto-audit as CLAUDE.md says, nothing
  extra needed).
- **FE — Reports.tsx:** add a `Comments` tab (5th tab) following the existing tab/refresh
  structure: open reports with comment body, type (comment/tip), game name, room, reporter,
  reason; actions Dismiss / Remove (confirm dialog on Remove). Resolved list below, matching the
  other tabs' presentation.
- **FE — GameDetail.tsx** (~1166-1220 comment rows): add a `Flag` report button per comment row
  for Discord-logged-in viewers, reusing `ReportContentModal` (target-agnostic props — see the
  `PlayerDetail.tsx:223-247` usage as the template) pointed at the new endpoint. Hidden when not
  logged in; hidden on the viewer's own comments.
- **FE fix (small, in scope):** GameDetail's comment POST/DELETE fetches send only `x-user-id`;
  add the `Authorization: Bearer <player token>` header when a player token exists so the
  server's existing admin/mod delete tiers become reachable from the UI. No server change.

## Workstream 3 — Homoglyph confusables

Extend `normalizeForBlocklist` in `src/utils/contentBlocklist.ts` with a hand-rolled
`CONFUSABLES_MAP` applied after NFKD/strip/lowercase, following `LEET_MAP`'s single-char-fold
pattern: Cyrillic lookalikes (а е о р с х у к і ѕ ԁ һ ѡ ɡ и→u? NO — map only visual lookalikes
to their LATIN visual twin: а→a е→e о→o р→p с→c х→x у→y к→k і→i ѕ→s ԁ→d һ→h ѵ→v ѡ→w ј→j ԛ→q ⲟ→o)
and Greek (α→a ο→o ν→v ε→e ι→i κ→k ρ→p τ→t υ→u χ→x η→n μ→u? — include only shapes that
genuinely read as the Latin letter in lowercase UI text; when in doubt leave a char OUT — a
missed confusable is a smaller cost than a false positive on a legitimate Greek/Cyrillic name).
Lowercase first so only lowercase mappings are needed. Add tests to the existing blocklist test
file: each mapped char folds correctly; a mixed-script spelling of a blocked term is caught;
legitimate non-colliding Cyrillic/Greek words pass.

## Workstream 4 — Arcaid casing sweep ("ArcAid" → "Arcaid")

IN scope (recon inventory): logo `alt` texts (~15), UI copy strings (~25 across SubmissionSheet,
GameDetail, PlayerDetail, Tournaments, GameStates, AccountSettings, ChunkErrorBoundary,
MysteryAward, scoresCopy.ts, GameRoomManager), `admin-ui/index.html` title,
`admin-ui/public/manifest.json` name/short_name, `src/api/ogMeta.ts` (5), Discord bot texts
(ping/setup/notifications/submitscore/discord utils/NotificationService/OpsAlertService, ~10),
`README.md` (2), `docs/FEATURES.md`, `docs/HOW-TO-GUIDE.md`, `docs/VIDEO-TUTORIAL-SCRIPT.md`,
`docs/video-scripts/00-quick-spinup.md`, `docs/runbooks/restore.md` prose, `Terms.tsx` (9),
`Privacy.tsx` (4), server startup log lines (`src/index.ts` ~12, `src/utils/startup.ts` ~43),
`Settings.tsx` example value `ArcAid_Demo` → `Arcaid_Demo`.

OUT of scope (do not touch): storage keys / CSS classes / component & identifier names
(`ArcaidLogoAnimated` etc.), `arcaid.app` domain, DB/log file paths, Discord command names,
generated download filenames (`arcaid_games_template.csv`, `arcaid-logs-*`), stylized ARCAID /
ARCAıD wordmark text, `docs/decisions/` (incl. its README), CHANGELOG/SPRINT_STATUS history,
`docs/arcaid-glass-deck-v6.html` + `docs/arcaid-neon-circuit-v10.html` mockups, test fixtures.

Method: per-file targeted Edits, NOT a blind global replace — each hit is a distinct string.
manifest.json is served no-cache since v2.45.1, so the name change propagates without a rename;
do NOT rename icon files or bump `?v=` (icons are unchanged).

## Tests

- Middleware: banned user → 403 on a representative sample of the gated routes (one rooms.ts
  submit path, one global.ts write, comments create); anonymous request passes through; cache
  invalidation on ban (ban → immediate 403 without waiting out the TTL).
- BanService cache: hit/expiry/invalidate unit tests.
- CommentReportService: create/dupe-open-reject/re-report-after-resolve/list/dismiss/remove
  (remove deletes the comment).
- Report endpoint: auth required, banned reporter 403, unknown comment 404.
- Blocklist: confusables cases per Workstream 3.
- Existing suites must stay green (backend 707 baseline, admin-ui 132).

## Gates (all mandatory)

1. Root `npm run build` · 2. `cd admin-ui && npm run build` · 3. Full backend + admin-ui vitest
suites · 4. CRLF check (`git diff --numstat` vs `-w` — for the casing sweep this MUST be
near-identical per file; the sweep is single-word edits, any file showing whole-file churn is a
line-ending flip to fix before finishing) · 5. NO commit/branch/push — leave dirty for review.

## Blockers policy

If the code contradicts this contract (moved handlers, different middleware composition, an
existing rate limiter that doesn't fit, audit coverage missing on the new admin endpoints), stop
and report the discrepancy in your final report instead of guessing.
