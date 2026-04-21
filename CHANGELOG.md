# Changelog

Each release has a dedicated notes file in `releases/`. This index is a scannable summary; the per-version files have the full breakdown.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

---

## [2.2.8] — 2026-04-21

**Patch.** Structural fix for the scoreboard click-routing problem + Mystery Award visibility.

Instead of stacking a z-10 Link overlay across the whole card and juggling `pointer-events` on every interactive child — which kept losing to one layout or another — removed the overlay entirely. Each card variant (BannerCard / MinimalCard / ShowcaseCard) now wraps *its own title* in a `<Link>` to the Room Game Detail. Score rows, `+` expand icons, and the submit button all have natural clickability with no competing overlay.

- **Scoreboard card click routing.** Title click → Room Game Detail. `+` / score row click → inline expand (when the player has multi-score). Submit button → submit sheet. No more "click `+` navigates away."
- **Removed title-click-submits-score behavior.** Previously clicking the title area opened the submit sheet when `onSubmitScore` was set. This was redundant with the explicit `+` button and conflicted with making title a Link. The `+` button is the single submit affordance now.
- **Mystery Award header overlay `z-[60]` + `fixed` positioning.** `MysteryAward` renders as `fixed inset-0 z-50`; the header overlay was at `z-10` inside a `relative` wrapper, so it sat underneath the modal entirely — including the Pool dropdown. Now `fixed` + `z-[60]` so it renders above the modal.

Full details → [releases/v2.2.8/README.md](releases/v2.2.8/README.md)

---

## [2.2.7] — 2026-04-21

**Patch.** Two v2.2.6 follow-ups + a playbook clarification.

- **Shared `DiscordLoginButton` component** so GlobalScoreboard, GlobalGameDetail (and any future global-surface pages) render the same Discord-brand blue button with the Discord SVG logo that PublicLayout uses on room pages. Previously globals used lucide's generic `LogIn` icon on a neon-cyan button, which broke visual parity after the v2.2.6 "Login" text normalization.
- **ShowcasePodium pointer-events reinforcement.** Outer wrapper of each podium slot now also sets `pointerEvents: 'auto'` when `canExpand`, so clicks on the slot's padding / surrounding flex area (not just the tinted inner box) still trigger the inline expand. The inner's `pointerEvents: 'auto'` was already there in v2.2.6 but didn't cover edge clicks.
- **Playbook clarified.** The `+` expand indicator only renders on rows where the player has >1 submission on that game. Rows for single-submission players never show `+` — that's the intended design, not a missing feature.

Full details → [releases/v2.2.7/README.md](releases/v2.2.7/README.md)

---

## [2.2.6] — 2026-04-21

**Patch.** Five UX follow-ups from v2.2.5 playbook feedback.

- **Tournament card / All Games card links now go to Room Game Detail** (`/:slug/games/:name`) instead of Global Game Detail when the game has a global mapping. Pre-v2.2.6 clicks routed to the Global page, which (correctly) hides anon submissions via the fan-out gate — so guest scores appeared to vanish on click. Global remains reachable via `/scoreboard` tiles.
- **UserMenu on Global pages.** `/scoreboard` (GlobalScoreboard) and `/games/:id` (GlobalGameDetail) used their own inline login/logout UI; now they use the shared `UserMenu` component — My Rooms / Friends / Scoreboard-display / Log out are reachable from global pages too.
- **Login text normalized** to "Login" on all public-facing pages. Admin login pages keep their existing labels.
- **Room Game Detail leaderboard: username clicks go to player stats.** `/:slug/players/:name` instead of doing nothing. Row-click still expands the multi-score history (v2.1.0). `stopPropagation` keeps the two gestures separate.
- **Scoreboard card score rows are clickable again.** The `+` expand icon on scorecards was being intercepted by the z-10 Link overlay, so clicks navigated to Game Detail instead of expanding inline. Fix: wrap `CardRouter` in `relative z-20 pointer-events-none` and mark expandable score rows `pointer-events-auto` — interactive rows now capture their own clicks; non-interactive areas still pass through to Link → navigate.
- **Mystery Award tournament selector.** When a room has >1 active tournament, a Pool dropdown appears in the header overlay so users can pick which tournament's pool drives the spin. Defaults to first active tournament (prior behavior preserved for single-tournament rooms).

