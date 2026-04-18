# ArcAid v2.0.0 — Scores/Nav Reorg

**Released:** 2026-04-18
**Commit:** `595d9b0f`
**Plan:** `tmp/scores-nav-reorg-plan-v1.md` (12 sprints + polish pass)
**Verification:** `tmp/manual-test-playbook-v2.0.0.md`

**Scope at a glance:** the biggest structural change since the multi-room architecture. 13 sprints of work, 18 migrations (044-061), ~90 files touched, 7 new services, 4 new tables, 3 legacy submit modals retired, 1 unified submission sheet, 6 themed SVG icons replacing emoji.

## Why (plan motivation)

The pre-v2 app had accumulated UX debt: four competing submit surfaces, a "Games" tab that meant three different things in three places, anonymous submissions that couldn't be reconciled with Discord users, a winner-picks flow that wasn't always appropriate for every room, and a Global Scoreboard that couldn't tell you where a score came from. v2 flattens, unifies, and gates. See plan §1-§19 for the full rationale.

---

## New features

### Anonymous submission runtime
Anonymous submitters typing a name that matches a Discord member get a **claim prompt** ("Is this you?") offering to log in and attribute the score, or continue as guest. OAuth round-trip preserves the draft via server-side storage (5-min TTL) + sessionStorage. Cancel-mid-OAuth surfaces a "Submit as guest?" modal instead of losing the score.

### Merge/unmerge admin flow
New `/:slug/admin/identity` page lets admins attribute anonymous scores to Discord users, with **freeze-rule protection**: completed tournaments can't have their attribution retroactively changed. Every merge gets a snapshot + audit record; reversal is always available with no time limit. Self-claim merges fire automatically on the OAuth-return path.

### ENABLE_GAME_PICK_AWARD gate
Room-level opt-in toggle that disables the entire winner-picks / Mystery Award flow when off — hiding the nav tab, short-circuiting Discord commands (`/pick-game`, `/nominate-picker`, `/pause-pick`, `/mystery-award`), suppressing `turn-to-pick` DMs, and preventing picker slot creation. Default **off** (opt-in per plan §17).

### Global Scoreboard room badges
Every row on `/scoreboard` and `/games/:id` now shows the origin room's badge (logo or short tag). Clicking a badge filters the scoreboard to that room via `?room=<slug>` — shareable URL. Per-room `short_tag` column lets admins set a custom 6-char abbreviation (e.g. "RTX") that overrides the slug-derived default.

### REQUIRE_DISCORD_LOGIN orphan-on-flip
Flipping "Require login for score submissions" ON doesn't delete existing anonymous scores; it stamps them `orphaned_at=NOW()` so they disappear from every public leaderboard surface. Flipping OFF restores them. Atomic across the 4 score tables.

### Unified submission sheet
Four legacy submit modals (`ScoreSubmitModal`, `FreeplaySubmitModal`, `GlobalScoreSubmitModal`, `ScoreSubmit.tsx` page) retired behind a single `SubmissionSheet` component with a discriminated `{ kind: 'tournament' | 'freeplay' | 'global' }` target union. Phase state machine handles anonymous-collision → OAuth → commit.

### Cooldown messaging (plan §13)
Locked tournament games no longer block the submit form. Instead a banner warns "This score won't count toward the active tournament (cooldown). It still posts to the room leaderboard." Submission always succeeds; the tournament card stays tournament-scoped.

---

## UI restructure

- **Scoreboard:** `Tournaments | All Games` tabs replace the legacy `Tournament / Games / Browse Catalogue` muddle. New **"Played at <RoomTag>"** filter toggle on All Games narrows to room-played games. URL state via `?tab=all-games` + `?played-here=1`.
- **Picks page:** `/:slug/games` renamed to `/:slug/picks`. Old route 301-redirects preserving `?t=` query for stale Discord DMs. Mystery Award moved from Scoreboard to a persistent hero card at the top of Picks.
- **Nav:** final layout `Lobby | Scores | Picks* | Stats | Global` — Picks conditional on `ENABLE_GAME_PICK_AWARD`. Admin link moved into UserMenu dropdown.
- **UserMenu:** real dropdown (was a flat icon row). Full WAI-ARIA keyboard navigation — ArrowUp/Down/Home/End, Escape, Tab-to-exit.
- **My Rooms:** new page at `/my-rooms` showing rooms the Discord user belongs to, with source badge (Submitted / Admin invite / Claimed / Existing history) and relative last-activity.
- **Stats merge:** public `/:slug/players` consolidated into `/:slug/stats` with internal `?view=players|games` tabs. Admin `Stats.tsx` untouched.
- **Identity admin:** new `/:slug/admin/identity` page with Pending Claims + Audit Chain sections.
- **GameCard:** shared wrapper component implementing the plan §10 contract (context-aware, always-visible submit, slot-based extensions). Used across Tournament, All Games, Global, Picks surfaces.

---

## Schema changes (migrations 044-061)

