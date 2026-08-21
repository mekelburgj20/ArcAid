# Contract: S23/S24 refresh (supersedes the S23 + S24 sections of improvement-audit-sprint-plan-v2.md)

Drafted 2026-08-02 from a full code recon. The v2 plan's S23/S24 text is STALE — do not implement
from it. This document is the authority. The three S22 residuals (verified-score loop, room-scoped
score report, bulk-untag wiring) are folded into S23 here. Everything below carries verified
file:line refs from the 2026-08-02 recon; line numbers drift — re-verify at implementation time and
treat a *semantic* mismatch (not mere line drift) as a stop condition, per the S22-parse-inventory
lesson (marker #18).

Corrections vs. the old plan (do NOT re-implement these):
- Discord `/submit-score` ALREADY collects + validates engine/device via `ScoreProvenanceService`
  (autocomplete options on both axes, auto-fill when unambiguous, real values written to all three
  score tables — `submitscore.ts:329-362,385-402`). The old "platform select via buttons" item is
  obsolete as written.
- `ensurePlatformAllowed` no longer exists (retired; `ScoreProvenanceService` is the authority).
- The CSV preview/commit importer is ALIVE (games → `global_games` proposals): BE
  `rooms.ts:2628` (preview) / `:2683` (commit), FE `GameLibrary.tsx:572/630`, schemas
  `schemas.ts:354/363`. It is the precedent for the score importer — copy its shape (FE parses CSV
  in-browser via PapaParse, posts JSON; no server-side session).
- `global_games.normalized_name` (old S24 item) SHIPPED as migration 130 (v2.65.0). Dropped.
- The old migration ledger (102–109) is dead. Next free migration number is **134** — verify
  against the array end (`database.ts:2156-2159` = 133) and claim upward at implementation time.
- `/room-scores` (renamed from `community-leaderboards`) has 1 ranking query per card, not 4 —
  chrome is already batched (`RoomScoresService.ts:249-286`).

---

# S23 — Discord submit for standalone rooms + bulk score import + integrity residuals

## S23.1 Discord `/submit-score` works without iScored (the substantive defect)

Today an `ISCORED_ENABLED=false` room cannot Discord-submit at all: the command aborts at the
creds check (`submitscore.ts:316-320`, "No iScored credentials configured. Cannot submit.")
BEFORE any local write. Standalone room creation seeds `ISCORED_ENABLED='false'`
(`GameRoomService.ts:99`), so every standalone room is locked out. Additionally
`resolveActiveSubmitGame` hard-requires `iscored_id` (`submitscore.ts:53`), so a game that was
never pushed to iScored resolves as not_found with iScored-flavored copy (`:220`).

Fix — decouple the local write from the iScored sync:
- `resolveActiveSubmitGame`: drop the `!game.iscored_id` rejection; return the row with
  `iscored_id` possibly null. Keep the suspension re-check exactly as is (`:54-59`).
- Submit flow: run the full local path unconditionally (photo save → provenance resolve/validate →
  `submissions` upsert → `ScoreHistoryService.log` → leaderboard invalidate → lobby feed →
  fan-out → success reply). iScored sync becomes a conditional step: only when
  `getIScoredCredsForRoom` returns creds AND `game.iscored_id` is non-null. When skipped, skip
  silently (web paths via `IScoredSubmitSync` behave the same way for disabled rooms — mirror
  that; recon the exact web behavior and match it).
- Copy: the not-found message drops the "linked to iScored" phrasing. On successful local-only
  submit, the reply must NOT claim iScored sync happened.
- Failure isolation: if iScored sync throws, the local write must survive and the reply should
  still be success (web precedent — sync failure is logged, not surfaced as submit failure;
  verify against `IScoredSubmitSync` and match).
- Photo temp-file handling stays as is (written before, cleaned in `finally` `:438-441`).

## S23.2 `/submit-score` success reply: rank feedback

Old S23 item, still valid: include the player's resulting rank on that game's board in the
success reply. The web submit paths ship rank feedback (S5-era shared helper — locate it; if no
reusable helper exists server-side, compute rank from the freshly-upserted `submissions` row with
one windowed query). Keep it one line in the existing embed/reply — no new embeds.

## S23.3 (OPTIONAL, time-boxed) ambiguous engine/device via select menu

When >1 engine or device is possible and the option wasn't provided, the command currently
rejects and asks the user to re-run with the option (`:257-259`, `:268-270`). Optional polish:
respond with a Discord `StringSelectMenu` (one for engine, then device narrowed via
`devicesFor(scope, engine)`) and complete the submit on selection. Constraints: interaction
tokens expire (15 min) — hold the pending submit context in memory keyed by interaction id with
TTL cleanup; the photo attachment URL must be captured before the deferral. If this exceeds
~a half day or fights Discord.js ergonomics, SKIP and report — the auto-fill + autocomplete
path already covers the common case.

## S23.4 Admin bulk score-import CSV (preview → commit)

New room-admin tool: import historical scores in bulk. Columns:
`game_name, player_name, score, date (optional ISO), engine, device, photo_url (optional)`.

Shape — copy the game-CSV precedent exactly (FE parses in-browser with PapaParse, posts JSON):
- `POST /:roomId/scores/import-csv-preview` — `requireAuth, requireRoomAccess('roomId'),
  requireNotBanned`. (Note: the game-CSV routes lack `requireNotBanned` — pre-existing,
  out of scope, do not fix here.) Zod: rows array `.min(1).max(500)`. Per row, resolve the game
  (room library / catalogue name match — recon how activate/pick resolve names and reuse),
  validate engine/device via `ScoreProvenanceService` against the resolved game's scope, parse
  score/date. Bin rows: `ok` | `needs_review` (ambiguous game name) | `error` (unknown game, bad
  provenance, bad score). Return `{ rows, summary }`.
- `POST /:roomId/scores/import-csv-commit` — same auth. Consider the identity-preview
  `previewHash` 409 drift-guard pattern (`rooms.ts:4857-4903`) — use it if cheap, skip if not
  (the game-CSV commit re-checks per row instead; either discipline is acceptable, state which).
  Sequential per-row best-effort loop with per-row error collection, mirroring `:2697-2742`.
- Writes go through the SAME service path as normal submits so identity/history stay consistent:
  `submissions` upsert (id `${gameId}-${lower(name)}`, keep the engine-COALESCE upsert guard) +
  `ScoreHistoryService.log`.

RULINGS (decided, implement as stated):
- **`source='community'`** on the history rows. Rationale: `score_history.source` has a CHECK
  constraint `('tournament','community','sync')` (`database.ts:173`) — adding a new value means
  rebuilding the biggest table (not worth it); `'sync'` is ruled out because doctrine says
  sync ⇒ engine/device `unknown` unconditionally (ADR 0016 P2) and CSV rows carry real
  admin-supplied provenance. `'community'` fits "score recorded outside a tournament window."
- **No tournament linkage**: `submitted_during_tournament_id` stays NULL. These are historical
  all-time scores; they appear on Room Scores + game detail, never on tournament boards.
- **No Global Scoreboard fan-out**: `submitted_by_user_id` stays NULL (rows are names, not
  authenticated users), so `fanOutFromRoomSubmission`'s guest gate already excludes them — do
  NOT call fan-out from the import path at all; assert this in a test.
- **No iScored sync** from the import path.
- **No lobby feed events, no score toasts** — bulk imports must not spam the feed. One
  `leaderboard:updated` per affected game at the end is fine.
- Explicit `AuditService.log` on commit (row count, actor) — auditMiddleware does NOT fire on
  router routes (de facto doctrine, ROADMAP "Audit" bullet).
- FE: new panel/dialog on the room admin side next to the existing library CSV import
  (GameLibrary page or Leaderboard admin page — implementer's call, state it), with template
  download mirroring `downloadTemplate` (`GameLibrary.tsx:661-671`).

## S23.5 (S22 residual) Bulk-untag wiring — trivial

`POST /:roomId/games/bulk-untag` exists (`rooms.ts:2487-2506`) with zero FE callers. Add an
"Untag…" action to the GameLibrary bulk bar (`GameLibrary.tsx:1472-1484`) beside Tag…/Activate…/
Pin: a dialog mirroring `BulkTagDialog` (state `:403`, handler pattern `:913-925`). Done.

## S23.6 (S22 residual) Room-scoped score report

Score reports are global-only today (`POST /api/global/scores/:scoreId/report`,
`global.ts:1997-2030`). The blocker is schema: `score_reports.score_id` (`database.ts:442-453`)
has no table discriminator and every `ScoreReportService` consumer hard-joins `global_scores`
(`ScoreReportService.ts:88,113,142,154,174`).

- **Migration 134 (or next free)**: `ALTER TABLE score_reports ADD COLUMN score_source TEXT NOT
  NULL DEFAULT 'global'` (values `'global' | 'room_history'`) + `ADD COLUMN game_room_id TEXT`
  (NULL for global rows). ALTER-ADD only — no rebuild. Raw-sql migration is fine (idempotent
  swallow matches the existing ALTER pattern).
- New route `POST /:roomId/score-history/:historyId/report` — `writeLimiter, requireDiscordUser,
  requireNotBanned`. Verify the history row belongs to the room and isn't orphaned; duplicate
  open-report 409 (mirror `global.ts:2007-2014`); insert with `score_source='room_history'`,
  `game_room_id`.
- `ScoreReportService` branches on `score_source`: list joins `score_history` for room rows
  (player name, score, game name, photo); `ban` derives the identity from
  `score_history.submitted_by_user_id` (report "cannot ban: anonymous score" when NULL — do not
  guess an identity from the display name); soft-delete routes through the EXISTING per-row
  delete machinery (the `DELETE /:roomId/score-history/:historyId` path's recompute + tombstone
  logic — reuse the service logic, do not fork the recompute).
- Reports page Scores tab: render both kinds with a scope column (Global vs. room name) —
  precedent: the Bans tab scope column (v2.49.0).
- FE affordance on room GameDetail rows: reuse `ReportContentModal` with an endpoint prop
  (already the pattern for comment reports at `GameDetail.tsx:1290-1296`) — NOT
  GlobalGameDetail's `window.prompt`. Place beside the existing hover-only per-row controls.
- This extends the `score_reports` system. Do NOT touch `content_reports` or `game_feedback` —
  three report systems exist deliberately; this lands in the first.

## S23.7 (S22 residual) Verified-score loop (minimal, gates future self-EDIT)

Do NOT resurrect `scores.verified` (zero readers/writers; `scores` is a dead legacy table —
recon §7). Target `score_history`:

- **Migration (next free after S23.6's)**: `ALTER TABLE score_history ADD COLUMN verified_by
  TEXT` + `ADD COLUMN verified_at TEXT` (both NULL).
- Routes: `POST /:roomId/score-history/:historyId/verify` + `/unverify` — `requireAuth,
  requireRoomAccess('roomId')`. Sets/clears `verified_by` (admin identity) + `verified_at`.
  Explicit `AuditService.log` on both.
- Surfaces (minimal): checkmark on verified rows in the GameDetail per-player history expand
  (where the delete icon already lives), and on the leaderboard row IF the ranking row's backing
  best score is verified — only if that data is cheap to ship (the tournament boards read
  score_history directly, so it usually is); if the "All-time" path can't say cheaply, ship the
  history-expand checkmark only and note the gap.
- Admin affordance: verify/unverify action next to the existing per-row delete (admin-visible
  only, same admin-detection the per-row delete uses).
- No auto-verification, no bulk verify, no player-facing "request verification" — floor only.
  This exists to make the future self-EDIT question ("can edits raise a score?") answerable.

## S23 gates
Root + admin-ui builds · full BE+FE vitest (baselines: backend 1325, admin-ui 395 — re-verify on
branch first; note the concurrent discord-hq branch may land first and raise baselines) · CRLF
check (`git diff --numstat` vs `-w --numstat`) · no push · no version/CHANGELOG/sw.js
(orchestrator). Tests: standalone-room Discord submit end-to-end (local write, no iScored call,
honest reply) · iScored-room behavior unchanged · CSV preview binning + commit idempotence +
no-fan-out assertion · room report insert/branching + global reports unaffected ·
verify/unverify round-trip + audit rows. Blockers → report, don't guess.

---

# S24 — Backend efficiency round 2 (refreshed)

Ordering within S24 matters: do S24.1 (read-time join) FIRST — it deletes the invalidation
storms that make S24.3's thundering herd frequent, and it touches the same queries S24.2 rides.

## S24.1 Read-time profile join (kills the rename/avatar cache nuke) — includes the ROADMAP avatar_url fold-in

Today `LeaderboardService.recalculate` (`:104-105,140-152`) and
`GlobalLeaderboardService.recalculate` (`:218-219,276-286`) bake `display_name`/`avatar_hash`
into cache JSON, so profile changes call `invalidateAll()` — `users.ts:51-52` (rename, both
services) and `auth.ts:282,630` (avatar change — **which nukes ONLY LeaderboardService: avatar
changes are permanently stale on the Global Scoreboard today. Recon-found live bug; this item
fixes it structurally.**) `invalidateAll` is a whole-table DELETE (`LeaderboardService.ts:376`),
and after it, `getActiveLeaderboards`' per-game cache-miss fallback (`:532`) serially
recalculates the entire room on the next page load — the compounding latency spike.

- Cache identity-stable rows only (keys: `submitted_by_user_id` / `iscored_username`); LEFT JOIN
  `user_mappings` + `user_profiles` at read time in every cache-consuming read path, following
  the exact join pattern documented in CLAUDE.md "Display-name resolution in BE leaderboard
  queries".
- Delete the `invalidateAll` calls at `users.ts:51-52` and `auth.ts:282,630`. Leave all other
  `invalidateAll` sites (settings/merge/admin) untouched.
- **Fold-in (closes ROADMAP "Google avatars" line 22):** while touching these read paths, add
  `up.avatar_url` to the SELECTs + response shapes, and thread `avatarUrl` through the
  `<PlayerAvatar>` call sites' TS interfaces + JSX (~8 sites; `PlayerAvatar` already accepts the
  prop and `resolveAvatarUrl()` already prefers it). One pass over the queries instead of two.
- The affected read surfaces (from CLAUDE.md's list): `LeaderboardService`,
  `GlobalLeaderboardService` (×2 paths), `RankingService.calculateOverallRankings`,
  `StatsService.getOverallStats`/`getAllPlayerStats`/`getRoomOverview` — the RankingService and
  StatsService queries are NOT cached-JSON paths (watermark / live queries); for those this item
  is only the `avatar_url` addition.
- Tests: rename → next read shows new name with NO recalculate (assert cache row untouched);
  avatar change → global scoreboard reflects it (the recon bug's regression test).

## S24.2 Poller tick churn

Per tick, BEFORE the notification-gate decision (`ScoreSyncPoller.ts:262`), the poller does: all-
rooms SELECT (`:211`), then **serial per-room `getIScoredCredsForRoom`** (`:215-221`) — each call
= ≥4 uncached `game_room_settings` reads (`iscoredCreds.ts:32-39`), even for
`ISCORED_ENABLED=false` rooms — then full-table loads of `user_mappings` (`:232`) and
`player_aliases` (`:237`).

- Batch creds: one `SELECT game_room_id, key, value FROM game_room_settings WHERE key IN (...)`
  per tick (or memoize with invalidation hooked into `GameRoomSettingsService.set/saveMany/
  delete` — the hook point already exists at `GameRoomSettingsService.ts:28`). Decrypt via the
  existing `isEncryptedKey` path — do not hand-roll decryption.
- Defer the `user_mappings` + `player_aliases` full loads until the first account whose
  `decision.run` is true that tick (load-once-lazily, shared across accounts within the tick —
  freshness contract "fresh per cycle" is preserved).
- Regression test: a tick where every account's gate says skip performs zero
  mappings/aliases queries (assert via query spy/counter).

## S24.3 Thundering-herd dedup

No in-flight dedup anywhere: `LeaderboardService.getForGame` (`:161-170`),
`RankingService.getRankings` (`:452+`). N concurrent cold reads = N recalculates.
- Add an in-flight promise map keyed on gameId/groupId, `.finally(() => map.delete(key))` —
  copy the in-repo precedent `RAImportService.ts:52-63` verbatim.
- Also: `getForGameByProvenance` (`LeaderboardService.ts:200-283`) deliberately bypasses cache
  (documented, correct) — give it the same in-flight dedup keyed on
  `(gameId, engine, device)`; do NOT add a persistent cache (the bypass rationale stands).

## S24.4 `getActiveLeaderboards` N+1s (`LeaderboardService.ts:384+`)

1. Add `t.cadence, t.game_room_id` to the main SELECT (`:397`, join already present at `:410`)
   and delete the per-tournament lookup loop at `:508-527`.
2. Hoist/batch the per-iteration TIMEZONE lookup (`:517-520`) — one query for the distinct rooms.
3. Fold the per-tournament COMPLETED-games queries (`:441-458` retain, `:461-477` scheduled)
   into one window-function query across tournament ids.
4. Keep the batched cache read (`:495-504`) as is; the `:532` per-miss serial recalculate
   becomes rare once S24.1 lands — leave it, but route it through S24.3's dedup.

## S24.5 StatsService window functions + doctrine fix

- Replace the correlated finish-position subqueries with `RANK()/COUNT() OVER (PARTITION BY
  game_id)` — BOTH copies (`:375-386` and `:505-516`), and keep the JS reduce shape identical.
- Bound the champion-streak scans (`:394-408`, `:524-538`) — LIMIT the game set scanned.
- **Doctrine fix: `getPersonalBests` (`:629-667`) reads `submissions` — move it to
  `score_history`** (best-per-player derivation, matching the tombstone/orphan semantics of the
  per-row delete machinery). Note the sibling `getParticipationStreak` already reads
  `score_history` (`:672-675`) — after this fix the payload is internally consistent. This
  unblocks the ROADMAP "searchable Personal Bests" feature (line 11), which then needs no BE
  doctrine work — leave the feature itself OUT of S24.
- Also narrow the full-room ranking in `getPersonalBests` (it ranks every player then filters to
  one at `:664`) — push the player filter into the window query where possible.
- Optional 60s TTL on the all-players endpoints if time allows; skip silently if not.

## S24.6 `/room-scores` remaining N+1 (`RoomScoresService.ts:134-136`)

One `getGameRankings` query per card (parallel). Replace with a single windowed query:
`ROW_NUMBER() OVER (PARTITION BY game_name ORDER BY score DESC ...) <= 10` over
`game_name IN (...)` for the page's games. Chrome batching (`:249-286`) is already done — don't
touch it.

## S24.7 TTL cache on `GET /api/global/scoreboard` (`global.ts:1373-1493`)

No caching exists on the list route (confirmed). Add a 30–60s in-memory TTL cache:
- Key: the full query tuple (sort, scope, limit, offset, search, type, platforms, hasScores,
  category, groupBy).
- SKIP the cache when `search` is present and when the view is viewer-varying: `sort=pinned` or
  any viewer-pin enrichment (`pinnedUserId`) — cache the shared payload only, or split the pin
  overlay out; do NOT cache per-user variants.
- `getHeroGame` (`:1411-1413`) joins the same cache entry (offset-0 only).
- Invalidation: TTL-only is acceptable (30–60s staleness on a global aggregate); note the
  existing `score:new:global` optimistic bump already papers over the interval client-side.

## S24 gates
Same build/test/CRLF/no-push gates as S23. Tests named in each item, plus: cache-correctness
suite around the read-time join (rename/avatar/merge visibility), poller churn regression,
concurrency test for the dedup maps (two awaits, one recalculate). `review-code-quality` gate.
Any migration here claims the next free number at implementation time — S23 may have consumed
134+.

---

# Sequencing & interactions

- S23 and S24 are independent of each other and of the discord-hq branch (no file overlap with
  discord-hq's auth.ts connect flow / NotificationService / AccountSettings work; S23 touches
  submitscore.ts + rooms.ts + GameLibrary/GameDetail; S24 touches services + poller).
- Within S24: S24.1 first (structural), then 24.2–24.7 in any order.
- ROADMAP lines closed on completion: line 22 (Google avatars — by S24.1), the
  `getPersonalBests` doctrine note inside line 11 (by S24.5; the searchable-list FEATURE stays
  open), and the three S22 residual bullets in the "Content moderation" / plan sections.
- The old plan's S23/S24 sections + migration ledger should be marked superseded (pointer to
  this file) on the next docs sweep — do not edit the old plan as part of implementation.