Full details → [releases/v2.2.6/README.md](releases/v2.2.6/README.md)

---

## [2.2.5] — 2026-04-20

**Patch.** Two correctness fixes + one UX lift from v2.2.3 manual testing.

- **`conditionalRequireDiscordUser` now decodes optional tokens.** Pre-v2.2.5, when a room had `REQUIRE_DISCORD_LOGIN=false`, the middleware called `return next()` without looking at the Authorization header — so a logged-in user's submission silently fell through as `COMMUNITY` (anon). Effect: their score didn't fan out to Global, their avatar join failed, and they appeared with a `?` silhouette on the Tournament card. Middleware now always attempts to decode a Bearer token when present; it only *requires* one when the room opts in.
- **Pre-submit name collision prompt.** `POST /:roomId/submit/name-check` returns `{ available, suggestion }` using `RoomNameClaimService.checkAvailability` (dry-run of the claim logic, no persistence). SubmissionSheet now runs this before POSTing for anon submissions — if the name is taken, it shows an editable "Name already in use" panel pre-filled with the server's next-free suggestion. User can accept, edit to something else (check re-runs), or cancel. Replaces the post-hoc "Submitted as Chad_2" disclosure message.
- **Resolved-name prefill.** `arcaid-player-name` localStorage now stores the *resolved* display name after a successful submit (e.g. `Chad_2` if the server suffixed), not the raw typed name. Next session prefills with the sticky identity.

Full details → [releases/v2.2.5/README.md](releases/v2.2.5/README.md)

---

## [2.2.4] — 2026-04-20

**Patch.** Post-login redirect lands on the Lobby, not Picks.

When a user logs in with Discord from a game room's public pages (landing → Scoreboard → Login), they were being dropped on `/:slug/picks` — the winner-pick surface. New default is `/:slug/lobby` (social hub), which is what users expect after a fresh login. Global pages (`/scoreboard`, `/friends`, `/my-rooms`) and in-flight flows (pending-submission OAuth handoff) still pass their own explicit `returnPath`, so those are unaffected.

Changed: `ViewerAuthContext.loginWithDiscord` default path and `DiscordCallback`'s `player:<slug>` fallback.

---

## [2.2.3] — 2026-04-19

**Patch.** Fix first-claim-wins over-sticking: typing a different name from the same browser was silently collapsed back to the browser's first claim, so "Bob_2" and "Bob_3" submitted from the "Bob"-claimed browser were stored as "Bob" and merged into Bob's leaderboard row.

`RoomNameClaimService.resolveAndClaim` dropped the token→name idempotent short-circuit. The suffix loop now checks whether the requested name is free OR already owned by the submitting claimant — either is fine, otherwise suffix. Symmetric for Discord users (they can rotate their per-room display name too).

Migration 066 rebuilds `anon_room_claims` with PK `(anon_token, room_id, display_name)` so one token can hold multiple name claims in the same room. Unique name-per-room index preserved.

Full details → [releases/v2.2.3/README.md](releases/v2.2.3/README.md)

---

## [2.2.2] — 2026-04-19

**Patch.** Closes the "freeplay scores never reach iScored" gap.

Before v2.2.2 only the Tournament-card / Game-Detail submit path (`POST /:roomId/submit-score/:gameName`) fired the fire-and-forget iScored sync. Scores submitted via `/freeplay-score` or the legacy `/community-scores/:gameName` endpoint stayed local-only — so players who used the Freeplay page never appeared on iScored even when the game matched an active tournament.