| Migration | Adds |
|-----------|------|
| 044-047 | `submitted_from_room_id` + `submitted_during_tournament_id` + `submitted_by_user_id` + `submitted_by_anonymous_name` + `merged_from_anonymous_identity_id` on submissions/community_scores/score_history/global_scores |
| 048 | `anonymous_identities` table |
| 049 | `merge_records` table |
| 050-053 | (re-index adjustments + backfill preparations) |
| 054 | `orphaned_at` column on all 4 score tables |
| 055 | `room_members` table + backfill from submissions/community_scores/game_room_admins |
| 056 | `submission_drafts` table (5-min TTL for OAuth handoff) |
| 057 | Cache bust: `global_leaderboard_cache` shape change (origin_room_slug/logo) |
| 058 | Cache bust: `leaderboard_cache` after tournament-scoping change |
| 059 | Partial UNIQUE indexes on `anonymous_identities` (guild+nick, room+nick) |
| 060 | `short_tag` column on game_rooms |
| 061 | Cache bust: `global_leaderboard_cache` shape change (origin_room_short_tag) |

All migrations are idempotent and run in order on startup.

---

## New services

| Service | Role |
|---------|------|
| `SubmissionContextService` | Captures 5 context fields on every score write; invariant guard blocks mutation outside merge flows |
| `DiscordNicknameResolver` | Extracted from IdentityManager; 30s-memoized guild-member search; error-cache-aware |
| `AnonymousIdentityService` | Upsert of `anonymous_identities` rows; atomic with DB-level UNIQUE |
| `PickAwardGate` | 5s TTL cache for `ENABLE_GAME_PICK_AWARD` resolution; AND semantics per Q5 |
| `OrphanService` | Transactional orphan-on-flip + restore across 4 score tables |
| `RoomMembershipService` | `room_members` CRUD + `listRoomsForUser` with max-activity ordering |
| `SubmissionDraftService` | Server-side draft storage for OAuth handoff with photo persistence |
| `MergeService` | preview/record/previewReversal/reverseMerge/listHistory/getMergeRecord with freeze rule |

---

## Sprint 13 polish

Review-driven follow-ups, all landed in this release:

- **44×44 invisible tap-target expansion** on GameCard + Scoreboard submit buttons (outer transparent button wrapping inner visual span)
- **DiscordNicknameResolver error cache marker** — transient 5xx no longer cached for 30s
- **anonymous_identities UNIQUE + atomic upsert** + 5 concurrency tests
- **PickAwardGate invalidation** hooked into GameRoomSettingsService + TournamentService write paths
- **OrphanService transactional wrapper**
- **UserMenu arrow-key nav + roving tabindex**
- **OAuth-cancel modal** ("Submit as guest?" on access_denied)
- **Identity admin mobile responsive**
- **Per-room short_tag column** + admin UI field
- **Final emoji sweep** (★ / ⌫ / 🏆 → lucide SVGs + themed paths)

---

## Breaking changes

- **Routes:** `/:slug/games` → `/:slug/picks` (301 redirect in place)
- **Components deleted:** `ScoreSubmitModal.tsx`, `FreeplaySubmitModal.tsx`, `GlobalScoreSubmitModal.tsx`, `CatalogueBrowse.tsx`, `Players.tsx`, `GameAvailability.tsx` (renamed → Picks.tsx)
- **Default behavior change (silent):** Existing rooms with `winner_picks=1` tournaments see the Picks tab disappear until an admin enables `ENABLE_GAME_PICK_AWARD`. **Mitigation:** flip the setting in Settings UI per room. Documented as a known migration gap.

---

## Correctness fixes (caught during review gates)

- `RoomMembershipService.listRoomsForUser` — `COALESCE` returned first-non-null; replaced with `MAX(ts) FROM (UNION ALL)` for true latest-activity.
- `/submission-drafts/:stateParam/commit` — photo mimeType was hardcoded `'image/jpeg'`; now derives from stored extension.

---

## Known limitations / deferred

- `CommunityScoreService.submitScore` writes `submitted_during_tournament_id=NULL` — tournament context isn't threaded through. Doesn't affect §13 tournament-filter since `LeaderboardService` uses `submissions.game_id` directly.
- Stats / Dashboard / Milestone / LobbyFeed queries don't filter `orphaned_at` (plan §6 explicit scope deferral).
- Discord Bot Multi-Room (Phase 5) — deferred, not part of this release.

---

## Test coverage

- **67/67 tests pass** (added 5 `AnonymousIdentityService` concurrency tests for the UNIQUE partial index)
- Manual verification playbook: `tmp/manual-test-playbook-v2.0.0.md`
- Full infrastructure playbook: `tmp/scores-nav-reorg-verification-playbook.md`

---

## Upgrade notes for operators

1. Bring up the new image — migrations run on startup, idempotent, no downtime action needed.
2. Decide per-room whether to flip `ENABLE_GAME_PICK_AWARD=true` — rooms that relied on the winner-picks flow need this to restore pre-v2 behavior (see known migration gap above).
3. Consider setting `short_tag` on each public room via Super-Admin UI for cleaner Global Scoreboard badges.
4. No secret / env-var additions required.

---

## Rollback

Previous tag: `f7c95083`. Migrations 044-061 are non-destructive; reverting the image does not require reverting the schema. See `tmp/scores-nav-reorg-verification-playbook.md` §13 for operator SQL if any `orphaned_at` stamps need manual clearing post-rollback.