Extracted the sync into a shared `IScoredSubmitSync.syncScoreToIScored` helper and wired it into all three web submission paths. Same guards (game must be ACTIVE with an `iscored_id`), same API-preferred / Playwright-fallback logic, same error handling. All three paths now pass the resolved `displayName` (post-v2.2.0 auto-suffix), so the name on iScored matches the name on ArcAid's scoreboard.

Full details → [releases/v2.2.2/README.md](releases/v2.2.2/README.md)

---

## [2.2.1] — 2026-04-19

**Patch.** Three follow-ups from v2.2.0 manual testing.

- **Winner resolution reads local DB first.** `TournamentEngine.processSlotMaintenance` now picks the winner from `submissions` (which has everything — Discord, guest, iScored-synced) and only falls back to iScored when local is empty. Previously the reverse — the bot would announce whoever iScored had on top, even when ArcAid's own scoreboard knew better. Broke badly for guest-allowed rooms where iScored rejected a submission (the "Access Denied" case below).
- **iScored API `submitScore` handles non-JSON rejections.** iScored responds `200 OK` with a plain-text body like `"Access Denied"` when it rejects a submission (seen on a guest's 99.9B score). The client now parses response text before JSON and surfaces a clean error instead of a raw `SyntaxError` that crashed the surrounding sync pipeline.
- **Anon-winner Discord message** now includes claim guidance: *"Is this you? Log in with Discord on {scoreboard} to claim future scores. If your Discord name differs from `{name}`, ask an admin to merge identities. An admin will pick the next game in the meantime."* No more broken `@mentions`; no more picker-slot created for a winner that can't use `/pick-game`.
- **GameDetail leaderboard React key fix** (shipped as `a368aaeb` on 2026-04-19) — anon rows were being de-duped by the reconciler because they share `discord_user_id="SYSTEM"`; composite `rank-username` key restores them.
- **Data cleanup (prod):** removed 61 legacy anon rows from `global_scores` that fanned out before the v2.2.0 gate landed, and flushed `global_leaderboard_cache` (7 entries). Global Game Detail now resolves to the Discord-authenticated row for affected usernames.

Full details → [releases/v2.2.1/README.md](releases/v2.2.1/README.md)

---

## [2.2.0] — 2026-04-19

**Minor.** Identity-correctness release. Closes the "guest score absorbs a logged-in user's leaderboard row" gap.

- **Global fan-out gate** — guest submissions never reach the Global Leaderboard. Every row on global is guaranteed to have a real Discord ID behind it. Implemented as a one-line early-return in `GlobalScoreService.fanOutFromRoomSubmission` keyed on `normalizeSubmitterUserId`.
- **First-claim-wins identity** — new `RoomNameClaimService` resolves a per-room display name at submission time. The first identity (Discord or anon) to use a name in a room owns it; later arrivals auto-suffix to `Bob_2`, `Bob_3`. Backed by a new `room_members.display_name` column and a new `anon_room_claims` table. SubmissionSheet shows "Submitted as Bob_2 — 'Bob' is already in use" when a suffix was applied.
- **`REQUIRE_DISCORD_LOGIN=true` default for new rooms** — safe-by-default identity. Existing rooms unaffected (flipping retroactively orphans anon scores).
- **SubmissionSheet polish** — always sends a stable anon-token; replaces the global-exclude checkbox with a guest-mode nudge ("Log in with Discord to also include it on the global ArcAid leaderboard").
- **UserMenu z-index fix** — dropdown bumped to `z-50` so it wins over game-card submit buttons.

Migrations 064 (DDL for first-claim-wins) and 065 (no-op marker for the default-flip event).

Full details → [releases/v2.2.0/README.md](releases/v2.2.0/README.md)

---

## [2.1.0] — 2026-04-18

**Minor.** Three net-new capabilities.

- **Tournament scoring reads `score_history`** filtered by `submitted_during_tournament_id` — best-during-the-window wins, no longer tied to all-time personal best. `submissions` writes preserved for back-compat. Migration 063 backfills existing rows.
- **Multi-score view** on Game Detail: click a username → inline expand with sparkline of progression, split into "This tournament" vs "All time" when an active tournament is in play. Photo-proof links per row.
- **Stats page Combo redesign** — 4-card overview at the top (plays this week / active players / hottest game / latest submission) on top of the existing Players / Games tabs. New `GET /:roomId/stats/overview` endpoint.

Full details → [releases/v2.1.0/README.md](releases/v2.1.0/README.md)

---

## [2.0.3] — 2026-04-18

**Patch.** Three smoke-test follow-ups.

- Default catalogue image restored on Tournament + All Games cards (backend COALESCE to `global_games` + ShowcaseCard fallback; admin style still wins)
- Submit button icon unified — `Plus` on both Tournament and All Games cards
- `/freeplay-score` now upserts `submissions` when the game is an active tournament game, so scores submitted via game detail count for the tournament just like Tournament-card submits

Full details → [releases/v2.0.3/README.md](releases/v2.0.3/README.md)

---

## [2.0.2] — 2026-04-18

**Hotfix.** Tournament card title routed to room-scoped URL instead of global catalogue.
`LeaderboardService.getActiveLeaderboards()` now selects `COALESCE(g.global_game_id, gl.global_game_id)`
so the frontend's `linkForTournamentCard` resolves to `/games/:id?from=:slug` when the game is mapped.

Full details → [releases/v2.0.2/README.md](releases/v2.0.2/README.md)

---

## [2.0.1] — 2026-04-18

**Patch release.** Seven fixes from v2.0.0 manual testing.

- Avatar leak on anonymous submissions (privacy regression — `LeaderboardService` + 3 siblings narrowed the username-fallback to `iscored:*` only)
- OAuth-cancel detection when user closes the Discord tab without a redirect
- Room-scoped GameDetail Community tab migrated to `SubmissionSheet` (photo upload + anon claim + error messaging)
- `SubmissionSheet` gained a `requireLogin` prop → login-required state up-front on gated rooms
- Global GameDetail Submit respects `?from=<slug>` room context → freeplay target when present
- Internal `Catalogue` / `Community` labels no longer leak onto cards
- Mystery Award direct URL: `/:slug/mystery-award` as a shareable Discord link + login hint

Migration 062: cache flush for the avatar-fix SQL changes.

Full details → [releases/v2.0.1/README.md](releases/v2.0.1/README.md)

---

## [2.0.0] — 2026-04-18

**Major release.** Scores/Nav Reorg — 12-sprint plan + Sprint 13 polish pass.

Highlights:
- Anonymous submission runtime with Discord-collision claim prompt + OAuth draft handoff
- Merge/unmerge admin flow at `/:slug/admin/identity` with freeze-rule protection
- `ENABLE_GAME_PICK_AWARD` opt-in gate hides the pick flow where not wanted
- Global Scoreboard room badges with `?room=<slug>` filter URLs
- Unified `SubmissionSheet` replaces 4 legacy submit modals
- Scoreboard tabs: `Tournaments | All Games` + "Played at" filter
- `/:slug/games` renamed to `/:slug/picks` with 301 redirect
- New nav UserMenu dropdown with full WAI-ARIA keyboard support
- Per-room `short_tag` column for custom badge abbreviations

Breaking: route rename + 4 components deleted + existing rooms must opt into `ENABLE_GAME_PICK_AWARD` to keep the Picks tab visible.

Full details → [releases/v2.0.0/README.md](releases/v2.0.0/README.md)

Commit: `595d9b0f`

---

## [1.x] — pre-2026-04-18

No per-version release notes exist for the 1.x line. Historical context is tracked in `SPRINT_STATUS.md` (current session notes) and `ROADMAP.md` (completed work). Starting with v2.0.0, every release gets a dedicated notes file.
