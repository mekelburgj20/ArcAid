# Changelog

This file is the single source of truth for ArcAid release history. The legacy `releases/v*/README.md` per-version-directory convention was retired as of v2.3.0 — see [`releases/README.md`](releases/README.md) for context.

Format follows [Keep a Changelog](https://keepachangelog.com/). Versioning follows [SemVer](https://semver.org/).

---

## [2.100.4] — unreleased

**Hotfix: iPhone photo uploads truncating mid-stream ("Unexpected end of form").**

### Fixed
- **The real cause of the mobile photo-submit failures, caught by v2.100.2's new logging** (prod: 4× `Upload rejected ... Unexpected end of form {"mimetype":"unknown","size":"0"}` from two different iPhones): iOS Safari hands the page a lazy reference to a camera-roll photo and reads it from disk only while the upload streams — the read can end early, truncating the multipart body before the photo bytes arrive. Fix: `photoNormalize` now **materializes every selected photo into memory at pick time** (fresh in-memory `File` over the bytes; the canvas-converted path was already in-memory), so the upload streams from RAM with nothing left to truncate. Materialization failure falls back to the original file.
- The raw busboy parser message ("Unexpected end of form") reached players verbatim; the upload wrapper now translates it to "The photo upload was interrupted before it finished — please try again." (raw message still logged).

## [2.100.3] — unreleased

**Hardening: name-keyed submit resolution prefers the ACTIVE game (rerun-safety, owner verification request).**

### Fixed
- **The three name-keyed submit handlers' `submissions` upsert now resolves games with an explicit ACTIVE-first, newest-COMPLETED-fallback ORDER BY** (`/submit-score`, `/freeplay-score`, and the OAuth draft-commit). Games rerun after cooldown by design, so one name can match an ACTIVE row plus older COMPLETED rows; the previous `LIMIT 1` with no ORDER BY left the choice to the query planner (undefined by SQLite's contract — the WHO-dunnit incident's bug class). A wrong pick would be invisible on every leaderboard (tournament cards read `score_history`, whose tournament auto-resolve is strictly ACTIVE-only and was verified solid) but would land the score on a long-finished game's `submissions` row — **which winner resolution reads at rotation**. Verified on prod that the owner's field-test submission landed correctly; this makes the correctness explicit instead of plan-accidental. Regression test pins the contract.

## [2.100.2] — unreleased

**Two owner field reports: mobile photo submissions failing silently + a misplaced cooldown caption.**

### Fixed
- **iPhone camera photos no longer kill score submissions.** A mobile submission with an attached photo failed with a bare "Submission failed" and zero server logs: the iPhone camera's default HEIC format isn't in the upload allowlist, and multer's rejection bypassed the route handler into Express's default handler — an unlogged plain-text 500 the FE couldn't parse. Two layers: (1) unsupported photo formats are now re-encoded to JPEG **on-device** before upload (`photoNormalize.ts` — Safari decodes HEIC natively, so iPhone photos just work; undecodable formats get an inline error at photo-pick time); (2) new `withUploadErrors` wrapper on **all 8** multer routes (submit-score, freeplay, global scores, submission-drafts, style/background/logo/style-catalogue uploads) turns fileFilter and size-limit rejections into logged JSON 400s with actionable messages ("That image is too large — the limit is 30MB.", format errors by name). Every rejection now logs route + mimetype + size — silent-failure mode closed.
- **The "won't count toward the active tournament (cooldown)" caption no longer shows on Room Scores submissions.** Games that rotated out of past tournaments carry COMPLETED status, tripping a caption written for the Tournaments tab; on Room Scores every submission is a room-leaderboard post by definition, so it was pure noise. That tab stops threading `gameStatus` into the sheet (its only consumer was the caption); Tournaments tab and GameDetail keep the warning.

## [2.100.1] — unreleased

**Wide desktop layouts for Picks, Stats, and Players (owner request; shots approved).**

### Changed
- **Picks and Stats pages now use the Scores page's full-width treatment** (gutter padding, no width cap — was a ~896px centered column with huge dead margins on wide monitors). The Picks game table's title column absorbs the growth; stat tiles, search, and filter rows span the width. The Mystery Award banner and "If I win next…" control deliberately keep a centered cap — full-width stranded the Spin button ~1200px from its label.
- **Players page widened** ~672px → ~1024px (deliberately not full-bleed; a bare name list doesn't benefit).

## [2.100.0] — unreleased

**Linked-identity role sync — one identity, either login (owner field report).**

### Fixed
- **A linked Google login now gets the same admin affordances as the Discord login.** Field report: a room admin logging in via their linked Google account saw no "Room admin" menu entry. Three causes, all fixed: (1) the FE's linked-login completion branch stored the player token but never seeded the admin-token slot at all (the plain-login branch did); (2) that seeding was guarded by a one-shot "slot is empty" check, so a stale expired token from any previous session silently blocked it forever — now re-seeds whenever the slot is empty or expired, never overwriting a live admin token; (3) the "Room admin" affordance itself was slot-presence-only — it now also derives from the current player token's decoded claims, and self-heals the slot when the player token is admin-grade.
- **Admin grants now follow the whole identity link, both directions.** `AdminService.getRoomsForDiscordUser` expands the login id across the Google↔Discord link graph (new `IdentityLinkService.expandCandidates`, extracted from `BanService.expandIdentityCandidates` which now delegates — behavior unchanged) before querying `game_room_admins`, so a grant recorded against either side of a link is honored at token issuance, refresh, and `viewer_status`. Previously only the forward canonical resolution ran — a grant added against the `google:*` alias after linking was invisible to both logins.
- **Membership and pending-join checks are link-aware too**: `RoomAccessService.canViewRoom`/`getViewerStatus` check the full candidate set (new `isMemberAny`/`getPendingStatusAny` IN-variants), so approval-room access resolves correctly whichever linked identity the token carries. Known deliberate non-goal: the dual-slot refresh-token rotation wart is documented, unchanged.

## [2.99.2] — unreleased

**Flake-family root fix: the v2.24.1 tracker's oldest escape + a single-flight init guard.**

### Fixed
- **`syncScoreToIScored` was unawaited, uncaught, and unregistered at all three web submit handlers** (`/submit-score`, `/freeplay-score`, `/community-scores`) since v2.2.2 — it pre-dates the v2.24.1 `trackBackground` registry, whose sweep matched `.catch(() => {})` and `void Service.x()` patterns but not a bare unawaited call. In tests, the escaped chain's late `getDatabase()` (two dynamic-import hops after the 201 response) could land during the next test's DB reset — the root of the twice-seen `room-visibility-gate` / `community-scores-attribution` "cannot start a transaction within a transaction" flake family. All three sites now register with `trackBackground` so the vitest drain waits for them. (Prod impact: none observable — the chain completes normally there; the fix also removes a genuinely unhandled promise rejection path.)
- **`initDatabase()` gained a single-flight guard** (and `getDatabase()` checks the in-flight init first): `db` is assigned mid-init — after `open()`, before the schema/migration sequence — so overlapping calls could previously start a second full migration run or be handed a half-migrated handle. Any future untracked chain now settles on the one shared init instead of detonating it. Concurrency regression test added (`database-single-flight.test.ts`).

## [2.99.1] — unreleased

**Fix: approval-room Players page rendered empty for members.**

### Fixed
- **`RoomMembers.tsx` fetched the roster with no Authorization header**, but `GET /:roomId/members` sits behind `roomVisibilityGate`, which decodes the Bearer token itself and 403s tokenless requests on 'approval'-policy rooms — so even an approved member saw a silently empty Players list (`r.ok ? json : []` swallowed the 403). The page's own doc comment believed the reachability gate (PublicLayout's RoomJoinGate) covered auth; it only controls who sees the page, not what the fetch may read. Fix mirrors v2.98.0's Picks pattern: attach the player Bearer when one exists. Found during the v2.98.0 review; both directions (token attached when signed in, absent when logged out) are now test-pinned.

## [2.99.0] — unreleased

**Nominee typeahead — Discord-style live suggestions (owner request, same-day field iteration on v2.98.x).**

### Added
- **Live guild-member suggestions in the nominee field**: typing 2+ characters (with or without a leading `@`) in "Give my pick to…" shows matching members of the room's linked Discord guild — name + avatar, prefix-matched by Discord's own member-search API (the same matching Discord's @ typeahead uses), so guild members who've never joined the room appear too. Click a row to save the nomination immediately; the confirmation line renders their name. Debounced ~300ms; results ride the existing 30s guild-search memo cache (`DiscordNicknameResolver`), so typing bursts don't multiply Discord REST traffic. The signed-in viewer is excluded; stale responses are abort-guarded and results render only while the query that produced them is still current. Paste-an-ID and exact-name Save (server-resolved, v2.98.1) are unchanged.
- New self-service endpoint `GET /:roomId/guild-members/search?q=` (`requireDiscordUser` + ban check, behind `roomVisibilityGate`): <2 chars, no linked guild, or any failure all degrade to an empty list — a typeahead never 500s. New `searchGuildMembers` export on `DiscordNicknameResolver` (thin wrapper over the memoized prefix search; exact-match resolution untouched).

## [2.98.1] — unreleased

**Hotfix: typed-username nominees (owner field report, same-day).**

### Fixed
- **"Give my pick to…" now accepts a typed Discord username** (`@chuckribbits` or `chuckribbits`). The v2.96.0 free-text field promised "@mention" but only accepted a raw numeric ID or a literal `<@id>` string — typing a username was rejected client-side. Non-numeric input is now sent to the server, which resolves it against the room's linked guild via `resolveDiscordMember` (new sibling of `resolveDiscordUserId` that also returns the display name; the four existing resolver call sites are behavior-unchanged). Resolution is a hard gate — an unresolvable name 400s with a spelled-out message (an unresolved name stored as-is would DM/mention nobody at rotation) — and a successful hit doubles as the guild-membership proof. The PUT response carries `nomineeDisplayName` so the confirmation line renders the person's name (session-local) even when they're not a room member yet. Player route only; the admin on-behalf route and Discord `/my-pick` (which gets real user options from Discord's own picker) are untouched.

## [2.98.0] — unreleased

**Picks polish batch: nominee member picker + the deferred test harnesses (v2.96.0/v2.95.1 follow-ups).**

### Added
- **Nominee member picker on the Picks page** — the "Give my pick to…" branch of the "If I win next…" control now offers a searchable name+avatar picker over the room roster (the common case is search-and-click, no more hand-pasting Discord IDs). `google:*` identities and the signed-in viewer are excluded (neither can be Discord-nominated); the free-text ID/@mention field stays as the explicit fallback since nominees may be any guild member, not just room members (the deliberate onboarding hook). A stored nominee now renders as name + avatar when they're in the roster, falling back to the raw `<@id>` otherwise. The roster fetch carries the player token so approval-policy rooms (whose roster endpoint sits behind `roomVisibilityGate`) get the picker too; any fetch failure degrades silently to free-text-only.
- **FE test coverage for the disposition control** (`PicksDisposition.test.tsx`, 10 tests): render/hide gating, GET prefill (roster-resolved + unresolved), forfeit/clear, picker nomination with exclusion assertions, free-text valid/invalid paths, roster-failure degrade.
- **SubmissionSheet component test harness** (`SubmissionSheet.test.tsx`, 5 tests) — the v2.95.1 gap closed: pins the excluded-remembered-device regression (a remembered device the tournament excludes must not be shown or held), allowed-device restore, single-engine/single-device auto-lock, and platforms-fetch-failure resilience.

### Changed
- **`MemberAdminPicker` gains a select mode** (`onSelect` prop): the component becomes a pure picker — no built-in admin-add POST — with optional label/empty-state copy overrides. Default (admin-add) mode is unchanged; existing tests pass unmodified, 4 new select-mode tests.

## [2.97.1] — unreleased

**Discord drift-audit fix batch — 9 findings from the systematic slash-command ↔ web audit (owner concern, pre-RTX-demo).**

### Fixed
- **`/pick-game` worked only with iScored credentials** — fatal for standalone rooms (the default since v2.81.0): a winning player couldn't pick via Discord at all. Now iScored-optional, matching `/activate-game` and the web pick path.
- **`/create-backup` and `/sync-state` had no admin gate** — any guild member could trigger a full backup or iScored reconciliation. Both now carry the Administrator permission flag.
- **Ban-cascade leaks in four read queries** (`/list-winners`, `/my-stats` ×2, `/view-stats` recent-results): raw `submissions` reads without `orphaned_at IS NULL` could resurface ban-hidden scores. All filtered now.
- **Cross-room write bypass**: the four write commands (`/submit-score`, `/pick-game`, `/activate-game`, `/force-maintenance`) validated only suspension at execute time — a user in an unrelated guild could write into Discord-disabled or private approval rooms. New shared `validateDiscordWriteTarget` guard: suspended → excluded-room list → invoking guild must match the room's linked guild (env fallback preserved, deny-by-default). Also applied to `/deactivate-game` (which had no re-check at all).
- **`/setup` retired** — it wrote to the pre-multi-room GLOBAL settings table (`DISCORD_ANNOUNCEMENT_CHANNEL_ID` leaked cross-tenant as the env fallback; `DISCORD_ADMIN_ROLE_ID` has had zero readers since Discord-native permission gating). Config subcommands now reply with a pointer to the web admin Settings; `view` reads the correct per-room values.
- Drift: `/activate-game` autocomplete gains the tournament-mode filter; `/reorder-lineup` scoped to the invoking guild's rooms (was reordering every room's lineup); `/map-user` gains the standard ban check.

## [2.97.0] — unreleased

**Ranking ticker + Stats filters (the last two RTX demo feature asks; shots approved incl. two placement revisions).**

### Added
- **"Scrolling Ticker" — fifth rankings display treatment** (`SCOREBOARD_RANKINGS_STYLE='ticker'`): an edge-to-edge marquee strip PINNED at the very top of the scoreboard (sticky under the nav, above the room header — owner placement; the rankings position setting doesn't apply), cycling every ranking group's top standings. Pauses on hover, honors `prefers-reduced-motion`, backdrop-blur over scrolling content, zero horizontal overflow, z-order clears the card stack. Clicking a group opens its full standings. Selectable as the admin default (Rankings page) and per-player override (scoreboard preferences); admin Leaderboard + kiosk inherit via `ScoreboardSurface`. Ticker height is measured separately and added to the bg-image offset.
- **Public full-standings page `/:slug/rankings/:groupId`** (`RankingsFullStandings.tsx`) — the ticker's click-through destination. No public full-standings surface existed at all (rankings were admin-only); uses the existing public rankings endpoint.
- **Stats page filters**: tournament-type chips + time-window controls (All time / This week / Last week / Last 4 weeks / specific-week picker) — "who did best in week X" is now answerable and shareable (URL-stated `?type=&range=&week=`). BE: `StatsService` window filters (half-open `[from, to)` against tournament end dates, pinned by tests; type filter drops the community-scores branch since pinned scores carry no tournament type), parsed via a shared helper on both stats routes.

## [2.96.0] — unreleased

**Next-win disposition: nominate/forfeit your pick, the Dynasty option, and the rotation-readiness nudge (RTX demo feedback, owner-designed).**

### Added
- **Tri-state "next win" disposition** per player per tournament (migration 143 `picker_dispositions`): use-my-queue (default, absence of a row) / nominate a guild member / forfeit to runner-up. One-shot — consumed at the rotation it applies to. Set via Discord `/my-pick` (nominate/forfeit/clear/status, with tournament autocomplete) or the Picks page "If I win next…" control; admins can set any player's disposition on their behalf (`/nominate-picker` extended with designate/set/clear subcommands + web admin endpoints, all audit-logged) — covers "the winner said it in chat".
- **Resolution at winner designation** (`TournamentEngine.resolveNextPicker`): nominate → nominee becomes the picker with the full standard window/reminders/timeout chain; forfeit → runner-up designated immediately (no timeout wait). **Nominee onboarding hook:** a nominee who isn't a room member yet gets a tournament-channel @mention — "you have next pick" — with a direct log-in-and-pick link (guild-wide nominees are deliberate: an onboarding surface). The normal queue path's window/reminder/timeout semantics are untouched — this routes around them.
- **"Allow Dynasty" tournament option** (`tournaments.allow_dynasty`, default ON = today's behavior; checkbox in the tournament form's Game Rotation section, shown only when winner-picks is on). When OFF: a back-to-back winner can't take the pick themselves — nominate/forfeit still honored; no disposition → pick passes to the runner-up immediately with announce copy naming the dynasty rule.
- **Rotation-readiness nudge** (`rotationReady` notification type — high-value umbrella + web-push eligible): (a) T-1h sweep before the next rotation nudges the current top 3 who lack BOTH a queued game and a disposition; (b) event-driven — a final-hour score submit that lands the submitter in 1st triggers the same check. Deduped one-per-player-per-rotation (`rotation_nudges`). Winner/runner-up attribution extracted to a shared `submissionAttribution` helper (was duplicated across /list-winners and the pivot path).

## [2.95.2] — unreleased

**RTX demo follow-ups: picker-command admin gating + Room Scores card backgrounds + lock visibility.**

### Fixed
- **`/nominate-picker` and `/pause-pick` are now admin-gated** (`setDefaultMemberPermissions(Administrator)`, the gate every other admin command already carried) — previously ANY guild member could reassign picker rights or inject a game into the lineup. Commands re-register on boot; the gate applies as soon as this release deploys.
- **Room Scores cards now show their style-catalogue background** (admins' demo report). Root cause: `RoomScoresService.resolveCardChrome` only read the `game_room_game_library` overlay, but the admin Leaderboard Style button writes per-game styles onto the `games` row — so a Style-button background showed on the Tournaments tab and silently vanished on Room Scores. Games-row overlay now wins over the library overlay (same doctrine as Tournaments), covering active + pinned games; test pins all three resolution cases.
- **Lock indicator is visible from across the room** (admins' demo report): bigger + heavier stroke on all four card families, and ShowcaseCard's lock now uses the semantic warning amber instead of the per-theme decorative accent that made it invisible on some themes.

## [2.95.1] — unreleased

**Hotfix: device picker could silently submit a tournament-excluded device (RTX demo field report, 2026-08-09).**

### Fixed
- **SubmissionSheet's remembered-device restore validated against the UNFILTERED device list** while the dropdown renders the exclusion-aware one. A player whose remembered device is excluded by the current tournament (last submit on PC → AtGames-only tournament) got `device='pc'` in state while the `<select>` — lacking that option — visually fell back to the first option ("AtGames Cabinet"). Submit sent PC, server correctly bounced with "PC is not allowed for this tournament"; actively re-picking any option fixed it (real change event). The auto-select effect now uses the same `allowedDevicesForEngine` list the dropdown renders (+ exclusions in the effect deps), so an excluded remembered device falls through to the explicit "Choose the device…" placeholder instead. Follow-up: SubmissionSheet has no component test harness — a device-picker regression test wants one (tracked).

## [2.95.0] — unreleased

**Explicit audit-log sweep across admin writes (ROADMAP §C audit doctrine, deferred cleanup executed).**

### Changed
- **~48 admin write routes across `admin.ts`/`rooms.ts` now call `AuditService.log` explicitly** (moderation actions, destructive deletes, settings saves logging KEYS never values, identity ops, admin add/remove) — closing the long-documented gap where the blanket `auditLog` middleware audited NOTHING in production (mounted before router auth, so `req.user` was never set). Six misleading "auto-audited" code comments corrected. Deliberate skips (cosmetic/high-frequency/player-self writes) are inventoried in PR #189. The dead `app.use('/api/', auditLog)` mount is REMOVED (middleware file marked dead, kept for a test harness that wires it correctly); a regression test proves no phantom audit rows.
- Known residual: the shared `raImportHandler` (3 mount points, different auth models) has no audit call — comments corrected rather than forcing artificial single-actor attribution; tracked as future work.

## [2.94.0] — unreleased

**Ban follow-throughs: content cascade + moderation DM (ROADMAP §C, last two "not started" bullets).**

### Added
- **Ban → content cascade with per-ban choice.** Both ban forms (super-admin Reports "Bans" tab, room-admin members page) gain a content-action selector: **Hide (default) / Delete / Leave visible** for the banned user's existing scores and comments. Room bans cascade only that room's content; global bans cascade everywhere (`global_game_comments` swept by global bans only). Scores hide via the existing `orphaned_at` pattern; comments gained `hidden_at` (migration 142) filtered at the public read sites. Cache invalidation + `leaderboard:updated` follow the admin wipe-player precedent. Every touched row is recorded in `ban_content_actions` (migration 141).
- **Lifting a ban restores exactly the rows that ban's cascade HID** (returns/toasts `restoredCount`) — deliberate divergence from the membership precedent: content soft-hide exists FOR reversibility. Deleted rows are never restorable (stated in the UI copy).
- **Ban → Discord DM** (`BanNotificationService`): scope + reason + expiry, best-effort, deliberately BYPASSES notification opt-outs (moderation action; follows the OpsAlert direct-DM precedent). Resolves a DM-able Discord id across the identity-link graph, so banning a `google:*` alias with a linked Discord still notifies; google-only identities skip silently; DM failure never fails the ban. Cascade + DM run post-commit with failure logging (no nested transactions — known SQLite constraint).

## [2.93.0] — unreleased

**Member-picker admin add (membership & privacy arc rider).**

### Changed
- **Adding a room admin is now a searchable name+avatar picker over the room roster** (`MemberAdminPicker` component, `PlayerAvatar` idiom, existing-admins excluded), replacing the plain `<select>` from v2.39.0 — provider-agnostic end-to-end, so a `google:*` member is promotable exactly like a Discord member (the BE `admins/discord` endpoint + admin-only roster already supported this; the picker UX was the missing piece). The "Advanced: paste a username or ID" fallback stays — it remains the only way to grant admin to someone who hasn't joined the room yet. 7 new component tests incl. the google:* promote payload.

## [2.92.0] — unreleased

**Stale-PWA update nudge + `DISCORD_CLIENT_SECRET` encrypted at rest.**

### Added
- **"A new version of Arcaid is available — tap to refresh" banner.** Baseline-at-boot design off `GET /api/version` (first fetch sets the baseline, so it never fires on first load); re-checks on tab-visible + a 15-min interval; silent on fetch failure; dismiss persists per-version in localStorage. Mounted in the three layouts (public, room admin, super admin); kiosk deliberately excluded (unattended display, no one to tap). New `lib/updateNudge.ts` (pure compare logic) + `hooks/useUpdateNudge.ts` + `UpdateNudgeBanner.tsx`, 17 tests.

### Changed
- **`DISCORD_CLIENT_SECRET` is now encrypted at rest** — added to `ENCRYPTED_SETTING_KEYS`. No bespoke migration needed: `runSecretsMigration()` (boot step between `initDatabase` and `loadSettingsToEnv`) generically re-encrypts legacy plaintext rows for every allowlisted key — the same mechanism the other six secrets already use; the prod plaintext row converts on first boot of this release. 8 new tests cover plaintext→encrypted round-trip, idempotency, absent-row no-op, keyless-install fail-fast/no-brick, and settings-UI masking.

## [2.91.0] — unreleased

**Unlinked-player affordances (S14 field-testing follow-up).**

### Added
- **Disabled Follow affordance.** A player with no Discord identity now shows a disabled Follow button ("This player hasn't linked Discord yet") on the room player page and the player quick-view modal, instead of the button silently not rendering. Signal is the existing `discordUserId === null` from the enhanced-stats endpoint — no API change.
- **Distinct friend-add errors.** `FriendsService.addFriend` distinguishes "No player found by that name" from "<name> exists but hasn't linked a Discord account yet" (existence checked across `room_members` nickname claims ∪ `submissions` names; `err.code='PLAYER_UNLINKED'` → 404 with the specific copy).
- **Admin hint on unlinked players.** Room/super admins viewing an unlinked player's page get a muted hint pointing at `/map-user` and the identity merge tool (same playerToken-claims admin detection as GameDetail's score moderation).

### Notes
- The fourth ROADMAP part (name-typed stat resolvers falling back from `user_mappings` to `room_members`) turned out to be ALREADY SHIPPED in v2.23.2 (PR #77) — this release adds a cross-room-isolation regression test for it instead of duplicate code; the ROADMAP entry was stale.

## [2.90.0] — unreleased

**Kiosk renders through the shared ScoreboardSurface (v2.85.0 follow-up; screenshot-parity approved).**

### Changed
- **`KioskScoreboard.tsx` no longer keeps its own clone of the scoreboard card surface** (the last duplicated renderer; net −149 lines incl. the duplicate `<style>` block). Kiosk now consumes `ScoreboardSurface` like the public Scoreboard and admin Leaderboard, inheriting all future card work automatically. Kiosk chrome stays page-level: ticker, attract-mode auto-scroll, TV score toast, scanlines, polling/socket behavior, approval-room gate. `ScoreboardSurface` gained three default-off props kiosk needs: `zoomPercent` (KIOSK_ZOOM), `qrKioskOnlyEnabled` (the `SCOREBOARD_QR_MODE='kiosk-only'` case), `kioskHeaderSpacing` (historical mb-8 header spacing). Programmatic before/after layout diff across banner/showcase/ticker scenes at 1920×1080: zero deltas; `ScoreboardWysiwygParity` green (public/admin untouched). Two documented micro-deltas: legacy-card rooms with QR mode `all` now show the QR on kiosk (old kiosk never wired QR to legacy cards — oversight unified), and a room bg image now scrolls with overflowing content instead of staying viewport-pinned.

## [2.89.1] — unreleased

**Global Scoreboard live-score bump targets the right category card.**

### Fixed
- **`score:new:global` bumped every category card of a game (ADR 0016 P4 residual, logged v2.59.0).** The socket payload now carries the score's canonical `engine`; the client resolves it via `engineCardCategory` and bumps only the matching per-category card. A zero-score claim card (no category yet) takes the bump — that score is what opens its board. A payload without `engine` (older server mid-deploy) falls back to the old bump-all behavior and self-heals on the next fetch. Emitters updated: web global submit (`global.ts`) and Discord `/submit-score` fan-out.

## [2.89.0] — unreleased

**Ranking-card backgrounds (owner-designed 2026-08-09, screenshot-loop approved).**

### Added
- **Room admins can apply a style-catalogue background image to each ranking group's card.** Design (owner): per-group assignment (`ranking_groups.bg_style_id`, migration 140 — ALTER-added, pseudo-FK caveat noted in the migration), set via a "Style" button on ranking cards on the admin Leaderboard (reuses `StylePicker`; `PUT`/`DELETE /:roomId/ranking-groups/:id/style`), rendered on the full-size treatments only (match-scoreboard + plaque, with the same darkening overlay game cards use for legibility) — compact/sidebar deliberately unchanged. Presentation-only: `setBgStyle` never touches `ranking_groups_cache` (bg is not a `computeRankings` input; test pins `generated_at` unchanged). `StyleCatalogueService.delete()` now also nulls `ranking_groups.bg_style_id` referencing the deleted style. `ScoreboardSurface` gained `renderUnderRankingCard` (the ranking-card twin of the game cards' under-card admin-strip hook), threaded through `RankingsRow`/`RankingsColumn` across all six ranking render sites.

## [2.88.1] — unreleased

**Global Settings: RA + operator-alert config fields were unreachable.**

### Fixed
- **`RA_USERNAME` / `RA_API_KEY` had no input fields on Global Settings** — the v2.68.0 RA integration's own error copy (and the ROADMAP runbook) said "set them under Global Settings → Configuration", but `GlobalSettings.tsx`'s `GLOBAL_KEYS` catalog never gained the entries, so the feature was un-configurable from the UI (surfaced by the owner attempting the RA runbook, 2026-08-09). Both fields added with labels/descriptions; `RA_API_KEY` marked sensitive (masked input; it was already on the BE encryption allowlist). Same audit found `OPS_ALERT_ENABLED` / `OPS_ALERT_DISCORD_USER_ID` (v2.15.0, ships-inert operator alerts) equally stranded — added too. The settings POST endpoint always accepted arbitrary keys; this was FE-catalog-only.

## [2.88.0] — unreleased

**Scores page header compression (owner-asked 2026-08-08, screenshot-loop approved) + GameCard title wrap + SetupWizard removal.**

### Changed
- **Scores page header compressed to one control row (all three tabs).** The stacked centered rows (tab chips → subtitle line → search → tab-specific extras) collapse into a single `grid-cols-[1fr_auto_1fr]` control row: search left, Tournaments/Room Scores/Global chips true-centered, tab-specific extras right-aligned (Room Scores: Recent/A–Z/Most-played sort chips + game count + "Manage the game library →"; Global: results count + "See the full Global Scoreboard →", replacing the full-width banner row). The redundant subtitle line is gone (`scoresCopy.ts` lost `tabSubtitle`/`GLOBAL_BANNER_TEXT`). First card row now starts 199px from the viewport top vs 270px before (measured, tournaments desktop). Below `sm` the grid stacks (search → chips → extras) with zero horizontal page overflow. Room logo/title header untouched; score cards untouched; admin Leaderboard inherits via the shared `ScoreboardSurface` slots; kiosk unaffected.

### Fixed
- **Legacy `GameCard` no longer ellipsizes long game titles (no-ellipsis rule).** All four header-style title variants swap `truncate` for a 2-line clamp with word-break (mirroring `BannerCard`/`ShowcaseCard`'s `titleClampStyle`) and a reserved min-height so short-title siblings don't jump. The before-screenshot caught a real pre-existing bug this fixes: the non-shrinking truncated title visually bled past its card border into the neighboring card.

### Removed
- **`admin-ui/src/pages/SetupWizard.tsx`** — orphaned (unrouted, zero importers) first-boot wizard from the single-instance era. Its flow contradicted the current stack twice over: it set the admin password through a legacy `/auth/login` hack predating the multi-room auth model, and it demanded iScored credentials up front against the "iScored is optional — don't promote" doctrine (new rooms default it off since v2.81.0). A future self-host onboarding would be rebuilt Discord-OAuth-first; nothing to salvage.

## [2.87.0] — unreleased

**Launch polish batch: room-admin nav escape, Arcaid brand casing sweep, videogame tournament-mode normalization.**

### Added
- **Room-admin nav escape (owner-asked 2026-07-31).** `BrandWordmark` (`admin-ui/src/components/BrandWordmark.tsx`) now links to `/` by default — the only way out of `/admin/*` or `/:slug/admin/*` was editing the URL by hand. New `noLink` opt-out prop for the one surface that's already `/` (`LandingPage`, to avoid a self-link); `GlobalScoreboard`'s pre-existing wrapping `<Link>` was dropped in favor of the component's own. `SuperAdminLayout`'s sidebar + mobile-bar wordmarks (plain `<img>`, not the shared component) got the same `<Link to="/">` treatment. `RoomAdminLayout` additionally gained an explicit "View Public Room" nav item (`/:slug`) at the top of its sidebar, styled identically to the existing nav items.
- **`src/utils/tournamentMode.ts`** — `catalogueTypeMatchesTournamentMode(catalogueType, tournamentMode)` bridges `tournaments.mode` (`'pinball' | 'videogame'`) against `global_games.type` (`'pinball' | 'video_game' | 'arcade'`): `'videogame'` accepts both `'video_game'` and `'arcade'`; every other mode keeps exact-match behavior.

### Fixed
- **`videogame` tournament-mode / catalogue-type mismatch (found 2026-08-07).** Every eligibility site compared `tournaments.mode` against `global_games.type` with a raw `===`/`!==`, and `'videogame'` never equals `'video_game'` or `'arcade'` as a string — a videogame-mode tournament's Picks list, Discord `/pick-game` autocomplete, and autopick all silently returned zero games. Fixed at five sites via the new helper: `POST /:roomId/pick-game` and `GET /:roomId/game-availability/:tournamentId` (`src/api/routes/rooms.ts`), the Discord `/pick-game` autocomplete (`src/discord/commands/pickgame.ts`), `TimeoutManager`'s pick-timeout fallback autopick (`src/engine/TimeoutManager.ts`), and `TournamentEngine.autoPickAndActivate` (`src/engine/TournamentEngine.ts` — a fifth site found during the sweep, not in the original four). A pre-existing test (`game-availability-enrichment.test.ts`) had accidentally masked this by seeding the tournament mode as the literal string `'video_game'` instead of the real `'videogame'`; corrected to seed the real value and assert both `video_game` and `arcade` catalogue games are listed.

### Chore
- Brand casing sweep for "Arcaid" (never "ArcAid", decision 2026-07-25): grepped `admin-ui/src`, `admin-ui/public/manifest.json`, `src/discord/`, and `src/api/ogMeta.ts` case-sensitively for "ArcAid". No user-visible strings needed a fix — `manifest.json` and `index.html` were already "Arcaid"; the only two hits were in a non-rendered smoke-test assertion string, left as-is.

## [2.86.0] — unreleased

**Comments & ratings require login + admin comment moderation + room-scoped ratings.**

### Changed
- **Game comments and ratings now require Discord login to write.** Closes three holes: anonymous comment spam, rating ballot-stuffing (the client-supplied `x-user-id` header was previously the entire voter identity, trivially reset by clearing localStorage), and the banned-user anonymous bypass (a banned identity is only enforceable once it's identifiable — an anonymous writer was never bannable). Viewing comments/ratings stays open to guests; only POST is gated (`requireDiscordUser` + `requireNotBanned`, room comment POST and room rating POST). Author/voter identity is now the token's `discordId` only — the guest `x-user-id`/`'anon'` fallback on comment authorship is removed.
- **Room-scoped ratings (migration 139).** `game_ratings` gains `game_room_id`; the same game name in two different rooms now keeps independent rating aggregates (previously ratings keyed on `game_name` alone, so a rating on "Medieval Madness" in one room bled into every other room's aggregate for a same-named game). `RatingService`'s four methods all take `roomId`. Existing rows backfill onto the same default room the legacy `/api/ratings` alias resolves to.
- **Admin comment moderation on the public game page.** `GameDetail.tsx`'s comment/tip delete control now shows for `super_admin` and the room's `room_admin`, not just the comment's author — mirrors the score-history delete gate. Works for password/local-admin logins too: the room comment DELETE route now uses a new `optionalUser` middleware (decodes any valid token, not just Discord-identity ones) so a password-authenticated admin's `req.user.role` still authorizes moderation.
- **Global comment GET now masks identity.** `GET /api/global/games/:id/comments` previously returned every row's raw `discord_user_id`; it now nulls out every author id except the caller's own (mirrors the room comment GET's existing mask), closing the same replay gap the room route was already closed against.
- **Global comment DELETE gained a super_admin bypass and a scope check.** Previously author-only with no admin tier at all, and the `:id` path param (the global game) was never verified against the comment's actual `global_game_id` — any authenticated author could delete their own comment regardless of which game's URL they hit.

### Fixed
- Room ratings' `RatingService` used to accept a `userId` derived from a client-controlled header with no server-side identity check — anyone could vote unlimited times by rotating the header value.

### Migration
- `139_game_ratings_room_scope` — rebuilds `game_ratings` with `game_room_id NOT NULL` + `UNIQUE(game_room_id, game_name, user_id)`, backfilling existing rows onto the install's default room (oldest `game_rooms` row); drops rows if no room exists.

## [2.85.1] — unreleased

**Hotfix: admin controls strip now paints above QR codes** (owner-reported on prod ~1h after v2.85.0).

### Fixed
- On the admin Leaderboard, a bottom-center-positioned QR code's overhang painted OVER the controls strip and swallowed its clicks (browser hit-test confirmed: the Notes button's click landed on the QR `<canvas>`). Root cause: QR overlay (`z-index: 15`) and strip (`z-10`) shared one stacking context — `position: relative` + `z-index: auto` on the card root doesn't isolate. Fix: new `components/scoreboard/cardStacking.ts` states the coupling from both ends (`CARD_QR_Z_INDEX = 15`, `ADMIN_CARD_CHROME_Z_INDEX = 20`); the strip carries the inline z-index. QR stays fully visible behind the strip (admins see the design; scanning it on the admin page is a non-goal — owner decision). Public page untouched by construction (no strip there). Regression test asserts strip-z > QR-z AND that no ancestor establishes an intervening stacking context (the numeric compare is meaningless otherwise); new harness case `pair7-qr-bottom` covers bottom-center QR — the original QR pair used the default top-right position, which is why this escaped.

## [2.85.0] — unreleased

**Admin Leaderboard: controls off the titles + WYSIWYG scoreboard mirror** (owner-reported UX bug 2026-08-07 + owner mandate 2026-08-08: "admins see exactly the same scoreboard the players see").

### Changed
- **The room-admin Leaderboard page now renders the public scoreboard's exact surface.** The public page's entire render block (page-local `<style>` incl. the mobile-scale/vertical/zoom classes, title/logo header, bg layer with opacity + header-offset, grid/vertical/scroll layouts, banner-forces-scroll rule, `HorizontalScrollNav`, QR overhang reservation, rankings placement with style/sticky/opacity, legacy-GameCard-vs-CardRouter dispatch with the full prop set) was extracted into **`components/scoreboard/ScoreboardSurface.tsx`**; `Scoreboard.tsx` and `Leaderboard.tsx` both consume it, with all config derivation (`deriveScoreboardConfig`/`deriveCardProps`/`getCardWidth`/`qrBottomMetrics`) owned by the surface so callers cannot diverge. Public page verified behavior-identical (parity test asserts the admin card's outerHTML equals the public one). Closes ~40 documented divergences: admin previously rendered a players-never-see `AdminGameCard` on the no-style path (now DELETED), dropped QR/timer/title-style/score-expand props, lacked vertical layout + banner-forces-scroll + mobile scaling entirely, re-implemented `deriveCardProps` with drift, and ignored `SCOREBOARD_LOGO_ENABLED`/`SCOREBOARD_BG_OPACITY`/`SCOREBOARD_CARD_OPACITY`. Admin mirrors a fresh anonymous viewer (room defaults); submit `+` buttons omitted (overlay-positioned — no layout shift). Kiosk untouched (still on its own copy — follow-up).
- **Room public theme on the admin surface.** The admin page renders in the admin's personal theme, but the embedded scoreboard now renders under the room's `public_theme` via a subtree theme scope: new generated `.sb-theme-scope` class in `index.css` restates the default-theme tokens (the dark default has no class), so `sb-theme-scope theme-<room>` re-scopes every themed token for the surface only. `themeScopeParity.test.ts` regenerates the block from `@theme` and fails on drift.
- **Edit controls moved off the card titles.** The hover overlay (always-visible on touch, covering titles — and silently duplicating the legacy card's own inline cluster) is deleted; one always-visible `AdminControlsStrip` (Name / Notes / Style / Scores / Remove) renders as a flush rounded bar under every card in every layout branch, borrowing the card's tournament border color. Buttons keyboard-focusable; trash gained an accessible name.
- **Title interaction parity:** admin card titles are the same links the public page renders — plain click opens `GameQuickView`, modified clicks open the full game page — via shared factories extracted to `components/scoreboard/tournamentCardTitle.ts` (both pages import the same functions).
- Admin page now listens for `game:rotated` (previously stale after rotations).

### Added
- **Verified checkmark on the admin Leaderboard** (deferred v2.78.0 follow-up) — arrives structurally: the admin page now renders the public cards, which already show it.
- First test coverage for the admin Leaderboard page: `LeaderboardAdminControls.test.tsx` (strip/no-overlay/theme-scope, 8 tests) + `ScoreboardWysiwygParity.test.tsx` (17 tests asserting the WYSIWYG contract per style, incl. title-element parity guards proven to fail on prop removal).

**Found, not fixed (ROADMAP):** the public legacy `GameCard` truncates long titles with an ellipsis — a pre-existing violation of the no-ellipsis rule on the no-style path only (Banner/Showcase/Minimal wrap). Left untouched because the public look is this pass's spec; needs its own small player-facing change.

## [2.84.0] — unreleased

**Picks page: filters, tags & search** (owner-asked 2026-08-06, ROADMAP dedicated-session item; the companion "suspected eligibility bug" resolved as working-as-designed — the owner's tournament re-save upgraded its stored legacy rules to the two-axis shape).

### Added
- **Picks page player filtering** (`Picks.tsx`): engine filter pills (single-select `All | <engines present>`, derived from each game's `platforms ∪ room_tags`, hidden when the tournament spans only one engine); per-game platform chips + `manufacturer · year` line on desktop rows and mobile cards; search widened from title-only to title / manufacturer / year / platform-label matching, with an "X of Y games" count line while any filter is active. Availability cards, engine pill, and search compose as AND.
- **Title click → quick-view popup**: game titles open `GameQuickView` (artwork, self-fetched `manufacturer · year · platform` subtitle, single All-Time High stat + player, View-full-info + Global Scoreboard links) instead of navigating — scroll position and active filters survive close. Ctrl/cmd/shift/middle-click still opens the full detail page in a new tab. `GameQuickView` gained an additive presentational mode (`QuickViewTarget` structural prop + optional `highlightStat`; `rankings` now optional) — the three existing call sites are behaviorally unchanged; a stat-less game shows no body section rather than a false "No scores yet".
- **`GET /:roomId/game-availability/:tournamentId` rows enriched** (additive, 10 → 17 keys): `manufacturer`, `year`, `platforms`, `features`, `room_tags`, `global_game_id`, `image_url` (normalized via the `LeaderboardService.normalizeImageUrl` precedence `local → wheel → image_url`). Envelope + existing fields byte-compatible (MysteryAwardPage unaffected).

### Fixed
- **Web pick-list eligibility parity.** The availability endpoint previously applied neither the room-tag UNION nor the tournament-mode filter that `POST /pick-game` and the Discord `/pick-game` autocomplete both apply — so the web list could show a game that picking would then reject, and omit a game qualifying only via room tags. The SQL platform filter is now a superset pre-filter (required-clause branch widened with the room's tagged names) and the authoritative gate is the same JS `passesplatformRules([...platforms, ...room_tags], rules, features)` + mode check the Discord path uses. The endpoint's deliberate stricter-excluded behavior (ADR 0009 divergence, test-pinned) is preserved.

### Changed
- `PlatformChips` extracted from `GameLibrary.tsx` to `admin-ui/src/components/PlatformChips.tsx` (render there byte-identical). New `uniformStyle` mode used on Picks renders room tags in the same cyan family as platform chips, deduped by label — the amber room-vs-catalogue provenance treatment stays admin-only.
- Picks Pick buttons moved to `neon-purple` (page-unique; theme-token, all 16 themes); mobile game rows became separated bordered cards with the Pick button centered at the card foot; cooldown durations carry a muted "cooldown" caption.

**Found, not fixed (ROADMAP):** `tournaments.mode` (`videogame`) never string-matches `global_games.type` (`video_game`/`arcade`) at ANY pick surface (web, Discord, autopick) — pre-existing; video-game tournaments have always matched zero catalogue games. The new parity filter makes this visible as an empty web list instead of a silently-wrong one.

## [2.83.0] — unreleased

**My Stats: overall-best semantics** (owner revision 2026-08-07 after using v2.82.0).

### Changed
- Personal Bests on `/my-stats` now means "your single best per game, and where you set it."
  **All scope**: one row per distinct game across all rooms + direct-Global (name-keyed;
  cross-board tie goes to the earliest achieved), carrying the winning board's room logo or
  Global Scoreboard chip and that board's rank. **Room scope**: only games where this room's
  board holds (or ties) your overall best across everywhere — a "where am I most competitive"
  view, with an explainer line on the page. Games played in a room whose best lives elsewhere
  no longer appear in that room's scope. The "Games with a best" tile counts accordingly
  (distinct games in All; overall-bests-set-here in room scope). Implemented as a pure
  post-processing collapse (`collapseToOverallBests`) over the unchanged v2.82.0 SQL legs;
  room player pages (PlayerDetail) keep room-local bests unchanged.

## [2.82.0] — unreleased

**My Stats v1** (Phase 3 of the Identity & membership arc — closes the owner-approved contract,
ROADMAP 2026-08-05).

### Added
- **My Stats page** (`/my-stats`), reachable from the account menu only (owner decision: no
  global-nav item). Scope selector `All | <each member room>` — no separate "Global" scope;
  direct-Global bests appear in All with a "Global Scoreboard" provenance chip. Contents:
  three overview tiles (games with a best, member rooms, scores posted) + the searchable
  Personal Bests table. Room rows show the room's logo (text fallback when none) and link to
  the game in that room; Global rows link to the global game page. Titles wrap fully
  (no-ellipsis doctrine). Login-gated with the standard Discord/Google panel.
- **`GET /api/me/stats?scope=all|<roomId>`** — identity = the token id expanded through the
  identity-link graph (`BanService.expandIdentityCandidates` precedent) plus all
  `user_mappings` iScored aliases, via the new `IdentityCandidateService`. Rankings fold every
  alias onto ONE canonical competitor inside the SQL (a bare `IN` filter would double-count a
  multi-alias player — regression-tested). Room leg follows the v2.75.1 `(game_room_id,
  LOWER(game_name))` doctrine; Global leg is DIRECT submissions only (fan-out copies excluded
  via `origin_game_room_id IS NULL`; `exclude_from_global` rows excluded so ranks match the
  public board). Room-scoped requests require membership (403 otherwise). Unlinked room
  display names deliberately excluded (contract: beta-acceptable).
- `PersonalBestsSection` extracted to a shared component (PlayerDetail renders unchanged) with
  opt-in `wrapTitles`, per-row links, room-logo captions, and the provenance chip.

## [2.81.0] — unreleased

**iScored posture + Dashboard game icons** (owner-requested 2026-08-06).

### Changed
- **iScored is opt-in for all new rooms.** Every newly created room now seeds
  `ISCORED_ENABLED='false'` (previously only standalone rooms did); admins flip one toggle in
  Settings > Integrations to opt in. Existing rooms are untouched. The iScored settings copy
  now frames the integration honestly as a legacy external bridge: name-only sync,
  unverifiable, room-local (never on the Global Scoreboard), and spoofable by anyone with
  access to the iScored board. Standing stance: tolerated legacy bridge — don't promote,
  don't break.
- **Room Admin Dashboard "Active Now" cards** now show a small (32px) game image icon beside
  the game title, resolved from the approved catalogue the same way public leaderboard cards
  resolve art (with a dedup guard so same-name catalogue entries can't duplicate cards).
  Owner-reviewed layout revisions rode along: game titles wrap fully instead of truncating
  with an ellipsis, and the Leader block is restructured — "Leader:" left-aligned, username
  right-aligned, score right-aligned directly beneath the username.

## [2.80.0] — unreleased

**Membership & privacy model** (Phase 2 of the Identity & membership arc — owner-approved
contract in ROADMAP, 2026-08-05). "Private" decomposes into orthogonal settings:

### Added
- **Unlisted rooms** — new per-room `ROOM_LISTED` toggle (default on). Off = the room is
  dropped from the public room list (`GET /api/rooms`) for every caller, but stays fully
  reachable by direct link: slug/portal resolution, room login, OG link previews, and a
  member's own My Rooms list are all unaffected. "Link room" = unlisted + open policy.
- **Auto-approve Discord server members** — new `AUTO_APPROVE_GUILD_MEMBERS` toggle on
  approval rooms. A join request from a member of the room's linked Discord guild
  (`DISCORD_GUILD_ID` setting) is approved instantly at Join-click time:
  `JoinRequestService.tryAutoApprove` resolves the requester's identity (identity-link-aware,
  so Google users with a linked Discord account pass), asks the bot via
  `DiscordClient.isMemberOfGuild`, and on success writes the join-request row pre-resolved
  (`resolved_by='auto:guild'` — the admin resolved queue labels it "Auto-approved (Discord
  member)") plus the membership. Any uncertainty (setting off, no guild linked, unlinked
  Google identity, gateway down, membership unknown) degrades to the manual approval queue —
  never auto-deny. Membership persists after guild departure (no auto-revoke). The room join
  gate drops live on instant approval (portal cache invalidated + refetched).

### Removed
- **`REQUIRE_DISCORD_LOGIN` retired wholesale.** Login has been unconditionally mandatory for
  score submissions since v2.79.0, making the per-room setting moot. Deleted: the
  `conditionalRequireDiscordUser` middleware (zero route consumers since v2.79.0), the
  portal's `require_discord_login` field, the scoreboard-config `REQUIRE_DISCORD_LOGIN` key,
  the settings flip side-effect plumbing + `OrphanService` (its only entry point), the
  room-create seeding, and the FE login-policy lib + `requireLogin`/`discordOnly` prop
  threading across the five score surfaces. Rooms can no longer restrict login to Discord
  only — both providers (Discord + Google) work everywhere. Migration 138 deletes stored
  setting rows. Existing orphaned score rows and every `orphaned_at IS NULL` query filter are
  deliberately untouched (owner decision: any data cleanup is a separate, backed-up, eyeballed
  pass).

### Notes
- Kiosk-on-approval-rooms limitation unchanged. The member-picker admin-add rider is
  deferred (separable). Comments/ratings remain guest-allowed (login-gating them is a
  tracked follow-up).

## [2.79.0] — unreleased

**Login mandate: no guest scores** (owner decision 2026-08-05 — "I'm putting my foot down";
Phase 1 of the Identity & membership arc, see ROADMAP contract). Every web score submission
now requires a logged-in player (Discord or Google). Guest/anonymous score submission is
removed product-wide, regardless of any room's `REQUIRE_DISCORD_LOGIN` setting (the setting
survives, vestigial for scores, until the Phase 2 membership model retires it).

- **BE:** the three room submission endpoints (`/submit-score`, `/freeplay-score`,
  `/community-scores`) switched `conditionalRequireDiscordUser` → `requireDiscordUser`
  (which accepts both Discord snowflakes and namespaced `google:*` ids — verified against
  the token-minting path); dead anon-token (`x-user-id`) attribution branches removed from
  those handlers. Comments/ratings deliberately stay guest-allowed (out of scope; login-gating
  them is a tracked follow-up).
- **Removed routes:** `POST /submission-drafts/:stateParam/commit-as-guest` (the guest
  landing after declining the OAuth claim prompt) and `POST /:roomId/submit/anonymous-check` +
  `POST /:roomId/submit/name-check` (the guest collision-check pair — their only caller was
  the deleted SubmissionSheet guest flow; `RoomNameClaimService.checkAvailability` survives
  as a service method and its blocklist chokepoint test moved to the service seam).
- **v2.54.0 username-lock deferral CLOSED:** the authed draft `commit` path now resolves the
  score's display name server-side via `resolveSubmitName` (both room and global target
  branches) instead of honoring the free-text name typed while a guest; the self-claim merge
  sweep still keys off the typed draft name so pre-login anon identities are still claimed.
  Known minor gap: unlike the direct `/global/scores` route, the global commit branch does
  not additionally register the resolved name as a `user_mappings` alias.
- **S11 item 2 verified closed:** `community-scores` derives attribution solely from the
  token (`req.user`) — a spoofed `body.discord_user_id` is ignored (regression-tested).
  With `requireDiscordUser` + `requireNotBanned` on every submit path, the ban-enforcement
  anon-tier gap is closed **for scores** (iScored-synced scores remain name-only by nature —
  external source; `/map-user`/merge remain their attribution path).
- **FE:** SubmissionSheet's guest flow (claim prompt, name-collision prompt, anon submit)
  is deleted — logged-out viewers get the same login-required panel Global submissions
  already used (Discord + Google buttons); PendingSubmissionWatcher's "Submit as guest"
  cancel option removed (endpoint gone), resume-draft path kept.
- No migration. No stored data touched (`anon_room_claims`/`anonymous_identities` and all
  existing guest scores remain).

## [2.78.0] — unreleased

**Verified checkmark on leaderboard rows + Global Scoreboard mobile overflow fix** (two
small slots from the ROADMAP queue, 2026-08-04).

### Verified checkmark on leaderboard rows (deferred from v2.73.0)

- S23.7 shipped the admin verify/unverify loop (`score_history.verified_by`/`verified_at`)
  but only surfaced the checkmark in GameDetail's history expand — the leaderboard-row
  checkmark was deferred because pre-S24.1 it would have baked mutable state into
  `leaderboard_cache` JSON. Now resolved at READ time, the S24.1 way: `LeaderboardService.hydrate`
  attaches `verified: boolean` alongside `resolveProfiles` via one batched `score_history`
  query per read, scoped by `loadWindows` to the EXACT window predicate `queryRankedRows`
  filters on (`game_room_id` + `submitted_during_tournament_id` + `LOWER(game_name)`,
  `orphaned_at IS NULL` — never `sh.game_id`, the v2.75.1 decay lesson). Rows match on
  `(LOWER(iscored_username), score)`; verified when ANY matching event is verified. The cache
  envelope and the verify/unverify routes are untouched — no invalidation anywhere, the flag
  is fresh on the next read by construction (asserted by test: byte-identical cache blob
  before/after verify, flag still flips).
- FE: `BadgeCheck` icon (the S23.7 GameDetail idiom — `text-neon-green`, "Verified by an
  admin" tooltip) renders as a `flex-shrink-0` icon beside the truncating player name in every
  `RankedEntry` row renderer: `GameCard` (both layouts), `BannerCard`, `MinimalCard`,
  `ScoreList` (Showcase ranks 4+), `ShowcasePodium` (top 3). Paths that don't route through
  `hydrate` (e.g. `RoomScoresService` all-time rankings) leave the flag unset — `verified?` is
  deliberately optional. Known follow-up: the legacy `AdminGameCard` variant on the admin
  Leaderboard page doesn't render it.

### Global Scoreboard control-strip overflow (ROADMAP "next small slot")

- The sort/density strip overflowed narrow phones — measured 89px past a 390px viewport
  logged-in (159px at 320px), the whole page scrolling sideways, exactly the ROADMAP's
  "479px wide on a 390px phone". Root cause: the strip wrapper's `self-start` opted it out of
  stretch width below `lg`, so it sized shrink-to-fit — which counts the sort-pill
  `overflow-x-auto` descendant's MAX-CONTENT width, leaving the inner `max-w-full` with an
  unbounded parent to resolve against (the v2.68 scroll container never engaged). Fix:
  `w-full lg:w-auto` on the wrapper — the parent gets a definite viewport-bound width and the
  pre-existing inner scroll container actually contains the pills. Zero page-level overflow at
  320/390 × logged-in/out (measured); the strip scrolls within itself (461px content in a
  356px box at 390px).

Tests: backend 1446 → 1449, admin-ui 469 (green). No migration.

**Picks badge honesty + Picks page mobile pass** (tester field report via the owner, 2026-08-03:
a badge with nothing behind it on the page).

### The badge/page agreement fix

- **Root cause of the report:** `PickAlertService`'s `emptyQueue` "soft nudge" ("your queue is
  empty — line one up") counted a player as having standing if ANY game row ever carried them as
  picker — including when their own pick was the CURRENTLY ACTIVE game. The tester's badge showed
  2 precisely because his two picked games were live in both gated tournaments; the Picks page has
  no UI for that state, so the badge looked haunted. Now suppressed per-tournament while the
  viewer's own pick is ACTIVE (lifts on completion); regression test reproduces the field case.
- **Badge and page agree by construction:** `Picks.tsx` now fetches the SAME `/pick-alerts`
  payload the nav badge uses and renders every state — `emptyQueue` → soft cyan per-tournament
  banner ("Nothing queued for X — line up your next pick"), `ineligible` → amber "On cooldown"
  chip on the matching queued row (previously indistinguishable from a healthy row). Post-write
  refreshes clear banner and badge in the same tick.
- **`pick-status` filter alignment:** its `pendingPicks` ignored `is_active` + the `winner_picks`
  gate while the badge filtered both — an archived/gate-off tournament could render an
  "Awaiting your pick" prompt the modal couldn't act on. Aligned (NULL-is-enabled legacy default
  preserved). `queuedGames` deliberately NOT filtered — hiding those rows would strip the
  player's only delete path for them.
- **TimeoutManager placeholder leaks:** two `fallbackToAutoSelection` branches (auto-pick
  disabled; no eligible games) left `[Pending Pick]` rows with `picker_discord_id` NULLed —
  invisible to badge AND page but parked at the queue head (`queue_order` NULL sorts first),
  silently blocking the tournament and generating phantom soft alerts for others. Both now DELETE
  the placeholder (mirroring the existing at-max-active branch). The catch-all error branch keeps
  the row AND the picker id — a transient failure must not orphan a player's pick.
- Stale-badge fix: PublicLayout clears the badge on 401 (was: painted the last count forever);
  other errors still keep the previous value.

### Picks page mobile UX

- Header un-scrunched: title/description stack above a full-width tournament selector on phones
  (was one non-wrapping row where a 60-char description wrapped 4 lines beside the select).
  Copy shortened: "Queue your next pick or spin the Mystery Award."
- **"Translite" jargon removed from player-facing copy** — now "Spin for a random pick from the
  available tables." (The Mystery Award cabinet keeps its themed internals.)
- Mystery Award card balanced on mobile: chip + title row, full-width description, full-width
  Spin button; desktop inline layout unchanged. Summary cards collapse to a single-row chip
  strip at 390px. Queued rows wrap to two lines on phones (game name + tournament context) —
  the cooldown chip made the pre-existing truncation visibly worse, screenshots drove the fix.

Files: `src/services/PickAlertService.ts`, `src/api/routes/rooms.ts` (pick-status),
`src/engine/TimeoutManager.ts`, `admin-ui/src/pages/Picks.tsx`,
`admin-ui/src/components/PublicLayout.tsx`.

No migrations. Tests: backend 1432 → **1446** (emptyQueue suppression incl. the field-case
regression, pick-status alignment, all three TimeoutManager branches; one pre-existing assertion
rewritten — it locked the old orphan-the-placeholder behavior), admin-ui 461 → **469**.

## [2.76.0] — unreleased

**Field-check UX batch** (owner reports, 2026-08-02): score overflow, nav highlighting, and a
History view that finally works on a phone — plus the app's first per-tournament score page.

### Score-overflow sweep (12 files)

- **The reported bug:** the Community tab's Best Scores table clipped 8+ digit scores at the
  card's rounded edge — the score cell was a fixed `w-20` (80px, ~7 digits) with no shrink guard,
  and the card's `overflow-hidden` did the clipping. Recon found the same anti-pattern family
  across the app (Full Score History `w-20`, PlayerDetail Personal Bests equal-fraction grid,
  fixed-px grid tracks) plus a dozen unguarded flex rows.
- **One containment doctrine, applied everywhere:** score cells get `flex-shrink-0
  whitespace-nowrap tabular-nums` and NO fixed width; the adjacent name column yields
  (`min-w-0` + `truncate`); grid score columns are content-sized. Long-number stat tiles use
  the length-aware font ramp (`StatCard`'s, now also on `MiniStat` and admin Stats' Avg Score);
  Personal Bests reflows to a 2-column stack below `sm` (GlobalHeroCard's sanctioned pattern).
  `ShowcasePodium` steps its font down by length (ellipsis on a number is wrong; the slot can't
  grow). New `scoreTitle()` helper in `lib/format.ts` for the full-value ≥1T tooltip.
- Screenshot-verified at 390px/1280px with 15-digit scores: no numeric overflow, no horizontal
  page scroll.

### Nav active-state (the section stays lit)

- Five room pages were URL *siblings* of their nav section, so no highlight could ever match
  (`/history` + `/compare` → Stats, `/players/:id` → Players, `/games/:name` → Scores,
  `/mystery-award` → Picks). Desktop and mobile share one nav — the bug was everywhere, mobile
  is just where the highlight is the only location cue.
- New `navSectionForPath()` (`admin-ui/src/lib/navSections.ts`) — one testable predicate maps
  every path (trailing-slash tolerant) to its section; nav items now use it with explicit
  `aria-current="page"` so the a11y state and visual state can't diverge. 33 new tests.
  The `/tournaments/*` path maps to Stats (new this release). The Global item stays inert by
  structure (the room nav unmounts on global pages).

### History view + per-tournament score boards

- **`/:slug/history` redesigned.** Mobile rows are a clean 3-line stack: game + type badge
  (badges no longer wrap — `flex-shrink-0 whitespace-nowrap`), winner with trophy + score,
  tournament name + end date — winner and end date were already in the API but hidden on mobile.
  Desktop gains a dedicated Type column so badge-width variance stops pushing tournament names
  around (single-grid `display:contents` rows keep headers aligned over columns).
- **Every History row now links to the new tournament page** `/:slug/tournaments/:tournamentId`
  (additive `game_id`/`tournament_id` columns on `GET /:roomId/history`).
- **New page + endpoint: all scores submitted to ONE tournament.**
  `GET /api/rooms/:roomId/tournaments/:tournamentId/scores` (public;
  `src/services/TournamentScoresService.ts`) returns per-game boards keyed on
  `submitted_during_tournament_id` + `LOWER(game_name)` — **never a `games` join on
  `sh.game_id`** (the v2.75.1 decay lesson, applied from the start). Boards ship ranked
  best-per-player rows (canonical identity partition, competition ranking 1-2-2-4, display
  names via `resolveProfiles`), slot metadata decorated by name from the tournament's `games`
  rows ("Featured N×"; deleted-slot boards still render — score outlives game), and the board's
  own rank-1 as winner (documented: the tournament-window winner, which can differ from
  `/history`'s all-time-`submissions` winner). FE: `TournamentDetail.tsx` — back link, type
  badge, LIVE indicator, date range, per-board score lists with gold top row.

Files: BE `src/api/routes/rooms.ts` (route + 2 SELECT columns), new
`TournamentScoresService.ts` + test suite; FE 12 score-sweep files + `lib/navSections.ts` +
`PublicLayout.tsx` + `PublicHistory.tsx` + new `TournamentDetail.tsx` +
`TournamentTypeBadge.tsx` + `App.tsx` route.

No migrations. Tests: backend 1425 → **1432**, admin-ui 414 → **458** (+33 nav, +11
history/tournament). Screenshots in the PR-adjacent `tmp/` harnesses (gitignored).

## [2.75.1] — unreleased

**Fix: Personal Bests was empty for every player in every room** (since v2.74.0; found via the
owner's field check of the v2.75.0 search — the FE hides the section when the list is empty, so
there was no search box to find).

- **Root cause:** S24.5 moved `getPersonalBests` from `submissions` to `score_history` but scoped
  the new query with `JOIN games g ON sh.game_id = g.id` (+ `JOIN tournaments`). Production
  `score_history` has **zero non-NULL `game_id` rows table-wide** (verified 2026-08-02):
  `game_id` is a transient pointer, not a key — the dominant web submit path
  (`CommunityScoreService`) never supplies one, and every unpin/game-delete/cleanup path
  deliberately runs `UPDATE score_history SET game_id = NULL` to preserve the score after its
  `games` row goes away (ADR 0005). Any read joining `games` on `sh.game_id` matches nothing.
- **Fix:** re-keyed on `(game_room_id, LOWER(game_name))` — the `RoomScoresService` doctrine
  (room scope via `sh.game_room_id = ?` like the sibling `getParticipationStreak`, display name
  from `MAX(game_name)` so casing variants fold, `game_room_id` kept in the key so the same game
  name in two rooms stays two boards).
- **Deliberate behavior deltas vs. the pre-v2.74 `submissions` list:** pinned-game scores,
  freeplay/community scores, and scores whose `games` row was since deleted now all appear — the
  same population the Room Scores page shows. This closes the v2.75.0 residual (a)
  (pinned-games exclusion) as a side effect.
- **Why tests missed it:** the s13 fixture wrote `score_history` rows WITH `game_id` — a shape no
  live path sustains. New `insertHistoryScore` fixture writes the real prod shape (`game_id`
  NULL); 4 regression tests (prod-shape ranking, cross-room isolation, no-tournament inclusion,
  casing collapse), all verified failing against the old query.

Files: `src/services/StatsService.ts` (query re-key + doctrine comment rewrite),
`src/__tests__/s13-achievements.test.ts` (prod-shape fixture + 4 regression tests).

No migrations. Tests: backend 1421 → **1425**, full suite green; admin-ui untouched (414).

## [2.75.0] — unreleased

**Searchable Personal Bests** (closes ROADMAP "Personal-best lookup in game rooms", user request
2026-07-31). The Global Scoreboard's *My Score* density mode had no room-scoped equivalent — a
player with scores across many games couldn't quickly answer "what's my best on X?".

- **The Personal Bests table on the player detail page (`/:slug/players/:name`) is now searchable
  and complete.** A search input (shown when the list exceeds 5 rows) filters by case-insensitive
  substring on game name, as-you-type. The unfiltered view caps at 20 rows with a
  "Show all N" / "Show fewer" toggle; while a query is active every match renders uncapped with an
  "N of M games" count line (a hidden match is exactly the failure the search exists to prevent),
  and a no-match query shows an empty-state row instead of hiding the section. API order
  (`room_rank ASC`) is never re-sorted; filtering is client-side by design — no new endpoint or
  query param. The block is extracted to an exported `PersonalBestsSection` (same file) with
  identical render output for the pre-existing short-list case.
- **BE: `StatsService.getPersonalBests` `LIMIT 50` → `1000`.** The old top-50-by-rank truncation
  would have defeated the search — it hides a player's best on games they rank poorly at, which is
  exactly what the lookup is for. 1000 is a backstop against pathological data, not a paging
  boundary; the query (and its v2.74.0 `score_history` doctrine) is otherwise untouched.

Files: `src/services/StatsService.ts` (limit + rationale comment),
`admin-ui/src/pages/PlayerDetail.tsx` (`PersonalBestsSection` extraction + search/collapse UI),
`admin-ui/src/pages/__tests__/PlayerDetailPersonalBests.test.tsx` (new).

No migrations. Tests: admin-ui 404 → **414** (+10: render parity, filter, case-insensitivity,
toggle, uncapped-while-filtering, empty state); backend stats suites green
(`s13-achievements`, `gamedetail-history-stats`, `s14-social-loops`), full suite on CI.

Known followup (in ROADMAP): room-scoped Personal Bests exclude **pinned** games (the room-scope
join goes through `tournaments`, so `tournament_id IS NULL` rows never appear) — pre-existing
behavior, now explicitly tracked.

## [2.74.0] — unreleased

**S24: backend efficiency round 2** (refreshed contract). No migrations. Structural query-count
wins, one live-bug fix, and the Google-avatar fold-in.

- **Read-time profile join (S24.1) — the structural centerpiece.** `leaderboard_cache` +
  `global_leaderboard_cache` now store identity-stable rows only (wrapped in a `{v, rows}`
  envelope; old bare-array blobs read as cache misses), and display names/avatars attach at read
  time via the new `resolveProfiles` (`src/services/PlayerProfileResolver.ts` — two batched
  queries per page, reproducing the documented resolution rule leg-for-leg, including the
  synthetic-id guard). The rename (`users.ts`) and avatar-change (`auth.ts`) paths now perform
  NO cache invalidation — pre-fix a rename was 2 whole-table cache DELETEs plus a full serial
  room recalculate on the next page load. **Fixes a live bug: avatar changes never invalidated
  `global_leaderboard_cache`, so a changed avatar was permanently stale on the Global
  Scoreboard.** Regression test asserts avatar visibility with zero invalidation. CLAUDE.md's
  display-resolution section rewritten: never bake a name/avatar back into that cache JSON.
- **Google avatars on every leaderboard surface** (closes the ROADMAP line): `avatar_url` ships
  through the resolver + the live query sites (`RankingService.computeRankings`,
  `StatsService.getAllPlayerStats`, `GlobalPinService.list` — an unlisted re-projection consumer
  caught by a key-shape assertion) and threads through ~12 `<PlayerAvatar>` JSX sites.
- **Poller churn (S24.2):** per-tick creds resolution collapses from ≥4 settings reads × every
  room (including iScored-disabled ones) to one batched query; `user_mappings`/`player_aliases`
  full-table loads defer until a gate decision actually says run. All-skip tick = zero identity
  queries (asserted).
- **Thundering-herd dedup (S24.3):** in-flight promise maps on `getForGame`, `getRankings`, and
  `getForGameByProvenance` (keyed `(gameId, engine, device)`; its deliberate cache bypass
  stands). Two concurrent cold reads = one recalculate (asserted).
- **`getActiveLeaderboards` (S24.4):** cadence/room on the main SELECT, batched TIMEZONE lookup,
  per-tournament COMPLETED queries folded into one window query — `2T+` queries → 3 fixed.
- **StatsService (S24.5):** both correlated finish-position subquery copies →
  `RANK()/COUNT() OVER`; champion-streak scans bounded (display cap 100); **doctrine fix:
  `getPersonalBests` reads `score_history`** — a moderated-away score no longer lingers as
  someone's personal best. (Optional 60s stats TTL skipped — the window functions removed the
  cost that motivated it.)
- **`/room-scores` (S24.6):** one windowed ranking query per page instead of one per card.
- **Global Scoreboard TTL cache (S24.7):** 30s in-memory cache on the SHARED half of the list
  route — anonymous repeat loads cost zero DB work. Viewer-varying views (`sort=pinned`, pin
  enrichment, logged-in) and searches are never cached; 200-entry cap; DB-handle reconciliation
  guards test isolation.

Behavior notes: public `/scoreboard` may be up to 30s stale for logged-out visitors (logged-in
always live); renames/avatars now propagate instantly everywhere; a personal best can
legitimately disappear if its backing score was moderated away.

Tests: backend 1400 → 1421 (new S24 correctness/concurrency suite), admin-ui 404 (green).
Fixture correction: `s13-achievements` `insertSubmission` now dual-writes `score_history`,
matching every production path.

## [2.73.0] — unreleased

**S23: standalone Discord submits, bulk score import, score integrity** (refreshed contract;
folds in the three S22 residuals). Migrations **134–137** (all ALTER-ADD, no rebuilds).

- **Discord `/submit-score` finally works in rooms without iScored.** Pre-fix, an
  `ISCORED_ENABLED=false` room was locked out entirely — the command aborted on missing creds
  *before any local write*, and standalone room creation seeds exactly that setting, so this was
  every standalone room. The hard `iscored_id` gate in `resolveActiveSubmitGame` is gone; the
  local write (submissions upsert + `score_history` + fan-out + feed) runs unconditionally, and
  iScored sync is now a conditional, non-fatal step AFTER it — mirroring the web paths. A sync
  outage can no longer cost a player their score. Success replies also gained **rank feedback**
  ("You're #3 of 11") computed from the same `LeaderboardService.getForGame` ranking the board
  renders. (The ambiguous-engine select-menu polish was time-boxed out; the re-run prompt stays.)
- **Bulk score-import CSV** (room admin): `game_name, player_name, score, date?, engine, device,
  photo_url?` — preview/commit two-step copying the game-CSV importer's in-browser-parse shape,
  500-row cap, per-row provenance validation via `ScoreProvenanceService`. Rulings as contracted:
  rows land `source='community'` with NO tournament linkage (a new `skipTournamentLink` opt-out
  on `ScoreHistoryService.log` — the logger otherwise auto-attaches the currently-active
  tournament, which would have polluted live boards with backfills), NO Global-Scoreboard
  fan-out (asserted by test), no iScored sync, no feed events; explicit `AuditService.log` on
  commit. The `submissions` upsert runs only when the game is live in the room (arbitrary
  historical catalogue games have no `games` row) — `score_history` is always written.
- **Room-scoped score reports** (was global-only). `score_reports` gains a `score_source`
  discriminator + `game_room_id` (migrations 134/135; existing rows default `'global'`). New
  `POST /:roomId/score-history/:historyId/report` (Discord-authed, ban-gated, duplicate-open
  409). `ScoreReportService` branches per source — room rows join `score_history` with a
  load-bearing `CAST(r.score_id AS INTEGER)` (TEXT vs INTEGER storage classes would otherwise
  match nothing, silently). Room-report deletes route through the extracted
  `ScoreHistoryService.deleteEvent` — the v2.9.0 per-row delete machinery (recompute +
  `deleted_score_suppressions` tombstone) moved out of the route so it's reused, not forked;
  the Reports UI shows one "Delete Score" for room rows (no fake soft/hard distinction —
  `score_history` has no tombstone column). FE: flag affordance on room GameDetail rows via the
  existing `ReportContentModal` pattern.
- **Verified-score loop** (gates the future self-EDIT feature): `score_history.verified_by`/
  `verified_at` (migrations 136/137 — deliberately NOT the dead legacy `scores.verified`).
  Verify/unverify admin routes (audit-logged), checkmark in the GameDetail history expand.
  Leaderboard-row checkmark deferred to post-S24.1 (it would bake mutable state into
  `leaderboard_cache` JSON — the exact staleness class S24.1 removes).
- **Bulk "Untag…"** wired into the game-library bulk bar — the `bulk-untag` endpoint existed
  with zero FE callers since ADR 0008.

Tests: backend 1371 → 1400 (new `s23-score-integrity.test.ts`, 29 cases), admin-ui 404
(unchanged, green).

## [2.72.0] — unreleased

**Discord HQ: global community server + web notification settings** (owner-approved contract,
2026-08-01). A shared "Arcaid HQ" guild gives every player a mutual server with the bot, so
Discord DMs can work even when their room has no Discord integration. Everything ships inert
until `GLOBAL_DISCORD_GUILD_ID` is set in Global Settings.

- **`DiscordReachabilityService.canDm`** answers "can the bot DM this user?" from guild
  membership (HQ guild first, then Discord-enabled room guilds; 10min positive / 1min negative
  cache). Gateway-down verdicts are never cached and never suppress a send — DMs ride REST, so
  "we couldn't tell" always means "send".
- **Web notification settings** (Account Settings): the five notification opt-ins render once
  with DM/Push channel chips — they are ONE stored set shared with the `/arcaid-notifications`
  Discord command (same prefs JSON, two surfaces) — above Browser-push and Discord-DM channel
  cards. The Discord card shows a live deliverability verdict instead of implying the toggles
  alone suffice. Closes the chicken-and-egg for players in Discord-less rooms. New
  `GET`/`PUT /api/me/notification-settings`.
- **One-click join**: `GET`/`POST /api/auth/discord/connect-notifications[/callback]` — a
  SEPARATE OAuth flow with scopes `identify guilds.join`; the LOGIN authorize is untouched and
  stays `identify`-only. `connect:<nonce>` state extends the `link:` convention; three-way
  identity check (nonce initiator = bearer token = authorizing Discord account); 201 and 204
  both count as success so the join is idempotent; Discord's own error text surfaces verbatim;
  `GLOBAL_DISCORD_INVITE_URL` renders as the manual fallback.
- **Failure nudge**: un-DM-able rejections (Discord 50007/50013 — transient failures
  deliberately excluded) raise a one-time dismissible banner via `DmNudgeService`, stored under
  `_dmNudge` in `user_preferences.notification_prefs` — no new table, no migration; cleared on
  dismissal or the next successful DM. Opted-in users who are already known-unreachable
  short-circuit at `notify()` time: the nudge raises without burning the doomed REST call, and
  web push still carries the event.
- Contract correction, followed the code: the DM-failure swallow lives in `sendDirectMessage`
  (`src/utils/discord.ts`), not `NotificationService` — the nudge hooks there, swallow preserved.

Operator runbook: set `GLOBAL_DISCORD_GUILD_ID` (+ optional `GLOBAL_DISCORD_INVITE_URL`, https
only); grant the bot **Create Invite** in the HQ guild (or rely on the invite-link fallback);
the SERVER MEMBERS intent is already enabled (the client requests it at startup — the gateway
would refuse the handshake otherwise). A user with "Allow direct messages from server members"
off stays unreachable even after joining — the UI never promises otherwise and the nudge
catches it.

Tests: backend 1325 → 1371 (new `discord-hq.test.ts`, 46 cases), admin-ui 396 → 404 (nudge
banner suite).

## [2.71.1] — unreleased

**Hero frame: attract-mode sweep replaces the marquee bulbs** (user verdict on v2.71.0). One
bright gold band travels smoothly around the lit frame (8s laps, 22°/44° lead/trail falloff,
single segment — dual was A/B-rejected as reading like uneven lighting) via a masked gradient
ring with a transform-only rotating layer. Band widened to 5px so the crest registers over the
bright frame. Light theme sweeps deep bronze (a white-hot crest on a pale page reads as
erasure). Reduced motion: even gold wash, no parked hot-spot. Zero layout shift (geometry-diff
verified). Tests: admin-ui 395 → 396.

## [2.71.0] — unreleased

**Hero champion marquee** (user-approved option 1, 2026-08-01). The Global Scoreboard hero gets
its own identity: gold chase-light marquee frame (four compositor-only strips running one
clockwise circuit; reduced-motion keeps the ring lit but still), a Hottest board ribbon, and NO
category chip or engine pills — gold means champion, neon means category, and the two claims no
longer share a color system (deliberately not medal-amber either: medals mark a rank inside a
board, gold marks a board). Desktop shrinks from the 2-row monolith to a wide 2-column banner
(art left, champion plate right, one row tall); mobile goes full-bleed against the inset grid
(2px short of the screen edge so the side lamp strips survive), with the champion score on its
own line so the one string that must never truncate never does.
Tests: admin-ui 393 → 395.

## [2.70.0] — unreleased

**Integration release: info bubble + five approved refinements** (user field feedback, 2026-08-01).

- **Room-card 'i' info bubble** shows what a tournament allows — Engines and Hardware pills
  derived through the SAME shared module the submit sheet uses (extracted, not mirrored — the
  two surfaces cannot diverge), with 'This tournament allows' vs 'Available on' labeling, a
  narrowing note when rules removed options, and the admin's own `restrictedText` wording in
  amber (one-line backend addition; the picker keeps its axes-only contract). Lazy-fetched on
  first open; enlarged trigger (~27px chip, 44px hit target) on all three card styles.
- **Size trims per user feedback:** the bubble (~15% smaller footprint) and the Picks nav badge
  (16→14px) — both measured, both states preserved.
- **Friend-score privacy guard:** followers who cannot VIEW the origin room (approval rooms)
  receive neither the targeted feed event nor the Discord DM — open rooms short-circuit before
  any per-follower work. Closes the activity-leak the owner's Hoser Haven question surfaced.
- **turnToPick web push actually works now:** the type was already enabled (v2.32.0) but pushed
  a body that stranded the deadline; it now mirrors the v2.69 lobby copy ('N minutes before the
  runner-up gets the pick' / 'before autopick') derived from the real deadline. Also found and
  fixed: the runner-up pivot — the SHORTER window — sent no personal notification at all.
- Tests: backend 1310 → 1325, admin-ui 377 → 393.

## [2.69.0] — unreleased

**Pick-flow notifications** (user direction, 2026-08-01).

- **Picks nav badge**: signed-in players see a count badge on the Picks nav item when (a) a
  pending pick placeholder is waiting on them (urgent, magenta), (b) a tournament they've held a
  picker slot in has an empty queue (soft nudge, cyan — gated to players with pick standing so
  it never nags the uninvolved), or (c) their head-of-queue pick is cooldown-ineligible (reuses
  the activation path's own eligibility check — the badge cannot disagree with what activation
  will do). New lightweight `GET /:roomId/pick-alerts` (per-user rate-limited; probed on
  navigation like the Lobby dot, no polling loop). Fixed en route: a limiter mounted before
  `requireDiscordUser` was keying on IP while claiming per-user.
- **Public lobby pick-prompt**: when a winner must pick manually (placeholder creation — and on
  runner-up pivot), the lobby feed shows "*player*, pick the next game for *tournament*" with a
  live countdown. The deadline derives from new `src/utils/pickWindow.ts` — now the SINGLE
  source feeding TimeoutManager's enforcement, the ticker payload, and the feed event, so the
  countdown can't disagree with the actual timer. The copy is honest about what expiry means:
  "before the runner-up gets the pick" vs "before autopick" (a winner's lapse pivots to the
  runner-up; autopick only fires when that lapses too). Closed windows render "Pick window
  closed" rather than a stale countdown.
- Tests: backend 1283 → 1310, admin-ui 359 → 377.

## [2.68.1] — unreleased

**Card refinements** (user field feedback on v2.67.0): the game art fills the card top again with
the title overlaid (uniform 12px gutter on all four art edges; polarity-aware scrim + title
shadow tuned against busy artwork; pin leads the title with a 44px hit target), and the glitch
rings moved onto/outside the border where the neon tube lives (transparent-fill outline rings at
-3px/-5px inset, jump offsets cut to ±1-2px so artifacts hug the frame and spill strictly
outward; card no longer clips them). Tests: admin-ui 358 → 359.

## [2.68.0] — unreleased

**RetroAchievements on-demand game import** (product decision 2026-08-01: demand IS the approval
gate — bulk video-game imports retired as the acquisition strategy; v2.65's hardened IGDB path
stays dormant as a tool). Requires `RA_USERNAME` + `RA_API_KEY` (encrypted at rest) in Global
Settings — a free RA account's web API key. Inert until configured.

- **Master list:** `ra_games` shadow table (migration 132) synced per-console from
  `API_GetGameList?f=1` (achievement-set games only, ~10-15k rows; RA has no server-side search
  and mandates caching this endpoint — we sync-and-search locally). Super-admin sync button +
  lazy auto-sync (≤1/7d) with the v2.65 running/progress lifecycle; 20 RA consoles mapped to
  existing engines via `RA_CONSOLE_ENGINE_MAP` (RA Arcade includes Neo Geo).
- **Realtime import** from three surfaces sharing one component and one service path: the Global
  Scoreboard search — palette AND page empty-state — where any logged-in player can "Add to
  Arcaid" (guests get a login prompt; 5 imports/hour/user; `ra_imported_by` provenance recorded),
  the room-admin GameLibrary add-game flow, and a super-admin GlobalCatalogue panel.
  Import = 2-4 RA calls + art rehosted to `data/catalogue-images/ra/` → the game lands approved,
  engine-tagged, deduped by new `ra_id` external id (migration 133; an RA import onto an existing
  row ENRICHES it), and appears immediately as a categorized claim card — the player who added it
  can submit their score in the same visit.
- **Score-eligibility classification** from RA leaderboard metadata (`RankAsc` + the 14 Format
  values verified from RAWeb source): verdicts score > score_maybe > time > novelty > unknown;
  RA silence = unknown, still importable. Verdict hints render on admin surfaces only.
- **"Not score-eligible" flag:** new reason in the game report-a-problem flow, rendered
  distinctly (amber badge + filter) in the catalogue feedback queue with the importer's verdict
  alongside the reporter's claim. No auto-removal — super-admin reviews.
- API key scrubbed from all logged URLs; "Data from RetroAchievements" attribution on every
  search surface.
- Tests: backend 1199 → 1283, admin-ui 339 → 358.

## [2.67.0] — unreleased

**Neon card redesign** (user direction, 2026-08-01). The Global Scoreboard cards get their arcade
identity:

- **Category neon frames.** Each fidelity category has its own 80s/90s neon color — Real Machine
  magenta `#ff2e63`, Simulation cyan `#35d6e8`, Arcade-Style amber `#ffb020`, Video Games green
  `#00ff88`, Unspecified deliberately non-neon slate — applied as a visible card border + soft
  glow, with the category chip reading the same token so chip and frame are one system. Light
  polarity uses deepened variants (≥4.5:1 as chip text).
- **The borders glitch like the logo, out of sync.** Two compositor-friendly overlay rings
  (opacity/transform only, steps() keyframes, logo-cadence bursts every ~4–6s per card with
  multi-second quiet) whose delays/durations derive from an FNV-1a hash of the card id — stable
  across renders, verified distinct across cards. Fully frozen under prefers-reduced-motion.
- **Layout:** title moves to the top row, left-aligned right after the pin (44px hit target);
  art becomes an inset panel below it; type scales up hard (title 13→22px, players/scores
  11→16px, medals 12→18px).
- **Always-on podium:** every card renders gold/silver/bronze rows; unfilled ranks show the medal
  + "Claim this spot" wired to the submit flow (replacing the dashed "Claim 1st →" box); ranks
  4+ still render when present. Min height 218→330px token (podium floor makes ~422px real).
- Pinned rail tracks automatically; hero card unchanged.
- Tests: admin-ui 318 → 339. Backend untouched.

## [2.66.0] — unreleased

**Global Scoreboard declutter + "Real Machine" relabel** (user direction, 2026-08-01).

- Grid max 4 → 3 columns with double-width gutters; more padding around card titles and score
  rows; card footer is a contained strip (own fill + top border) at all sizes so the Submit
  button unambiguously belongs to its card; mobile gets doubled inter-card gaps + stronger card
  elevation (the field problem: Submit floating between cards). Hero span moved to `lg` only
  (full-width double-height in a 2-col band was a layout hole). The pinned rail tracked the new
  card widths automatically via the shared grid module.
- The `real` category renders as **"Real Machine"** everywhere (id `real` unchanged in SQL,
  URLs, params). Every surface already flowed through the label helpers — zero hardcodes found.
  The rename exposed a real tooltip bug ("Real Machine (Real Machine)" — engine name repeating
  the category) fixed generally: redundant category parentheticals are dropped.
- Tests: backend 1199, admin-ui 318 (all at baseline; label assertions updated).

## [2.65.0] — unreleased

**IGDB import hardened end-to-end.** Recon showed the arcade/video-game bulk import had never run
on prod and could not complete: an unscoped query (~200k games with PC included), an O(n²)
name-dedup scan (days of work at that scale), no rate-limit retry, no checkpoint, an unbounded
401 refresh loop, and four wrong platform ids in the mapping table.

- **Dedup is indexed now:** persisted `global_games.normalized_name` + index (migration 130,
  backfilled), name-walk skipped entirely when an external-id match already resolved the row;
  legacy NULL-key rows still scan so correctness never depends on the backfill. Hierarchy
  semantics unchanged — existing dedup suites pass unmodified.
- **The run survives reality:** exponential-backoff retry honoring Retry-After (429/5xx), one
  bounded 401 token refresh, keyset pagination with a per-page checkpoint on `sync_logs`
  (migration 131) and resume-on-rerun, `/games/count` denominator with `partial` status for short
  runs, a real `running` status + heartbeat + progress (page N/M) surfaced in the admin catalogue
  card, boot sweep marking stale runs `interrupted`, single-flight 409, live Twitch-credential
  probe before the 202.
- **Covers download in a background pass** (VPS pattern: concurrency 8, skip-if-exists, timeouts,
  progress logging) instead of serially inside the row loop.
- **Platform ids corrected against IGDB's documented list:** 86→TurboGrafx-16 (51 was actually
  Famicom Disk System — mislabeled as TG-16), 62→Jaguar (67 was Intellivision), 50→3DO (87 was
  Virtual Boy); 51/67/87 removed. A start-of-run `/platforms` verification WARNs on any future
  drift.
- **Fetch scope is deliberate:** arcade + 19 retro consoles; PC/Switch/Wii excluded from the
  crawl (kept in translation for multi-platform games). One commented const to widen.
- **Bulk rows land `pending`, not public.** The dead `searchAndImport` (zero callers, APIcalypse
  injection) is deleted; the CLI reimport script now decrypts credentials like the server does
  (it was sending ciphertext to Twitch — the likely cause of the historical "rate limit" failure).
- Tests: backend 1147 → 1199 (first IGDB suite), admin-ui 318.

## [2.64.0] — unreleased

**Scoreboard cards show the category chip only.** The second chip was the game's first catalogue
engine — game-level metadata identical on every one of a game's category cards, so a Simulation and
an Arcade-Style card both claimed e.g. "Future Pinball" as if the scores belonged to that engine
(field report: Creature from the Black Lagoon). The engine chip is removed; the category chip (and
v2.63.0's prospective-category chip on unambiguous zero-score cards) stays. The full engine list
lives on the card art's hover tooltip ("Available on: …", deduped). Zero-score cards with no
derivable category render no chip row at all. The hero card keeps its game-level engine pills
(deliberate — it is picked at game level; revisit if it reads wrong in the field).
Tests: admin-ui 316 → 318.

## [2.63.0] — unreleased

**Global Scoreboard feedback fixes** (user field-testing of v2.61.0/v2.62.0).

- **LIVE status line moved below the page description** — the header now reads lockup → subtitle →
  LIVE, instead of the status line interrupting title and description.
- **Category filters now include zero-score games via their catalogue engines.** A category chip
  previously matched only score-derived card categories, so a game with no scores vanished from
  every filter (e.g. "Simulation" showed 11 games — exactly the scored ones). Now a zero-score game
  matches a category when at least one of its catalogue engines (v2.62.0's engine list) belongs to
  it; multi-category games match each of theirs. Scored games' behavior is unchanged (`gs.id IS
  NULL` guards the new disjunct). When a zero-score game's engines are unambiguously one category,
  its claim card shows that category's chip (`prospective_category` — display-only; card identity
  and P4's coverage invariants untouched). Hardened along the way: malformed `platforms` JSON on
  any row would have 500'd every filtered request (`json_each` throws) — guarded with `json_valid`.
- **The global game page shows scores per category, never combined.** Cards from different
  categories still share one game page, but its leaderboard is now per-category: a tab strip when a
  game has boards in 2+ categories (biggest first), each scoreboard card deep-links to its own via
  `?category=`, bogus/absent params fall back to the largest board. No "All" tab on purpose — a
  rank across mixed engines is exactly the comparability claim ADR 0016 rejects. Response stays
  back-compatible for single-category games.
- Tests: backend 1126 → 1147, admin-ui 304 → 316.

## [2.62.0] — unreleased

**The catalogue speaks engines (ADR 0016's last gap).** `global_games.platforms` is now an engine
list; per-game availability facts (AtGames availability, VPX-standalone/manual-install, VR edition,
BAM requirement) moved to `features` — the column the AtGames cabinet variants already lived in.
This ends the last structural source of unknown-engine scores: an AtGames-only game previously
derived no engine, so its submissions auto-locked to Unspecified.

- **One fold, everywhere.** `foldCataloguePlatforms` implements the legacy→engines+features table
  once; migration 129 applies it to the stored catalogue and all seven importers + `upsert`/admin
  `update`/room `submit_to_global` route through it, so the next sync converges with the migration
  instead of re-polluting it (the fold is idempotent by construction — engine ids pass through via
  the taxonomy's new identity mappings).
- **Prod-rehearsed before shipping.** The migration was run against a copy of the production DB:
  4,262 rows, 3,260 folded, zero unmapped tokens after the rehearsal surfaced that `fx2` (5 rows —
  Zen FX2-era tables incl. Plants vs. Zombies and Ms. Splosion Man) deserved a `fx_classic` mapping
  rather than a drop. Only 3 rows remain engine-less, all pre-existing empty-platform placeholder
  rows.
- **AtGames games get the `atgames_native` engine** + `atgames` availability feature (product call,
  2026-08-01) — their submit picker now offers AtGames Native instead of locking to Unspecified.
- **Device-axis tournament rules match explicit availability only** — "must be available on
  AtGames" still means games actually tagged AtGames-available (now via features), never "any game
  whose engine could theoretically run there". An equivalence suite proves a legacy catalogue and
  its folded form admit identical games under identical rules, including the dominant production
  rule `required:['atgames']` (with `vpxs_manual` correctly kept in its match set).
- Engine ids became first-class taxonomy citizens (identity mappings; the `fx → pinball_fx`
  alias trap fixed on both BE paths and the FE library page). Engine chips render via the
  provenance display helpers; GameLibrary sorts by engine display label instead of raw JSON.
- Tests: backend 1015 → 1126, admin-ui 292 → 304.

## [2.61.0] — unreleased

**The light theme gets its glitch, and the Global Scoreboard gets its sign.** Two design packs
implemented as live animated CSS (the packs' PNGs are fallbacks only).

- **Animated light-theme logo.** `ArcaidLogoAnimated` gains a `variant='light'`: purple backdrop
  plate (position derived by pixel-measuring the reference export — plate at 17,210 on the 620×560
  sign canvas, pixel-identical to the pack render), three-layer glass-tube delta (bloom/core/
  filament), dark glyph shadows replacing the dark theme's cyan halo, glitch cyan darkened
  #5BC8F5 → #0F9BD1 so it holds on light surfaces, pinball rim + contact shadow. Chrome gradient
  unchanged. Glitch cadence is byte-identical to dark (the v2.45.6 keyframes; per-variant opacity
  via custom properties — a test asserts the keyframe blocks don't fork). The landing hero's light
  polarity now renders it in place of the static PNG, retiring the v2.56.0 "ACCEPTED LOSS: light
  mode has no glitch" note. Header `BrandWordmark` stays static in both themes, as before.
- **Global Scoreboard title lockup** (`GlobalScoreboardTitle`): neon three-layer trophy + layered
  chrome "Global Scoreboard" wordmark with pink/cyan fringe, slice-tear glitch, trophy
  flash/flicker; purple plate on light. Fonts self-hosted (Orbitron 400 added alongside the
  existing 900 — no Google Fonts request). One accessible `<h1>`; decorative layers aria-hidden;
  `prefers-reduced-motion` stops all of it. Fluid em-scaling off a container-query root: native
  902px lockup on desktop, fits 320px phones without wrap or overflow. Live-dot + "LIVE · updated"
  line and the subtitle (with its Log-in link) are kept, restyled to the pack's subtitle treatment.
- Tests: admin-ui 278 → 292. Backend untouched.

## [2.60.0] — unreleased

**Tournament rules on engine + device axes, and the iScored provenance lockdown (ADR 0016, phase 2 —
the final phase).** Tournament platform rules move onto the two provenance axes P1 introduced, and
iScored-synced scores are permanently excluded from the Global Scoreboard. See
`tmp/engine-device-p2-contract.md`.

- **One parser for `tournaments.platform_rules`.** The blob was parsed at 13 independent sites (the
  phase's risk inventory said 10 and the ADR said 11 — both corrected); 8 of them silently swallowed
  malformed JSON into "this tournament restricts nothing". All 10 runtime sites now route through
  `parseTournamentRules`, which logs a warning naming the tournament before degrading; the 3
  migration parses (101/083/089) stay deliberately raw as frozen legacy-shape transforms. One gating
  test per site, plus a mutation check proving each test actually fails when its site's rules are
  blanked.
- **Two-axis rule shape.** `{ engines: {required, excluded}, devices: {required, excluded} }`,
  axes evaluated independently and AND-combined; ADR 0009's semantics per axis are unchanged
  (`required` gates game eligibility only, `excluded` filters the submission picker only). The ~200
  rooms storing the flat legacy shape are lifted at read time via the same `LEGACY_PLATFORM_MAP` P1
  classifies scores with — both-axis ids (`vpxs` → engine `vpx` + device `atgames`) restrict both,
  and unrecognised room-invented tags are kept verbatim rather than dropped so no restriction
  silently widens. No stored row is migrated; rows upgrade on next admin save. Writes emit the new
  shape everywhere (Zod preprocess upgrades stale flat-shape POSTs rather than rejecting them).
  Known lossy lift, errs restrictive: legacy `excluded: [pinball_fx_vr]` ("no VR FX") now excludes
  all FX **and** all VR — independent axes cannot express the conjunction.
- **TournamentForm** renders two rule controls — Engines and Devices — each with the existing
  "Must be available on" / "Not allowed on" pair; conflict detection is per-axis (cross-axis
  combinations like "FX required, AtGames-device excluded" are valid configs, not contradictions).
  `SubmissionSheet` now honours explicit device exclusions in the picker.
- **iScored scores never reach the Global Scoreboard** (product decision 2026-07-31, recorded in
  ADR 0016). Synced scores are always `engine='unknown'`/`device='unknown'` — no inference from
  tournament rules, no per-tournament defaults (`tournaments.iscored_default_engine`/`_device` are
  vestigial and unread on both import paths: `ScoreSyncPoller` and
  `TournamentEngine.finalSyncScoresForGame`). `GlobalScoreService.fanOutFromRoomSubmission` takes a
  required `source` param and rejects `'sync'` at the service, so a future caller cannot reinstate
  the fan-out by accident. Synced scores stay fully visible on room leaderboards and tournament
  standings. **Consequence, intended:** a room running everything through iScored contributes
  nothing to the Global Scoreboard — a player who wants a score to count globally enters it in
  Arcaid. A regression-lock test also pins the poller's tournament-only INNER JOIN (pinned games
  are unreachable from sync).
- **Migration 128 purges the residue** now that nothing regrows it: sync-origin `global_scores`
  rows (identified by matching `score_history` `source='sync'` rows, with a NOT-EXISTS guard so a
  web submission sharing the same score value survives) and every remaining unknown-engine row
  across `score_history`/`submissions`/`community_scores`/`global_scores` (pre-GA wipe authorised
  by the product owner 2026-07-31). Orphaned `score_reports` are removed and both leaderboard
  caches busted; per-table counts are logged at deploy. The Global Scoreboard's "Unspecified"
  card likely goes empty as a result and is **deliberately kept** — it is the safety net ensuring
  scores without a matching card never silently vanish (P4's founding bug).
- Tests: backend 951 → 1015, admin-ui 263 → 278.

## [2.59.0] — unreleased

**Per-category cards on the Global Scoreboard (ADR 0016, phase 4).** The request that started this
arc: a game with scores from different kinds of platform now gets **one card per category**, each
with its own leaderboard, and every score already tagged with its exact engine and device (P3).
See `tmp/engine-device-p4-contract.md`.

Bands: **Real · Simulation · Arcade-Style · Video Games · Unspecified**, derived from engine alone.
A game with scores on `vpx` and `vp9` gets one Simulation card; a game with `vpx` and `fx` scores
gets two.

- **`unknown` engine gets a visible "Unspecified" card, and this is the point of the phase.** 38 of
  67 production global scores have `unknown` engine — the irreducible AtGames ambiguity. Had cards
  existed only for the three real fidelity bands, **the majority of scores would have had no card and
  silently disappeared from the site.** A test asserts the union of a game's cards contains every one
  of its scores exactly once, that no score lands on two cards, and that the per-card counts sum to
  the game's total. Unspecified is styled as visibly *not* a peer of the real bands — it makes no
  comparability claim.
- The category `CASE` expression is **generated from `CANONICAL_ENGINES` at query-build time**
  (`utils/engineCategorySql.ts`), so SQL never becomes a fourth copy of the taxonomy (the parity test
  has already caught one real drift). Engine ids are interpolated behind a token guard;
  caller-supplied categories stay bound.
- `score_count`, `top_score`, `last_submitted_at`, `popularity`, `top_scores`, `my_rank`, `my_score`
  and `neighbors` are all **per-category** — a viewer can be 3rd on Simulation and 9th on
  Arcade-Style and sees each correctly. The best-per-player collapse happens *within* a category, so
  a player's FX score is ranked on the FX board even when their VPX score is higher. `total` and the
  "Showing N of M" copy now count **leaderboards**, not games.
- **Pagination needed a real fix, not a rename.** `gg.name` was never a unique sort key and is now
  doubly non-unique (one game, several rows), so pages could duplicate and skip cards at boundaries.
  Every sort now ends in `gg.id, category`, and `total` lost its fast path to count the same grouped
  subquery the data query walks. Tested by paging across a mid-game boundary and again under a sort
  where every key is tied.
- Platform-group chips are replaced by **category chips** — the groups were the taxonomy this
  supersedes. The ⌘K palette still searches **games** (new `groupBy=game`): a game matches if any of
  its cards would. Pins and the hero stay **game-level**: pinning any card pins the game, the rail
  shows one entry per game, and the hero keeps A5a's threshold logic untouched (though its rows are
  scoped to one category, because a champion line mixing engines is precisely the claim the ADR
  forbids).
- A zero-score game still renders **one** uncategorised card with the `Claim 1st →` CTA. That falls
  out of the existing LEFT JOIN producing a NULL category — not a special branch, and deliberately
  not "Unspecified", which would claim scores of unrecorded provenance that don't exist.

Known, recorded rather than fixed: `score:new:global` carries no engine, so the optimistic client-side
bump increments every card of a game. Correct before P4, visibly wrong now; self-heals on next fetch.

## [2.58.0] — unreleased

**Score reads move onto engine + device, and fidelity categories arrive (ADR 0016, phase 3).**
Phase 1 (v2.53.0) shipped the taxonomy and every write path; reads still went through the legacy
`platform` column that writers maintained in parallel. That half-migrated state is now closed.
See `tmp/engine-device-p3-contract.md`.

- **Fidelity categories** derive from **engine alone**, never device: Real · Simulation ·
  Arcade-Style, with video-game engines outside the axis. **`unknown` engine yields no category and
  renders as "Unspecified"** — 63 of ~120 production score rows are the irreducible AtGames
  ambiguity, and filing those into a band would assert something the data cannot support.
- **Scores now display engine primarily and device secondarily** on the surfaces that actually carry
  per-score provenance (`GameDetail`, `GlobalGameDetail`). A score reads "VPX · AtGames", which is the
  distinction the whole ADR exists to make. Where a device adds nothing (`real` on `real_cabinet`) it
  is suppressed rather than shown as noise.
- The card/quick-view chips were **not** given per-score tags: those render the *game's* catalogue
  platform list, not a score's provenance, and adding tags to dense rows would have been a layout
  change. They moved onto the engine/device vocabulary instead, so `vpxs` reads "Visual Pinball X"
  once rather than appearing twice.
- `?engine=` and `?device=` added to the leaderboard route; **`?platform=` kept as a deprecated
  alias** so existing bookmarks and link previews keep working.
- **The legacy `platform` fallback was removed deliberately**, not kept "just in case": migration 125
  backfilled every pre-existing row and asserts a zero-NULL post-condition, so no row is reachable
  via `platform` that isn't reachable via `engine` — a fallback could only reintroduce the unfolded
  compare below. The column itself stays; tournament rules still read it until phase 2.
- Migration 127 busts both leaderboard caches, which embed provenance in serialized JSON.

**Three live bugs fixed in passing**
- The platform tab strip alias-folded its labels while the filter did a raw `UPPER()` compare, so a
  tab could be offered and then match zero rows. Both now read the same columns, which removes the
  class of bug rather than the instance.
- `gg.platforms LIKE '%vpx%'` also matched `vpxs`, and `'%pinball_fx%'` silently swept in FX Classic,
  Midnight and VR. Now exact `json_each` membership, expanded to engine-equivalent tokens first so
  nothing that qualifies today stops qualifying.
- `RoomScoresService` selected `platform` and never projected it, so room-card previews showed none.

**Also:** the BE↔FE taxonomy parity test had a hole — every assertion named specific exports, so a
new one-sided export passed unnoticed. It now asserts the full export-name set, closing exactly the
failure the test exists to prevent.

## [2.57.0] — unreleased

**The Global Scoreboard gets a hero card, a Top 6 / My Score density toggle and a live indicator.** Track A phase A5a; see `tmp/global-scoreboard-a5a-contract.md`. The Grid/Compact table layout and pinned-game rank alerts are deliberately NOT here — they are A5b and stay isolated.

- **Hero card, with one deliberate deviation from the design.** The handoff selects the hero as "most scores in the trailing 7 days" and stamps it `HOT` + `+{n} scores this week`, unconditionally. Checked against production: in a representative trailing week ONE game had 5 scores and three others had exactly 1. Applied literally, a quiet week crowns a single-score game and calls it trending. So `GlobalLeaderboardService.getHeroGame` only awards the badge when the weekly leader clears **`HERO_MIN_WEEKLY_SCORES` (3)** — a named constant carrying that reasoning, tunable as the community grows. Below the floor the hero falls back to the highest `score_count` game in the same view and renders **neutrally: no HOT badge, no weekly delta**. With no scored game in the view at all there is no hero and the page is a plain grid. `is_hot` gates both the badge and the weekly line client-side, so the neutral hero cannot leak a heat claim.
- **`hero` is one additive key on `/api/global/scoreboard`, page 1 only.** `offset > 0` omits it entirely rather than sending null — it is one card at grid position 1, and computing it per "Load more" page is work nobody renders. It respects the same platform-group / room-scope / search filters as the grid **by construction**: `buildCatalogueFilters` was extracted out of `getTopGames` so both build their WHERE/JOIN from one place, rather than a second copy that drifts. The trailing-window count is a conditional `SUM` over the LEFT JOIN that query already performs (`global_scores.submitted_at` — there is no `created_at` on that table), ordered and `LIMIT 1`; no new index. The hero rides along in the id list used for `top_scores` / viewer-rank / pin lookups, so it carries `is_pinned`/`my_rank`/`my_score`/`neighbors` for an authenticated viewer even when it isn't on the requested page, at no extra round-trip. The anonymous per-row payload is unchanged — asserted.
- **Top 6 / My Score flips client-side with zero data fetches.** That is the whole reason `neighbors` shipped early in A4; a round-trip per toggle makes the control feel broken. `planRows` (exported from `GlobalGameCard.tsx`) resolves the rendered ranks from `top_scores` + `neighbors` and derives the break line from actual rank gaps rather than special cases — so ranks 1-3 and rank 4 come out as a contiguous 1-5 with no break, rank 5 as 1-6, and only a genuine gap draws the dashed `· · ·`. A viewer with no score on a game gets the podium plus a dashed `NO SCORE YET` / `#{n} needs {score} to qualify` prompt; a board with fewer than 6 scores shows all of them in either mode. **Top 6 rendering is byte-identical to A4** — the "You"/"Next" highlighting is `mine`-only, because quietly adding a badge to the default mode would be an unannounced visual change. The toggle is hidden entirely when logged out.
- **Density persists via `/api/me/scoreboard-preferences` under the namespaced `global_density` key** — never `/api/me/preferences`, which is theme-only, admin-scoped, and would 400. `localStorage` paints instantly, the server preference reconciles on mount (the `ThemeProvider` two-tier pattern). The write is fire-and-forget: the UI never waits on the network to change what it draws.
- **Live indicator** — a magenta filled `Circle` beside the `h1` reusing the existing `.pulse` class (`index.css` already nulls it under `prefers-reduced-motion`, so no new guard), plus a `LIVE · updated {n}s ago` line driven off the last `score:new:global` event and falling back to the initial fetch. The design's `{total} games · {playerCount} players` line is **deliberately not shipped**: there is no player-count API and inventing one is out of scope. For the same reason the hero's eyebrow reads `{n} scores`, not `{n} players`.
- **Tokens, not literals.** Five new `--sb-*` entries (`--sb-row-next-bg/-border`, `--sb-hero-border`, `--sb-hero-glow`, `--sb-hero-score-glow`) with light-polarity overrides — the light hero drops the cyan bloom for a neutral elevation shadow, since a cyan glow on white reads as a rendering artefact. `GlobalHeroCard.tsx` ships zero literal `rgba()`.
- Tests: +11 backend (`global-hero.test.ts` — above/below threshold, no-scored-game and no-match views, platform and search filters, `hero` absent past page 1, the additive-key assertion, authenticated hero context including a hero that fell off the page, and room scope) — 887/887. +17 admin-ui (`GlobalScoreboardA5.test.tsx` — hot vs neutral hero, no hero, no duplicate hero row, hero pin gating; toggle hidden logged out, **zero data fetches on flip**, the namespaced preference write and its hydration, and all four density edge cases; live dot `.pulse` class and the counter resetting on a simulated socket event) — 233/233.

## [2.56.0] — unreleased

**The room-level pick-award gate is gone, and the landing page follows light mode.** Two unrelated workstreams; see `tmp/pickaward-landing-contract.md`.

- **Winner-picks is per-tournament only.** A live tournament configured with *Winner picks next game* ✓, a 60-minute winner window and a 30-minute runner-up window auto-picked immediately and the winner never got to choose — he got the "you won" push, then nothing. Root cause: `PickAwardGate.isEnabled()` resolved `room AND tournament`, and the room-level `ENABLE_GAME_PICK_AWARD` setting was **absent** (→ `false`) for that room. The key appeared only in `Settings.tsx`; `TournamentForm.tsx` never referenced it, so the tournament form presented live-looking pick controls that a room switch silently disabled. `tournamentWin` isn't gated by it but `turnToPick` is — hence congratulated-then-nothing. The room leg is removed rather than fixed: it was pure redundancy with `tournaments.winner_picks`, and a second switch that isn't shown next to the first is a trap, not a feature.
- **Room-scoped callers keep working, and keep meaning something.** The Picks nav tab, the Mystery Award page and the admin disabled states ask "is this flow live for this room at all?" with no tournament id. That now resolves as **"any tournament in this room has winner-picks on"** — deliberately not a blanket `true`, so a room that has turned winner-picks off everywhere still renders the disabled states it did before. `TournamentService.create` joined `update`/`setActive`/`delete` in busting the gate cache, since creating a room's first winner-picks tournament can now flip the room-scoped answer.
- **The class doc comment was the other half of the bug.** It documented the deleted override semantics ("both room and per-tournament must be truthy", "a room-level off cannot be re-enabled per-tournament") as if they were desirable. It now states the per-tournament rule, the room-scoped rule, and why the room leg was removed.
- **Migration 126** deletes the orphaned `game_room_settings` rows (`src/database/migrations/dropEnableGamePickAward.ts` — a handler rather than raw SQL so the removed count is logged and the delete is unit-testable). Blast radius verified on prod first: 5 rooms, exactly one setting the key (to `'true'`), four with it absent, **none** setting `'false'`, and all 9 tournaments on `winner_picks = 1`. Four rooms begin honouring the winner-picks their admins already configured — the intended fix, not a regression. The Discord gating reply and the web `/pick-game` 403 were reworded off "in this game room", which sent admins hunting for a room toggle that no longer exists.
- **Landing page light mode (B).** The page never followed the light theme A1 introduced in v2.50.0. Three fixes, dark appearance unchanged in all three. **(B1)** `ScoreboardPromo`/`ScoreTickerCard` were entirely inline-styled dark and consumed none of the token system — which is exactly why they stayed dark. They now read from 18 new `--sb-motto-*`/`--sb-ticker-*` tokens with light-polarity overrides, and ship **zero literal `rgba()`**; the score pill reuses the existing `--sb-pill-bg` (same on-arbitrary-artwork problem the Global Scoreboard card already solved), and the local initials/hue-hash avatar duplicate is replaced by the shared `PlayerAvatar`, so anonymous rows get the themed silhouette here too. The no-artwork tile keeps its per-player hue; only saturation and the two lightness stops flip with polarity. **(B2)** The hero's `ArcaidLogoAnimated` is a CSS/SVG recreation whose own doc says it assumes a near-black backdrop (#0C0C13), so it cannot work on `#E8EAF0` — light polarity renders `/arcaid-logo-light-v1.png` instead, boxed to the same 620×380 aspect ratio the animated wrap reserves so page layout below the hero is identical in both polarities. **Accepted loss: light mode has no glitch animation** — the logo package shipped no animated light source, and re-authoring it is a rebuild of the component against six documented differences, not a re-tint. **(B3)** The motto was `rgba(255,255,255,0.72)` with a cyan glow, near-invisible on light. It becomes `#6427af` — the logo backdrop plate's own hue and saturation (HSL 267°, 63.5%, measured off the plate's lightest stop `#4A1D82`) lifted from 31% to 42% lightness, **7.12:1 on `#E8EAF0`** against the 4.5:1 bar. The raw plate stops score 9.8–15.5:1 but are too dark to read as a colour at all. The cyan glow is dropped outright in light rather than re-tinted.
- **Known, deliberately out of scope:** `RoomCard`/`CreateRoomCard` further down the landing page are still inline-styled dark. They are outside B1's scope and are their own conversion.
- Tests: +12 backend (`pick-award-gate.test.ts` — the reported bug asserted directly through the real `runMaintenance` → `processSlotMaintenance` path, `winner_picks = 0` suppression, a leftover `ENABLE_GAME_PICK_AWARD=false` row proving the room leg is gone, the four room-scoped cases including no-tournaments-is-false and no cross-room leak, and migration 126's delete + idempotency) — 876/876. +11 admin-ui (`LandingPage.polarity.test.tsx` — hero swaps per polarity, no literal `rgba()` in the ticker band or any styled node inside its tiles, `--sb-ticker-*` tokens on the tile surface, `PlayerAvatar` in place of the initials chip, motto reads tokens in both polarities, plus stylesheet-level guards that every landing token exists in the dark defaults AND is overridden in the light block, that the dark motto is byte-identical to pre-v2.56.0, and that the light motto clears 4.5:1 on `--color-deep`) — 216/216.

## [2.55.0] — unreleased

**My Pins becomes a carousel of real cards.** User feedback on v2.52.0's pinned rail: the 220px chips should be full-size cards identical to the grid below, cycling like the landing-page ticker but only when they actually overflow, and one card per swipe on mobile. See `tmp/pinned-carousel-contract.md`.

- **The card is now one component, two callers.** `GameCard` + `LeaderboardRow` moved out of `pages/GlobalScoreboard.tsx` into `components/GlobalGameCard.tsx`; the grid and the pins carousel both import it. This is the mechanism, not a tidy-up — "the pinned cards look the same as the grid's" is only durably true when they are literally the same component. Rendering is unchanged; the one addition is an optional `badge` slot (the carousel's rank-delta pill) that renders nothing when absent. Grid layout constants (`GRID_CLASS`, `GRID_COLUMNS`, `GRID_GAP_PX`, `gridColumnsAt`) moved to `lib/globalGrid.ts` so the carousel derives its card width from the SAME column counts the grid uses rather than a second number that would drift.
- **`components/PinnedCarousel.tsx`** replaces `PinnedRail.tsx` (deleted), keeping the amber section chrome, the "MY PINS — N games watched" header, the trailing dashed add tile (still opens the ⌘K palette), the zero-pins-hides-the-section rule, and the optimistic unpin. Motion is gated, not decorative: **auto-cycle runs only when the cards overflow the container** (measured via `ResizeObserver` on both the container and the single content copy) — when they fit it renders a plain static row with no animation and, crucially, **no duplicated list**. When it does overflow it uses the landing-page technique (duplicate once, `translateX(0)` → `translateX(-50%)`, `linear infinite`) at a constant 40px/s so more pins travel no faster. Each item carries its 14px gutter as `margin-right` rather than a flex `gap`, which makes one copy exactly half the track and the wrap seamless (the landing ticker's half-gap hitch).
- **Pause is required here, not optional.** These cards carry Submit buttons, pin toggles and links, so the marquee pauses on hover, on focus-within, and while touched. `prefers-reduced-motion: reduce` disables the auto-cycle entirely and leaves a manually scrollable row (scoped inline `<style>`, per `LandingPage.tsx`/`TourOverlay.tsx`). The duplicated copy is `aria-hidden` with every focusable node forced to `tabIndex=-1`, so keyboard and screen-reader users meet each pin exactly once — mouse clicks on it still work (`inert` would have killed those, which is the failure hover-pause exists to prevent).
- **Mobile (<640px) never auto-cycles.** One full-size card per view, native `scroll-snap-type: x mandatory` + `snap-center`, no JS drag handling. Auto-advancing under a reader's thumb is worse than useless.
- **Pins payload carries what the card renders.** `GlobalPinService.list()` returns `top_scores` (the first **6** rows from the same batched `getTopScoresForGames` the grid uses) and `neighbors` (ranks my_rank±1) — the latter only for pins where the viewer ranks below those six rows, i.e. the only case the card appends its "YOU" row, so no leaderboard read is spent on a row that never draws. The champion-only `top_player` field is **removed**, not kept alongside: two representations of one dataset is how the rail and the grid drift apart.
- **Known cost, flagged rather than solved:** full cards are ~2.7× the height of the old chips (≈167px → ≈454px of section at 1440×900), so the search field and the grid sit ~287px further down the page. That is inherent to the request; no collapse affordance or height cap was added on our own initiative.
- Tests: +2 backend (`top_scores` capped at 6 with the card's entry shape; `neighbors` present only below rank 6) — 864/864. Admin-ui 205/205: the 5 `PinnedRail` tests are replaced by 14 `PinnedCarousel` tests (fits → no animation and no duplicate; overflows → animation with exactly one duplicate; duration scales with content width; reduced-motion off; hover/focus/touch pause; duplicate `aria-hidden` + untabbable; mobile snap row; zero pins hidden) plus 3 new page-level tests (rail renders a full card from `top_scores`; unpin-from-rail drops the card without a refetch; failure restores it and toasts).

## [2.54.0] — unreleased

**Username lock + identity-resolved score reads.** A logged-in player can no longer choose a per-submit username, and the score-history/community read paths now resolve names through the identity layer. Fixes the field-reported inconsistency where a Discord-logged-in user who typed a fake name into the submit modal saw their canonical name on the leaderboard card but the fake name on the ticker and the "All Score History" list (the leaderboard partitions by `submitted_by_user_id` + joins `user_profiles`; the history reads shipped raw `iscored_username` with no join), and closes the community-leaderboard rank-takeover where one user could hold multiple ranks under different typed names. Re-implementation of PR #130 against the post-ADR-0016 baseline; see `tmp/username-lock-contract.md`.

- **Server-side username lock.** New `UserProfileService.resolveSubmitName({discordUserId, roomId?, jwtUsername?})` — resolution order: already-claimed name in scope (room scope → `room_members.display_name`; global scope → first `user_mappings` alias) → `user_profiles.display_name` → JWT `username` claim → raw id; whitespace-only values treated as absent. Applied in the three web submit handlers in `rooms.ts` (`/submit-score`, `/freeplay-score`, `/community-scores`) via a shared `resolveSubmitUsername` helper that returns a discriminated union, matching the shape ADR 0016 Phase 1's `ensureProvenanceAllowed` established — no "null means allowed". An authenticated submitter's posted `username` is DISCARDED (guests unchanged — free-text + first-claim-wins is deliberate for them; a guest with no name still 400s in-handler). Downstream (`resolveAndClaim` suffixing, iScored sync, fan-out) untouched — it just receives the canonical name. Zod: `username` is now `.optional()` on the three room submit schemas since an authed client may legitimately omit it; the required `engine`/`device` provenance fields are unaffected.
- **Global submit (`POST /global/scores`)** ignores the `displayName` body field entirely. `GlobalScoreSubmissionSchema` no longer declares it, so an older client still posting one has it silently stripped rather than rejected — including values that would have failed the old 50-char cap. The name comes from `resolveSubmitName`; the `user_mappings` alias claim now only ever registers a canonical name — pre-lock it registered whatever the user typed as a PERMANENT alias of their account. The old `409 "display name already taken"` is gone (a dead end now that the modal has no name field): when the resolved name is another account's alias — only reachable via the JWT-username fallback — the alias write is skipped with a log line and the submit proceeds (cosmetic; global partitioning is by `submitted_by_user_id`).
- **FE username lock (`SubmissionSheet.tsx`).** Authenticated viewers (Discord or Google — both land in `ViewerAuthContext.discordUser`; `!!playerToken` is the gate) get a read-only "Playing as **X**" chip instead of the name input, plus a "change your display name in settings" link to `/account/settings`. The client no longer posts a name at all for an authed submitter, and the submit gate no longer requires a local name from them. The pre-submit name-collision prompt (v2.2.5) is skipped for authed viewers — the server resolves suffixing and the success card shows the final `displayName`. The form keeps ADR 0016's engine + device pickers below the name row, including the `arcaid_last_device` memory. Guest flow unchanged, including the on-screen-keyboard wiring. Known cosmetic edge: right after a fresh login the chip can show the provider name rather than a just-set display name (the JWT `username` claim only picks up `user_profiles.display_name` at token refresh) — the server still resolves correctly.
- **`display_name` on history reads.** `ScoreHistoryService.getGameHistory`/`getGameSubmissions`/`getPlayerGameHistory` and `CommunityScoreService.getGameHistory`/`getRecentActivity` now ship `display_name` via the standard `user_mappings` → `user_profiles` join. The FE was already ahead — `GameDetail.tsx` declared the field and rendered `display_name || iscored_username` throughout; only the BE columns were missing.
- **Community leaderboard identity collapse.** `CommunityScoreService.getGameLeaderboard` was the last leaderboard partitioning by raw name (`GROUP BY LOWER(iscored_username)`). Now collapses by the three-leg key (`COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))`): one rank per user, `iscored_username` = the best-score row's alias (ROW_NUMBER window, ties broken oldest-first), `times_played`/`last_played` aggregated across all aliases, `display_name` joined. New `player_key` response field; `GameDetail.tsx` keys rows on it.
- **Known remaining vectors (deliberate deferrals, see ROADMAP):** the guest-draft commit path (`POST /submission-drafts/:stateParam/commit`) still commits under the name typed while a guest before the OAuth handoff — entangled with the self-claim merge sweep; and guests under multiple typed names still can't be auto-collapsed (identity unknown — admin merge remains the remedy).
- Tests: +19 backend (5 `resolveSubmitName` unit cases in `UserProfileService.test.ts`, 14 route/read cases in the new `username-lock.test.ts` covering the lock on all four submit routes, the unchanged guest flow, the identity-resolved reads, the leaderboard collapse, and an ADR 0016 engine/device regression guard) — full backend suite 862/862 (843 + 19); admin-ui suite unchanged 193/193.

## [2.53.0] — unreleased

**Engine + device score provenance, phase 1 (ADR 0016).** One `platform` field was answering two
different questions — *what produced this score* (which decides comparability) and *what it ran on*
(provenance). AtGames made that untenable: one cabinet runs VPX, Zen FX, Zaccaria and AtGames-native
tables, so `atgames` says nothing about whether two scores are comparable. Phase 1 splits the axes,
migrates the data, and makes every write path record both. **Read paths are deliberately untouched and
still use `platform`** — the only thing players see is the submission form asking two questions instead
of one. See `docs/decisions/0016-engine-device-score-provenance.md` and
`tmp/engine-device-p1-contract.md`.

- **New taxonomy** `src/utils/scoreProvenance.ts`: `CANONICAL_ENGINES` (with fidelity category),
  `CANONICAL_DEVICES`, `ENGINE_DEVICE_COMPAT`, and `LEGACY_PLATFORM_MAP` covering every old platform id
  plus the alias and uppercase spellings present in prod. `vpxs`/`vpxs_manual` collapse into the `vpx`
  engine, `bam` into `fp`, and every `*_vr` id decomposes into engine + `vr_headset`. `'unknown'` is a
  first-class value on both axes and is **never** stored as NULL.
- **The FE mirror now has a parity test that fails on drift** (`scoreProvenance-parity.test.ts`), which
  deep-compares ids, labels, the compat map, the legacy map and the derived function behaviour. The
  previous mirror pair (`platformMapping.ts` ↔ `platforms.ts`) had no such test and had silently rotted
  to 22 of 53 aliases.
- **Migration 125** adds `engine`/`device` to `submissions`, `score_history`, `community_scores`,
  `global_scores` and `submission_drafts` (plus `tournaments.iscored_default_engine`/`_device`), with
  indexes mirroring the existing `(game, platform)` shape, and backfills through the legacy map with a
  case-normalised lookup. `platform` is **not** dropped. Post-condition asserts zero NULLs.
- **Every write path records both**, including the four that previously dropped provenance entirely
  (`syncstate.ts` ×2, the `admin.ts` global-backfill ×2 — the latter now carries the source row's
  provenance across instead of writing nothing).
- **Both submission-draft commit paths now validate.** Previously neither re-checked anything, so a
  stale draft could write a combination the direct submit routes would have rejected.
- **`ensurePlatformAllowed` is retired.** It returned `null` to mean "allowed", so a partially-validated
  result was indistinguishable from success. Replaced by `ScoreProvenanceService.validate`, which
  returns a discriminated union — an unvalidated axis cannot fall through as `ok: true`.
- **One upsert rule.** The sync writers COALESCE-preserved `platform` while `/submit-score` overwrote
  it. Both new columns (and `platform` in the Discord path) now use COALESCE-preserve everywhere, with
  `NULLIF(excluded.engine, 'unknown')` so a re-sync's placeholder can't clobber provenance a player
  supplied.
- **Submission UX:** engine first, device filtered by `ENGINE_DEVICE_COMPAT` and auto-locked when only
  one fits, and the player's **last device is remembered in localStorage** and pre-selected when
  compatible — the launch community is AtGames-first and must not re-pick "AtGames" every time. Copy is
  "Played on" / "Device"; the word "platform" is gone from the new UI.
- **Discord `/submit-score`** gains `engine` and `device` options **with autocomplete** (`platform` had
  none, so users had to type raw canonical ids and the command mostly rejected and asked for a re-run),
  each auto-filled when only one option is valid. It also now unions the room's game tags when resolving
  what's submittable — previously a room-tagged platform worked on web and was rejected in Discord.
- `POST /api/global/scores` moved from hand-rolled inline parsing to a Zod schema.

Tests: backend 817 → 843, admin-ui 184 → 193.

---

## [2.52.0] — unreleased

**Global Scoreboard pins + per-viewer rank context (phase A4).** Players can pin games, see a My Pins
rail with their standing on each, and see their own row on any card where they've scored. See
`tmp/global-scoreboard-a4-contract.md`.

- **Migration 124** `global_game_pins`. The design handoff's DDL referenced `global_games(global_game_id)`,
  a column that does not exist — the primary key is `id`. Because foreign keys are enforced and SQLite
  only reports a bad FK at INSERT time, that would have migrated cleanly and failed on the first
  production pin; the test inserts a real row rather than trusting the migration to run.
- `GET /api/global/pins`, `POST`/`DELETE /api/global/games/:id/pin` (idempotent, rate-limited). Pins are
  unlimited.
- `/api/global/scoreboard` gained `optionalDiscordUser` — it was a fully public route, so the obvious
  auth middleware would have broken anonymous browsing. Authenticated requests get `is_pinned`,
  `my_rank`, `my_score` and `neighbors`; **anonymous responses are byte-identical to before**, asserted
  by test. `pinned_at` is omitted from the SQL entirely when anonymous rather than selected as NULL.
- Pin lookup is a correlated subquery, not a LEFT JOIN — the query groups by game, so a join would have
  inflated `score_count`/`popularity` on pinned rows. Guarded by test.
- `neighbors` is only computed for games the viewer has actually scored on; doing it for every row would
  recalculate every cold leaderboard cache on a single authenticated page load.
- `sort=pinned` (default when authenticated) degrades to `popular` for anonymous requests.
- **Rank-delta sign:** the handoff states both `last_known_rank - my_rank` *and* "negative = improved",
  which are mutually exclusive. Implemented as `my_rank - last_known_rank`, keeping the stated
  semantic the UI consumes.

**Two Global Scoreboard fixes (user-reported):**
- Platform pills on card art now use a semi-opaque fill instead of a 6% white tint, which vanished over
  bright or busy backglass art.
- Room badges sit immediately after the username instead of being pushed to the far right edge — the
  name span carried `flex-1`, which visually detached the badge from the player it belongs to.

Tests: backend 804 → 817, admin-ui 168 → 184.

## [2.51.0] — unreleased

**Global Scoreboard search palette (phase A3).** ⌘K / Ctrl+K anywhere on `/scoreboard` opens a
command palette over the full catalogue — the critical path for "I just played this, post my score"
across 2,400+ games. See `tmp/global-scoreboard-a3-contract.md`.

- **Palette** (`admin-ui/src/components/GlobalSearchPalette.tsx`) owns the page's existing search
  field rather than adding a second input. `↑`/`↓` navigate with wrap, `↵` opens the submission sheet
  for the selected game, `⌘↵` opens its detail page, `Esc` closes and returns focus to the field. The
  grid behind dims and goes inert. Selection tracking writes `scrollTop` directly — never
  `scrollIntoView`, which would scroll the page.
- **Search understands years and multiple terms.** `"stern 1995"` now ANDs a manufacturer match with
  a year match; single-token queries are byte-for-byte unchanged. A 4-digit token only counts as a
  year inside 1900–2099, and a year token *widens* rather than narrows — so *Pinball 2000* (a 1999
  title) and *1942* still match on name. One parameterized statement; no interpolation of user input.
  Manufacturer matching already existed — the design handoff was wrong that it needed building.
- Palette respects the active platform filter and room scope; reuses the page's 300ms debounce
  (5 keystrokes → 1 request); logged-out `↵` reveals both login providers rather than assuming one.
- 7 new palette tokens with light-theme overrides — zero literal rgba in the component, so the
  palette works in light mode. Caret blink is disabled under `prefers-reduced-motion`.
- Accessibility: `role="combobox"`/`listbox`/`option` with `aria-expanded`/`controls`/
  `activedescendant`/`selected`. `⌘K` is ignored while focus is in another text input.

Tests: backend 798 → 804, admin-ui 158 → 168.

## [2.50.0] — unreleased

**Global Scoreboard redesign, phase A1 + A2** — token foundation and the rebuilt card. First phase of
the Scoreboard Appearance Overhaul; implements the Claude Design handoff with the corrections recorded
in the approved plan (the handoff's Discord-only copy, "ArcAid" casing, platform-group labels-vs-keys,
and its dark-only assumption were all wrong for this codebase). See `tmp/global-scoreboard-a1a2-contract.md`.

**A1 — token foundation**
- Theme-aware `--color-medal-silver` / `--color-medal-bronze` with light-polarity overrides (flat hex
  silver fails contrast on white), plus a set of `--sb-*` surface tokens (art/hero scrims, hover border,
  title shadow, per-rank row tint + border). No literal `rgba(0,0,0,…)` in the new components — this is
  what makes light mode a side-effect rather than a retrofit.
- **Global pages now follow the visitor, not an admin setting.** `/scoreboard`, `/catalogue`, `/games/*`
  and the landing page resolve light/dark as: explicit visitor choice → `prefers-color-scheme` → dark,
  with a sun/moon toggle in both global headers and an OS-change listener that detaches once the visitor
  chooses. `GLOBAL_PAGE_THEME` is **deprecated, not deleted** — the control remains with a note for one
  release.
- `BrandWordmark` swaps the logo by polarity. The light asset is still pending, so light mode currently
  shows the dark wordmark; the swap is a one-line change once the artwork lands (spec is in the component).

**A2 — card rebuild**
- Art-first card: artwork block with the title overlaid on a scrim, one platform pill, rows 1–6 with
  Medal icons for the top three, room-origin badges retained, and a solid Submit button in the footer.
- **No podium and no placeholder rows** — a game with one score renders exactly one row; a game with none
  renders a dashed `Claim 1st →` prompt instead of empty medal slots.
- Sort pills replace the sort `<select>` (horizontally scrollable on narrow screens); `StarRating` comes
  off the cards and remains on `GlobalGameDetail`.
- Shared `lib/catalogueImage.ts` replaces the `imageFor`/`toCatalogueUrl` helper that was duplicated
  across three files.

Out of scope this release (later phases): pins and the pinned rail, the hero card, ⌘K search palette,
density toggles, and rank-change alerts.

Tests: admin-ui 146 → 158.

## [2.49.1] — unreleased

**Room-ban UI relocated to the room-admin area.** UI-only move, no API changes. See `tmp/members-admin-move-contract.md`.

- v2.49.0 put Ban/Unban controls on the PUBLIC `/:slug/members` page behind a cosmetic client-side admin check (`resolveViewerClaims` decoding the player/admin JWT). The bans endpoints (`GET/POST /api/rooms/:roomId/admin/bans`, `POST .../admin/bans/:banId/lift`) were and remain properly gated server-side (`requireAuth + requireRoomAccess`), so no data was ever exposed — but admin controls belong in the admin area, not a public page, and the user went looking for them in room-admin settings and couldn't find them.
- New room-admin page **Members** (`admin-ui/src/pages/RoomAdminMembers.tsx`, route `/:slug/admin/members`, nav entry in `RoomAdminLayout.tsx` next to Identity/Join Requests) hosts the roster + Ban/Unban UI moved wholesale from the public page. It renders only inside `RoomAdminLayout`, so the client-side `resolveViewerClaims` admin-detection dance is gone entirely — admin auth is established by the layout, and every read/write is still independently gated server-side.
- `admin-ui/src/pages/RoomMembers.tsx` (the public `/:slug/members` page) is back to a plain public roster — the ban button, ban/unban modals, "Banned" section, and all admin-token decoding logic were removed; it matches its pre-v2.49.0 shape.
- Settings page's "Users" card (admin-accounts management) gains a one-line pointer to the new Members page for discoverability — no ban UI duplicated there.
- No migration. Backend suite unchanged (798/798, no API changes). admin-ui suite unchanged at 146/146 — `RoomMembers.test.tsx` already only covered public-roster behavior (never gained ban-specific tests in v2.49.0), so it stays green unmodified against the reverted component; no test existed to update for the moved admin behavior, and none was added for the new admin page (no test precedent among sibling room-admin pages — Identity.tsx/JoinRequests.tsx are both untested).

## [2.49.0] — unreleased

**Room-tier bans, raw-provider-id name resolution, and landing-page polish.** See `tmp/room-bans-contract.md` for the full design contract.

- **Room-tier bans.** `user_bans` gains a nullable `game_room_id` column (migrations `122_user_bans_room_scope` for the ALTER + `123_user_bans_room_index` for the index — split into two entries so a swallowed ALTER failure, e.g. a DB where the column already exists but the migration row doesn't, can never take the index down with it; same table, not a new one — NULL keeps meaning "global ban," unaffected). `BanService.isIdentityBanned(providerUserId, gameRoomId?)` now checks `(game_room_id IS NULL OR game_room_id = ?)` when a room is passed — a global ban still bites everywhere, a room ban only bites in ITS room (decision: never blocks Global Scoreboard, friends, or other rooms). The in-memory TTL cache key is now composite (`id::roomId`) so a room-scoped check can't be masked by a stale global-only cache hit or vice versa. `requireNotBanned` (`middleware.ts`) auto-reads `req.params.roomId` and passes it through — every room-shaped route (rooms.ts submits/writes, `global.ts`'s `/me/rooms/:roomId` join + `.../join-request`) became room-ban-aware with zero per-route changes, EXCEPT `POST /global/rooms/:roomId/report` (its `:roomId` names the room being reported, not an acting context) which uses the new global-only `requireNotBannedGlobal` middleware instead — see the room-admin ban API bullet below. The submission-draft commit route (`POST /submission-drafts/:stateParam/commit`) gets an explicit in-handler room-ban check for tournament/freeplay targets, since the room id there lives in `draft.target.roomId`, not `req.params`. Discord `/submit-score` and `/pick-game` gained a second, room-aware ban re-check once each command resolves the target game/tournament's room (the initial pre-resolution check can only see global bans); `/submit-score`'s rating/comment follow-up collector now threads the resolved room id through its own re-checks too.
- **Room-admin ban API.** `GET/POST /api/rooms/:roomId/admin/bans` + `POST .../admin/bans/:banId/lift` (`requireAuth + requireRoomAccess`, POSTs also gated `requireNotBanned`). Banning writes `user_bans` scoped to the room, clears `BanService`'s cache, and strips the target's `room_members` row (banning removes membership; lifting does NOT auto-restore it — they can re-join). Guards use `BanService.expandIdentityCandidates`' full link-graph expansion (not just raw/canonical) so a super admin or room admin holding a grant on a linked `google:*` alias can't be banned out through it: can't ban yourself, can't ban a super admin, can't ban a room admin of THIS room (403 — admin misbehavior is a super-admin matter). Ban insert + membership strip + pending-join-request denial run in one transaction with a pre-flight duplicate-active-ban check (409 on a second ban attempt) so a mid-sequence failure can't leave a half-applied ban or let a retry double-ban. `JoinRequestService.approve` also gained a defensive re-check that 403s approving a currently-banned requester. **Both writes are explicitly audit-logged (`AuditService.log`, actions `room.ban`/`room.unban`) — correcting a claim in the original v2.49.0 draft of this entry that the app-level `auditLog` middleware covers them.** It does not: `auditLog` (`server.ts`) is mounted before the routers set `req.user`, so it early-returns and audits nothing on any router route (documented pre-existing at `global.ts` ~449-451; see ROADMAP for the repo-wide note). `POST /global/rooms/:roomId/report` uses a new `requireNotBannedGlobal` middleware instead of `requireNotBanned` — that route's `:roomId` names the room being REPORTED, not an acting context, so the room-aware middleware would have let a room admin ban a user to block them from ever escalating that room to super-admins.
- **FE — `/:slug/members` (RoomMembers.tsx) is now admin-aware.** Viewer-admin detection reuses the existing public-page precedent (decode `playerToken` claims, same as `GameDetail.tsx`'s per-row score-delete gating) — no new auth surface; also falls back to decoding the ADMIN token slot (`lib/api.ts`'s `getToken()`) so an admin who logged in at `/:slug/admin`, or whose player-flow login never auto-seeded the admin slot, still sees the Ban UI (display-only — server gating is unchanged). Admin viewers get a Ban button per member (hidden client-side on self, on this room's own admins, and on anyone already in the Banned list; the super-admin-target guard is server-enforced only, since a room admin has no client-side way to know who's a super admin) opening a confirm dialog with optional reason + optional duration-in-days and explicit copy that banning removes the member from the room and blocks re-joining while active; plus an admin-only "Banned" section listing active room bans with an Unban action. The bans/admins reads and the ban/lift writes go through `lib/api.ts` (were raw `fetch()` calls with hand-built auth headers — no 401 auto-refresh). The roster endpoint itself now excludes actively-banned users server-side (`RoomRosterService`, both the 'open' score-poster-derived roster and the 'approval' membership-derived roster) — previously an 'open' room's roster ignored `room_members` entirely, so a banned player stayed listed as both a Player and a Banned entry until the FE's optimistic-only removal was lost on reload. Public (non-admin) viewers see the page exactly as before.
- **Super-admin Reports "Bans" tab** gains a scope column (Global, or the owning room's name) on every ban row — additive; the standalone add-ban form there stays global-only (unchanged).
- **Name resolution for raw provider ids.** Five admin-facing surfaces that previously rendered a bare Discord/Google snowflake now resolve a display name via the same `LEFT JOIN user_profiles` pattern `RoomRosterService` established: `AdminService.getRoomDiscordAdmins` (Settings.tsx's Discord Admins card — resolved name prominent, raw id as small secondary text, `JoinRequests.tsx` precedent); `ScoreReportService.listBans` (now `UserBanEnriched` — resolves the banned identity, `banned_by`, and `lifted_by`, plus the owning room's name for the scope column above) and `.listPending`/`.listResolved` (resolves `reporter_discord_id`); `CommentReportService.list` (resolves the reporter — the comment author already had `comment_display_name`); `GameFeedbackService.list` (resolves the catalogue feedback reporter, rendered on `GlobalCatalogue.tsx`'s report-a-problem queue). Raw ids render as a `title` tooltip, never the primary label. For a room admin with NO `user_profiles` row at all (granted access but never logged into Arcaid), `src/utils/discord.ts` gained `fetchDiscordUserInfo(id)` — a best-effort Discord REST username/global-name fetch (guarded by `isDiscordUserId`, 1h in-memory cache including cached misses so a bad id or outage doesn't hammer Discord on every Settings page load). A `google:*` id with no profile has no Discord user to look up and renders as a truncated raw id.
- **Landing-page polish.** Motto centering/spacing tightened and a Global (Scoreboard) nav link added to `LandingPage.tsx`.
- Backend: 43 new tests (`room-bans.test.ts` — room-vs-global cache/scope isolation, linked-identity room bans, room-admin ban/lift/list API incl. self-ban/room-admin-target/super-admin-target guards and cross-room lift 404, membership-strip-on-ban, `requireNotBanned` room-vs-global param pickup across submit/comment/join/join-request/draft-commit routes, `AdminService.getRoomDiscordAdmins` name resolution incl. the no-profile/no-token/google-id fallback paths, `ScoreReportService.listBans` scope filter — 27 from the initial v2.49.0 pass, plus 16 from the fix-round: `requireNotBannedGlobal` room-report-suppression guard, explicit audit rows on ban/lift, linked-google-alias super-admin/room-admin target guards, pending-join-request denial on ban + `JoinRequestService.approve`'s defensive re-check, duplicate-active-ban 409, a globally-banned admin blocked from issuing/lifting room bans, `RoomRosterService` active-ban roster filtering (open + approval paths, including a global ban and a lingering `room_members` row), and `GameRoomService.delete`'s room-ban cleanup) — full backend suite 798/798 (755 + 43). admin-ui suite unchanged at 146/146 (no new FE tests — the RoomMembers.tsx/Settings.tsx/Reports.tsx/GlobalCatalogue.tsx changes are presentation-layer wiring against already-tested endpoints).

## [2.48.0] — unreleased

**First-login player tutorial.** Spotlight-style intro tour for logged-in players on their first room-page visit (not literal first login — a player who logs in from a global page gets the tour the first time they land on a room). See `tmp/first-login-tutorial-contract.md` for the full design contract.

- **Migration `121_user_preferences_tutorial_seen`** — `user_preferences.tutorial_seen_at`, a nullable ISO timestamp (not a boolean) so a future "reset tutorial" admin action can re-show it just by clearing the column. `PreferencesService` gains `getTutorialSeenAt`/`markTutorialSeen`, following the dedicated-column `ui_theme` pattern (not the `notification_prefs` shared-JSON-blob pattern). `GET`/`POST /api/me/tutorial-status` (`requireDiscordUser`) sit beside the other `/me/*` routes in `global.ts`.
- **`TourController` + `TourOverlay`** (new, `admin-ui/src/components/`) + a `TOUR_STEPS` config array (`admin-ui/src/lib/tourSteps.ts`). `TourController` is mounted inside `PublicLayout` only after the `RoomJoinGate` resolves (a gated/suspended/loading room never shows it) and owns the gating decision only: bail on `?submit-draft`/`?submit-cancelled` (PendingSubmissionWatcher owns that moment), bail on the `arcaid_tutorial_dismissed` sessionStorage flag, `GET /me/tutorial-status` and bail silently on a non-null `seenAt` or a fetch failure, otherwise show the tour after a ~600ms settle delay. `TourOverlay` owns step navigation and the finish/skip persistence writes — a `createPortal` spotlight overlay (`z-[100]`, above the `z-50` modal/toast layer) using the simple box-shadow cutout technique (no SVG mask), a tooltip bubble positioned by available viewport space, theme tokens only (readable across all 17 themes), a hand-rolled focus trap + restore (`GameQuickView.tsx`'s pattern), and the LandingPage.tsx reduced-motion convention on the spotlight/tooltip transitions. Anchor resolution happens in an effect (not during render) since a target mounted in the same commit as the overlay — e.g. a scoreboard game-card title — isn't in the real DOM yet during the render phase; steps whose anchor never appears are skipped without navigating the player anywhere.
- **4 steps:** nav bar, Scores tab, first game-card title (skipped entirely if none exists — empty room, or not on the scoreboard page), account menu. Controls: Back/Next, step dots, "Skip tour" (visible from step 1), a "Don't show this again" checkbox (default checked). Finishing the tour always POSTs `tutorial-status`; Skip with the checkbox checked also POSTs; Skip unchecked only sets the sessionStorage dismissal (tour returns next session); Esc = Skip, respecting the checkbox; clicking the dim backdrop does nothing (no accidental dismissal).
- **New `data-tour` anchors** (attribute-only, no behavior change): `PublicLayout.tsx`'s nav-items scroll container (`nav`) and the Scores `NavLink` (`nav-scores`); `UserMenu.tsx`'s trigger button (`user-menu`); the title `Link` in `BannerCard.tsx`/`ShowcaseCard.tsx`/`MinimalCard.tsx` (`game-card-title`).
- 9 new backend tests (`src/__tests__/tutorial-status.test.ts` — migration fresh-run, `PreferencesService` unit coverage, GET/POST chokepoint incl. 401s and idempotent double-POST) and 14 new admin-ui tests (`TourOverlay.test.tsx`, `TourController.test.tsx`) — full backend suite 755/755 (746 + 9), admin-ui suite 146/146 (132 + 14).

## [2.47.0] — unreleased

**S22 follow-ups: per-submit ban enforcement, comment reports, homoglyph hardening, and the "Arcaid" casing sweep.**

- **Per-submit ban enforcement.** New `requireNotBanned` Express middleware (`src/api/middleware.ts`) — no-op for anonymous writers, otherwise consults `BanService.isIdentityBanned` and 403s with the exact login-time string. Composed onto every per-submit/write route chain across `rooms.ts` (community scores, submit-score, freeplay-score, pick/queue writes, comments create, catalogue proposals) and `global.ts` (global score submit, score/room/name/comment reports, game feedback, rating, comments, friends, join-request, room create — the latter's pre-existing inline ban check was aligned onto the shared middleware). `GlobalScoreService.isBanned` (the raw, link-graph-unaware ban query) is retired; its one call site inside `submit()` now delegates to `BanService.isIdentityBanned`, per the "one ban predicate" decision. Discord `/submit-score` and `/pick-game` gained an inline ban check at the top of `execute()` (no Express chain to hook into), plus a re-check inside `/submit-score`'s post-submission rating/comment collector (that follow-up can fire up to 5 minutes later — a ban placed in that window must still block the write).
- **`BanService` gained a 10s in-memory TTL cache** (same idiom as `PickAwardGate.cache` / `NotificationService.flagCache`), since the ban check now runs on every gated route. `ScoreReportService.ban()`/`.lift()` call `BanService.clearCache()` (a full cache clear, not a single-key `invalidate()`) on every write, so a fresh ban/unban takes effect immediately for every linked-identity cache key instead of waiting out the TTL — a single-key invalidate would have left a linked alias's cached "not banned" result stale for up to 10s. `invalidate(providerUserId)` is kept as a narrower single-key primitive for other callers.
- Adversarial-review fix-round hardening (same release): `requireNotBanned` now also gates the submission-draft commit path, `PATCH /users/me/profile`, several room-admin content-write chains (lobby announcements/config, settings, tournaments, styles upload), and the open-room self-join route; the fail-open ban-check catch now logs (`requireNotBanned: ban check failed open`) instead of failing silently; rate limiters were reordered ahead of `requireNotBanned` on two `global.ts` routes to match the rest of the codebase (banned clients still consume rate-limit budget); own-comment matching (GET masking + DELETE authorization) now checks a candidate identity set (both the logged-in Discord id and the anon `x-user-id`) instead of preferring one, so a logged-in user keeps the delete control on comments they posted anonymously before logging in; `CommentReportService.remove` is now atomic (delete + resolve share a transaction) and sweeps every other open report on the same comment, not just the acted-on one.
- **Comment reports.** Migration `120_comment_reports` (mirrors `content_reports`' shape/dedup pattern — a partial UNIQUE index on `(comment_id, reporter_discord_id) WHERE resolved_at IS NULL`, not a permanent `UNIQUE`, so a comment can be re-reported after a prior report resolves). New `CommentReportService` (create with dupe-open-report rejection + open-report cap, list enriched with comment body/game/room context, dismiss, remove-which-deletes-the-comment-and-resolves-the-report). `POST /api/global/comments/:id/report` (Discord-auth + ban-gated + rate-limited, targets room-scoped `game_comments` — the ones GameDetail.tsx renders, not the separate `global_game_comments` table). Super-admin-only queue (matches the existing Reports page authorization; room-admin visibility deferred) — `GET/POST /api/admin/comment-reports*`, auto-audited by the existing router-level `auditLog` middleware, no extra wiring needed. FE: Reports.tsx gains a 5th "Comments" tab (Dismiss / Remove with a confirm dialog); GameDetail.tsx gains a Flag button on each comment/tip row (hidden when logged out or on the viewer's own comment) wired to the shared target-agnostic `ReportContentModal`. Small FE fix: GameDetail's comment GET/POST/DELETE fetches now send the player's `Authorization: Bearer` header (previously only `x-user-id`), so the server's existing admin/mod delete tiers — and the GET route's own-comment masking — resolve off the logged-in Discord identity instead of always falling back to the anonymous localStorage id.
- **Homoglyph confusables.** `normalizeForBlocklist` (`src/utils/contentBlocklist.ts`) gained a `CONFUSABLES_MAP` — cross-script (Cyrillic/Greek) lookalike characters folded to their Latin visual twin, applied after NFKD-strip + lowercase, before the l33t fold. Deliberately narrow scope: only characters that read as genuinely indistinguishable from their Latin counterpart (e.g. Cyrillic а/е/о/р/с/х/у/к/і, Greek α/ο/ν/ε/ι/κ/ρ/τ/υ/χ); ambiguous shapes (η, μ, и, and others) are left out on purpose — a missed confusable is a smaller cost than a false positive on a legitimate Greek/Cyrillic name. Doubled-letter and `*`/`+`-separator evasion remain accepted-open gaps, untouched.
- **"Arcaid" casing sweep.** Per the 2026-07-25 decision (ROADMAP.md), user-facing "ArcAid" copy is now "Arcaid" — logo `alt` text across the public/admin layouts and auth pages, UI copy in SubmissionSheet/GameDetail/PlayerDetail/Tournaments/GameStates/AccountSettings/ChunkErrorBoundary/MysteryAward/scoresCopy.ts/GameRoomManager, `admin-ui/index.html`'s `<title>` and `admin-ui/public/manifest.json`'s name/short_name (no icon rename needed — `manifest.json` is served no-cache since v2.45.1), `src/api/ogMeta.ts`'s og:site_name/description/title-splice (the title-splice match string was updated in lockstep with `index.html`'s new `<title>`, otherwise the OG injection would silently stop firing), Discord bot copy (`/ping`, `/setup`, `/notifications`, `/submit-score`, `discord.ts`, `NotificationService`, `OpsAlertService`), `README.md`, `docs/FEATURES.md`, `docs/HOW-TO-GUIDE.md`, `docs/VIDEO-TUTORIAL-SCRIPT.md`, `docs/runbooks/restore.md`, `Terms.tsx`, `Privacy.tsx`, server startup log lines, and `Settings.tsx`'s example value. (`docs/video-scripts/00-quick-spinup.md` was also swept locally, but that directory is untracked, so the edit doesn't ship in this diff — noted here so the description matches what actually lands.) Storage keys, CSS classes, component/identifier names (`ArcaidLogoAnimated` etc.), the `arcaid.app` domain, file paths, Discord command names, generated filenames, the stylized ARCAID/ARCAıD wordmark, and `docs/decisions/`/CHANGELOG/SPRINT_STATUS history are deliberately untouched. The two already-correct "Arcaid" strings in `auth.ts` were left as-is.
- **Known limitation:** ban enforcement is identity-based, not anon-tier — on guest-allowed paths (comments, always; score submits in `REQUIRE_DISCORD_LOGIN=false` rooms; ratings) a banned user can still write anonymously by simply omitting their token. Closing that gap is out of scope for this release; see ROADMAP.
- Backend: 39 new tests (`ban-enforcement.test.ts` middleware/cache/fix-round-gate additions, `comment-reports.test.ts` incl. the sibling-report sweep, `contentBlocklist.test.ts` confusables cases, `s11-trust-safety.test.ts` historical-comment-ownership cases, `s16-og-meta.test.ts` real-shell binding) — full backend suite 746 passing (707 + 39). admin-ui suite fixed back to green at 132/132 (`ArcaidLogoAnimated.test.tsx` assertions updated to the current 'Arcaid' aria-label — no new FE tests this round).

## [2.46.0] — unreleased

**Discord-side mirror of account linking: a Discord user can add a Google account as a second login key.** v2.36.0 shipped the Google->Discord direction only (a Google-identity user links a Discord account); this release mirrors it — a Discord-identity user can link a Google account from Account Settings, and either login works for the account afterward. Same merge-on-link semantics (snowflake is always canonical, Google-side history rewrites onto it), same no-un-merge unlink doctrine. See ADR 0015.

- **`LinkNonceStore` genericized** — the stored initiator field is no longer google-specific (`googleUserId` → `initiatorUserId`); the public `create(userId)` / `consume(nonce)` API is unchanged and now backs both link directions.
- **`POST /api/auth/link/google/start`** — mirror of the existing `/link/discord/start`: `requireDiscordUser`-gated, 400s for a google:* caller ("nothing to link"), 403s a banned caller, mints a nonce bound to the caller's Discord snowflake.
- **`POST /api/auth/google/callback` gains a `linkNonce` branch** mirroring the existing `discord/callback` branch: consumes the nonce, asserts the initiator is NOT a google:* id (direction guard — a nonce minted by the other flow can't be replayed here), ban-checks both sides before any writes, calls `IdentityLinkService.createLink`, and responds with `linked: true` + a token signed for the canonical Discord snowflake. The existing `discord/callback` branch gets the symmetric direction assert (initiator MUST be google:*).
- **`IdentityLinkService.createLink` conflict guard, both directions.** Pre-v2.46.0, linking a google id already linked to a DIFFERENT canonical silently re-pointed the link (flagged in-code as an out-of-scope v1 edge) — with linking now bidirectional this becomes a steal-link vector, since a Discord user could re-link a victim's already-linked Google account onto themselves just by completing the OAuth leg. `createLink` now pre-flight-checks the existing link row: same canonical is an idempotent no-op, different canonical throws a typed `LINK_CONFLICT` error. Both OAuth callbacks map it to `409 { error: 'That Google account is already linked to a different Arcaid account.' }`. This changes behavior on the existing Google->Discord direction too — intentional, closes a pre-existing hole.
- **FE:** `AccountSettings.tsx` — Discord-identity viewers get a "Link Google account" button (parallel to the existing "Link Discord account" button shown to Google-identity viewers) above their linked-identities list. `GoogleCallback.tsx` mirrors `DiscordCallback.tsx`'s link-flow handling (`state=link:<nonce>` detection, `linkNonce` in the callback POST body, success/redirect-to-Account-Settings on `linked: true`, OAuth-cancel handling).
- 18 new backend tests (`src/__tests__/mirror-link-flow.test.ts`) covering the new start endpoint, the google/callback link branch (invalid/expired/replay/direction-mismatch/bans/conflict/idempotent), direct `createLink` conflict-guard unit coverage, and the discord/callback side's new 409 conflict mapping.

**Adversarial-review fix round — CSRF hardening applies to BOTH link directions, including the pre-existing (shipped) Google->Discord one.**

- **CRITICAL — link-nonce CSRF (account takeover).** Pre-fix, a link nonce was bearer-only: an attacker could mint a nonce for their own account (`POST /link/*/start`), craft an authorize URL with `state=link:<that nonce>`, and get a victim to complete it — silently merging the victim's identity onto the attacker's account (full account takeover, including roles, on the Google->Discord direction). Two layers, both directions: (1) **FE session binding** — `GoogleCallback.tsx`/`DiscordCallback.tsx` now require `sessionStorage['arcaid_link_nonce']` (written by `startGoogleLink`/`startDiscordLink`) to match the `state`-derived nonce before ever entering the link branch; a mismatch shows a retry-from-Account-Settings error instead of falling through to a normal login. (2) **Server-side initiator assert** — both `POST /discord/callback` and `POST /google/callback`'s link branches now require an `Authorization: Bearer <initiator's own token>` header and verify (via the existing `verifyToken` helper — no new JWT code) that its decoded identity matches `LinkNonceStore.consume`'s returned initiator. Missing/mismatched token -> 401 (nonce still consumed either way). The FE attaches the initiator's still-held player token throughout the OAuth round-trip.
- **`user_profiles` UNIQUE-index collision could brick a link permanently.** `IdentityLinkService.createLink`'s both-profiles-exist branch ran the COALESCE `UPDATE` on the snowflake row BEFORE deleting the google row — if the snowflake's `display_name` was NULL and got COALESCEd to the exact value the (not-yet-deleted) google row still held, the partial UNIQUE INDEX rejected it, rolling back the whole transaction with the nonce already consumed (no retry path). Fixed by deleting the google row first.
- **`prompt=select_account` on link-flow Google authorize URLs.** Forces the account chooser so a browser already signed into one Google account can't silently link the wrong one on a shared/kiosk machine. Discord has no equivalent account-chooser OAuth param (only `prompt=consent`, which re-shows scope approval, not account switching) — `startDiscordLink` is unchanged; noted as a Discord-side limitation, not fixed.
- **Same-canonical relink now re-runs the attribution sweep** instead of early-returning. A stale pre-link `google:*` JWT (24h lifetime) can still create new attribution rows under the google id after the first link; relink is the repair path, so every rewrite must re-run (idempotent either way).
- **Conflict guard made atomic with the write.** The pre-flight `SELECT` is now a fast path only; the authoritative check is `ON CONFLICT(provider_user_id) DO NOTHING` + a re-read inside the transaction, closing the race the old pre-flight-then-`DO UPDATE` sequence left open.
- **Google->Discord link no longer clobbers the Discord profile with Google data.** `google/callback`'s post-link avatar/username upsert is now skipped entirely when `linked === true` — pre-fix it unconditionally overwrote the snowflake's just-COALESCE-merged profile with the Google identity's own avatar/username.
- **Canonical-shape doctrine enforced, not just conventional.** `IdentityLinkService.createLink` now asserts its second argument with `isDiscordUserId` (throws otherwise); `POST /link/google/start` asserts the caller id the same way (was a weaker "not google" check) and binds the nonce to the verified JWT identity only — never anything the request body supplies.
- **FE gates on the server's `linked: true` flag**, not its own `isLinkFlow` derivation — a malformed `state` that still reaches a normal-login response no longer gets stored as a false "linked" success. Link-flow error states now link back to Account Settings (where the user is still logged in) instead of the login page.
- 12 new/updated backend tests across `src/__tests__/IdentityLinkService.test.ts`, `identity-link-flow.test.ts`, and `mirror-link-flow.test.ts` (Fix 1/2/4/6/7 regressions, role-resolution on the mirror path, nonce-binds-to-JWT-not-body, no-session/no-profile-trace on banned/conflict attempts); all pre-existing link-flow tests updated to send the initiator's bearer token per the new Fix 1 contract. Full backend suite: 707 passing (695 + 12).

## [2.45.6] — unreleased

**Glitch cadence: infrequent, still sporadic (user judgment on the live page).** Cycles stretched 7.4s→18s (wordmark) and 5.7s→26s (delta) with two burst clusters each (was 4/3) at irregular offsets — a glitch moment lands roughly every 4-6s per system with genuine multi-second quiet stretches, instead of ~2/sec combined. Burst-internal character (rapid multi-jump + opacity flicker) unchanged; periods still non-syncing.

## [2.45.5] — unreleased

**Mobile polish round (user feedback with screenshots).**

- **Hero restack** — motto moved to sit UNDER the delta (87% of the logo box after a spacing round: close under the triangle tip, clear of the tile tops) and the ticker tiles now slide under the MOTTO instead of under the triangle (pull-up reduced to `clamp(-18px, -2.5vw, -8px)`). Fixes the squished mobile stack where motto/wordmark/tiles crowded each other.
- **PWA icons regenerated (`-v3`) with spec-correct safe-zone insets** — the v2 maskable icon's mark spanned 80% of the canvas, exceeding the maskable safe circle, so launchers with aggressive masks cropped the mark's edges (operator's launcher did; a friend's gentler launcher didn't — both are spec-legal). v3: mark at 62% width on the maskable, 70% on regular/apple variants. New filenames + `manifest.json?v=3` per the cache-bust rule; v2 icon files removed.
- **Mobile nav brand fixes** — the room name previously had `min-w-0` + truncate with no floor, so flexbox crushed it to nothing (or 2 chars) on phones, jamming the logo against the first nav item; an intermediate min-width fix still let the name and nav labels crowd each other. Final structure: three hard-separated bar regions — fixed brand (h-6 logo + name at fixed 84px on phones / natural ≤220px on sm+, JS-capped 12 chars, full name in `title`), a scrollable middle nav region (left-aligned on phones so overflow stays reachable — flexbox can't scroll into start-side overflow under `justify-end`), and auth pinned right. Overlap is now impossible by construction; on narrow phones the tail nav items scroll instead of colliding.

## [2.45.4] — unreleased

**Glitch rework.** The delta now glitches too — two chromatic split-copies (pink/cyan) of the double-triangle, invisible at rest, flash offset during burst windows. Both glitch systems moved off the old tidy 4s metronome onto irregular multi-jump burst clusters with in-burst opacity flicker (`arcaidGlitchText` 7.4s / `arcaidGlitchTri` 5.7s, staggered negative delays — the co-prime-ish periods drift so text and delta never sync). Reduced-motion freezes everything as before (delta copies simply never appear).

**Landing motto.** User-authored tagline — "Run the room. Settle the score. Own the arcade." — rendered in the free band between the ARCAID wordmark and the ticker tiles (absolutely positioned at 64% of the logo box so it anchors proportionally at every viewport size; uppercase DM Sans, letter-spaced, cyan-tinged text-shadow for legibility over the triangle glow and tile tops).

## [2.45.3] — unreleased

**Landing hero × scoreboard ticker overlap (third user-feedback round).** The remaining "seam" was the ScoreboardPromo band's purple gradient starting at full strength on its top edge — a hard boundary against the flat page background above. Per the user's layout direction:

- The score-ticker row now slides UP behind the logo (negative-margin wrapper, `clamp(-120px, -19vw, -48px)` so the overlap stays proportional on phones): tile tops tuck behind the bottom of the triangle, just under the ARCAID wordmark. The hero wrapper is `z-index:10; pointer-events:none` so the tiles/links beneath stay clickable.
- The 🏆 "Global Scoreboard" heading + subcaption are REMOVED entirely (final user direction after two intermediate placements); the section's only chrome is the **View All Scores** button, right-aligned under the tiles. The band's tint fades IN from transparent (no visible top edge anywhere).

## [2.45.2] — unreleased

**Logo hero: crop the design box's dead space (second user-feedback round).** After v2.45.1 removed the hero's dedicated backdrop, the hero region still *read* as "its own black section" — root cause (verified by probing computed styles on prod: hero and page paint the identical `bg-deep`): the source 620×560 composition carries ~120px of empty margin above and below the visible triangle+wordmark, which at hero scale reserved ~300px of empty page background and ended abruptly at the Global Scoreboard band.

- `ArcaidLogoAnimated`: the layout box now crops to the composition's visible bounds (`CROP_TOP=95`/`CROP_BOTTOM=85` of the 560 design height; wrap `aspect-ratio` 620/380, sign shifted up by the scaled crop). The glow halos still paint outside the layout box (overflow visible, translucent) — nothing is clipped, the hero just stops reserving empty height.
- Landing hero cap 760→680px, padding 16/8→8/4px. Page now flows header → mark → content with no dead zone.

## [2.45.1] — unreleased

**Logo refresh fix round.** User feedback on the shipped v2.45.0 "Delta House Chrome" logo — three issues, all addressed:

- **Hero no longer sits on its own black stage.** The landing hero's dedicated `#0C0C13` backdrop section is gone — the animated wordmark now renders directly on the page's own `bg-deep` background (the same one the room grid below sits on), so there's no visible seam. Top/bottom padding cut substantially (48px/40px → 16px/8px) while staying centered and prominent. The component's internal glow/animation is untouched.
- **Nav/header logo enlarged + redundant "ARCAID" text removed.** New wide-crop derivative (`arcaid-logo-wide-v2.png`, alpha-bbox crop with a small breathing margin, no square padding — the old square asset wasted most of a small box on transparent padding around a ~1.6:1-wide mark) replaces the tiny square logo + adjacent "ARCAID" text wherever that redundant pairing appeared: `LandingPage` header, `GlobalScoreboard` header, and both `SuperAdminLayout` lockups (mobile top bar, sidebar header — the sidebar keeps its "Super Admin" subtitle, only the "ARCAID" line is gone). Sized per context so the in-image wordmark reads at least as large as the text it replaces, verified against rendered screenshots: `h-16` (64px) for the two page headers, `h-9`/`h-14` for SuperAdminLayout's mobile bar / sidebar (kept within the mobile bar's existing `pt-16` fixed-header spacer budget so nothing overlaps). `PublicLayout`'s room nav keeps its split-brand semantics (logo → all rooms, room name → room home — the room name is navigation, not redundant brand text) and just swaps in the wide asset at a slightly larger `h-8 sm:h-9`. `RoomAdminLayout` (shows the room name, not "ARCAID" text — never had the redundant-text problem) is untouched beyond the filename rename below.
- **Stale-cache root cause fixed with new filenames, not just re-served bytes.** v2.45.0 overwrote same-named files in `admin-ui/public/`, which carried no explicit `Cache-Control` — browsers applied heuristic freshness off `Last-Modified`, so the new mark stayed invisible for days, and a PWA icon-cache compounded it (delete+reinstall still showed the old icon). Every replaced asset now ships under a NEW filename: `arcaid-logo-v2.png`, `arcaid-logo-wide-v2.png`, `arcaid-icon-192-v2.png`, `arcaid-icon-512-v2.png`, `arcaid-icon-512-maskable-v2.png`, `apple-touch-icon-180-v2.png`. Old-named files removed (`git mv`'d, no dangling references remain — checked). `index.html`'s favicon/apple-touch-icon links and `manifest.json`'s icon paths updated; `index.html`'s `<link rel="manifest">` now carries `?v=2` since `manifest.json` itself is subject to the same heuristic-caching problem. `sw.js`'s push-notification icon and `src/api/ogMeta.ts`'s default `og:image` fallback updated to match.
- **Backend cache-header hardening (`src/api/server.ts`'s `frontendStaticOptions`, same S19 seam).** `manifest.json` joins the `no-cache` set alongside `sw.js`/`index.html` (its icon paths can change release-to-release, same as this one). Everything else in `public/` (icons, fonts, favicons, ...) — previously no explicit header at all — now gets an explicit `Cache-Control: public, max-age=86400`: defense in depth so a *future* same-name overwrite goes stale for at most a day instead of indefinitely. `/assets/*`'s immutable rule and the `/api/*` image mounts are untouched. `s19-static-cache-headers.test.ts` updated to match (manifest.json now asserts `no-cache`; new case for the modest-max-age default).

---

## [2.45.0] — unreleased

**Logo refresh: "Delta House Chrome."** Replaces the pixel-art mascot mark with a new neon-glitch chrome wordmark across every brand placement.

- **`ArcaidLogoAnimated` component** (`admin-ui/src/components/ArcaidLogoAnimated.tsx`) — faithful port of the source "Delta House Chrome" composition (rotated double-triangle neon SVG + chrome "ARCAıD" wordmark with pink/cyan glitch-ghost layers on a 4s cycle, chrome pinball sphere standing in for the dotless-i's tittle). Self-hosted `Orbitron` 900 subset font (`admin-ui/public/fonts/orbitron-900.woff2`, ~6KB, extracted from the source bundle's embedded base64) via a scoped `@font-face` — no new Google Fonts dependency. Responsive sizing is CSS-only: a container-query (`cqw`) transform scale, capped by a `maxWidth` prop, so the mark grows to its cap on wide screens and shrinks proportionally on narrow ones without ever overflowing horizontally. Freezes to its static (non-animated) resting frame under `prefers-reduced-motion: reduce`.
- **Landing page hero.** `LandingPage.tsx` now opens with the animated wordmark as a prominent, centered hero (760px cap) on a dedicated `#0C0C13` backdrop — the design assumes a near-black stage for its glow layers to read. Existing page content (room grid, My Game Rooms, Global Scoreboard promo) is unchanged below it.
- **Still-image placements.** Every other logo placement (nav/header logos in `PublicLayout`, `SuperAdminLayout`, `RoomAdminLayout`; `Login`/`RoomLogin`/`InviteAccept`/`DiscordCallback`/`GoogleCallback`; `GlobalScoreboard` header; the landing page's own small header lockup) now render a still derivative of the new mark — same filenames, same CSS/dimensions at each call site (asset swap only). PWA/favicon icons (`arcaid-icon-192.png`, `arcaid-icon-512.png`, `arcaid-icon-512-maskable.png`, `apple-touch-icon-180.png`) were regenerated from the new mark on a filled `#0C0C13` square (maskable variant insets the mark to ~80% so Android's icon mask doesn't clip the glow). All derivatives were re-encoded as optimized PNGs (well under the 2MB source) with verified alpha transparency on the non-icon assets.
- Root version bump only (admin-ui-only change) per repo convention.

---

## [2.44.0] — unreleased

**Content moderation, Phase 2: admin action tools (S22).** The remediation "teeth" Phase 1's Reports queue deferred: super-admin room suspension, an admin display-name reset action, and ban enforcement extended to every token-issuance point. Room-tier bans, ban content cascade, per-submit ban enforcement, and ban Discord DMs remain out of scope — tracked in ROADMAP.

- **Room suspension** — three new `game_rooms` columns (migration 119: `suspended_at`, `suspended_by`, `suspended_reason`; `suspended_at IS NOT NULL` = suspended). Super-admin-imposed moderation state, not room config — it's a column, not a `game_room_settings` key, so it survives settings tooling and joins cheaply into listings. Blocks **everyone** except super-admins, including the room's own admins ("hidden + inaccessible pending review").
  - Enforcement touches every seam recon mapped: `roomVisibilityGate` (middleware.ts, checked ahead of the approval-policy gate since it's strictly stronger), `GET /api/rooms` (excluded from the public listing), `GET /api/portal` + the room-scoped `/:roomId/portal` (both return a minimal `{ suspended, name, slug }` shape — no settings/config/scores — when suspended), the WebSocket join gate (`canJoinRoomChannel` → `RoomAccessService.isSuspended`, the same source of truth the HTTP gate uses), the Discord cross-room exclusion filter (`discordExcludedRoomIds`), and OG link-preview meta (skips tag injection for a suspended room).
  - `POST /api/admin/rooms/:roomId/suspend` (body: `{ reason? }`) and `POST /api/admin/rooms/:roomId/unsuspend` — idempotent (re-suspending just refreshes the reason).
  - **FE:** `GameRoomManager.tsx` gets a Suspend/Unsuspend button per room (confirm + optional reason) and a SUSPENDED badge; `Reports.tsx` room-report rows get a one-click "Suspend room" quick action; `PublicLayout.tsx` renders a minimal centered "this room has been suspended" shell in place of the normal content/gate when the portal reports `suspended: true` (no login CTA, no room-scoped nav tabs).
  - Explicitly NOT scrubbed: a suspended room's players' historical Global Scoreboard entries — suspension hides the room, not the players' global history.
- **Admin display-name override** — `PATCH /api/admin/users/:userId/display-name` (body: `{ displayName: string | null }`). Re-validates through the exact same checks as self-service (`UserProfileService.setDisplayName` — length, blocklist, uniqueness) since that method already accepts an arbitrary target id; no parallel validation path. `null` clears the override (render falls back to username/id); 404s when the target has no `user_profiles` row. Reports page's player-name rows get a "Reset display name" quick action (clear-to-null only for Phase 2 — free-text admin rename is deferred).
- **Ban enforcement at token issuance** — new `BanService.isIdentityBanned(providerUserId)` checks the raw id, its canonical resolution (`IdentityLinkService.resolveCanonical`), and any sibling identity linked to either side — a ban placed on EITHER side of a Google↔Discord link now blocks login via the other. Wired into: the Discord OAuth callback (right after canonical resolution, before any writes — a banned login leaves no profile row, no consumed link nonce), the Google OAuth callback (same), `refreshAccessToken` (throws a coded `ACCOUNT_BANNED` error so `POST /api/auth/refresh` 401s with a distinct code — the FE's existing refresh-401-redirects-to-login handling needs no change), and `POST /api/rooms` (room creation, checked before the kill-switch/cap checks). Not yet extended into per-submit/comment paths — an unexpired access token keeps working until its own short TTL elapses; that's the accepted residual for this phase.
  - `POST /admin/bans` (the direct-ban route, not just the score-report ban action) now also rejects `iscored:*` synthetic ids with the same 400 Phase 1 only added to the score-report ban route — it has no login identity to ban.
  - Reports page gets a fourth **Bans** tab: lists every ban (active/expired/lifted, computed client-side) with a Lift action on active ones, plus a standalone add-ban form (provider id + optional duration/reason). Player-name report rows get a "Ban identity" quick action.
- **Tests:** `room-suspension.test.ts` (all six enforcement seams + suspend/unsuspend authz/idempotency/audit-row/revert), `admin-display-name-override.test.ts` (set/blocked/taken/clear/404/authz), `ban-enforcement.test.ts` (`BanService` unit coverage including both link directions, `refreshAccessToken` unit + route-level, room-creation, and both OAuth callbacks using the pre-existing fetch-mock pattern), plus `admin-ui` render tests (Reports Bans tab, PublicLayout suspended shell).
- **Fixed while building this:** `BanService.isIdentityBanned`'s expiry check normalizes both sides of the SQL comparison through `datetime(...)` — comparing the raw ISO-8601 `expires_at` string directly against `datetime('now')` is a string comparison where `T` sorts after a space, so a same-day-but-already-past expiry would incorrectly read as still active.

**Fix round (adversarial review, same release).** An independent review before merge found two MAJORs and several minors, all fixed here:
- **Discord slash commands bypassed suspension entirely (MAJOR).** The guild-level interaction gate (`DiscordClient.ts`) only checked `DISCORD_ENABLED`, never suspension — a suspended room's members could still `/submit-score` (writes, global fan-out, iScored sync, lobby feed) and admins could still `/activate-game`/`/pick-game`/`/force-maintenance`/`/run-cleanup`. Fixed via a new `guildInteractionBlockReason(guildId)` helper (`src/utils/discord.ts`, unit-testable, extracted from the interaction handler) that refuses when ANY room mapped to the guild is suspended — checked ahead of, and independently from, the enabled check. Separately: `/submit-score`, `/activate-game`, `/pick-game`, `/force-maintenance` all resolve their target room by tournament/game **name** with no room-state check, independent of the invoking guild (an edge case the guild-level gate can't catch — e.g. two rooms with same-named tournaments, one suspended). Each now re-checks `RoomAccessService.isSuspended` against the resolved room right before any write; `/submit-score`'s resolution step is extracted into a testable `resolveActiveSubmitGame()`. `/run-cleanup` iterates every active tournament system-wide by design, so it now skips (not errors) any tournament whose room is suspended, per-iteration.
- **Ban evasion via the Google→Discord link flow (MAJOR).** The link-completion ban check (`POST /auth/discord/callback` with `linkNonce`) only checked the Discord snowflake being linked TO, never the `google:X` id being consumed from the nonce — a banned Google identity holding a still-valid access token could link a clean snowflake and mint a fresh 24h token+refresh pair, repeatably, with no rate limit on repetition. Fixed: `BanService.isIdentityBanned(googleUserId)` now runs right after `LinkNonceStore.consume()` and before `IdentityLinkService.createLink()` — a banned google id writes no link row and mints no token. Also gated `POST /auth/link/discord/start` on the caller's own identity so a banned account can't even mint a nonce.
- **m1** — `GET /:roomId/scoreboard-config` (registers before `roomVisibilityGate`, same structural bypass as the portal endpoints) now 403s `ROOM_SUSPENDED` for a suspended room; approval-room behavior is untouched.
- **m2** — `RoomMembershipService.listRoomsForUser` excludes suspended rooms from "My Rooms" (membership row itself is untouched — reappears on unsuspend); `POST /me/rooms/:roomId` (self-join) now refuses a suspended room.
- **m3** — `GET /submit/platforms` (the `SubmissionSheet` picker resolver, outside `rooms.ts` so it never passed through the gate) now 403s for a suspended room; its pre-existing lack of approval-room gating is untouched (accepted posture).
- **m5** — `POST /admin/bans` refuses banning your own identity (compares both the raw id and the `IdentityLinkService` canonical resolution of both sides, so routing around it via a linked alias doesn't work either) — "You cannot ban your own account."
- **m6** — `ScoreReportService.listBans`'s active-only filter had the identical raw-string-vs-`datetime('now')` expiry bug as `BanService` — same `datetime(...)` wrap applied; a same-day-expired ban is no longer misreported as active in the Bans tab.
- **m7** — `auditMiddleware`'s target-type/target-id derivation gained a `/users` pattern + `userId` param, so the admin display-name override now audits with a real target instead of `unknown`/empty.
- **m8** — Reports page's "Ban identity" quick action is hidden (not just left to 400) for an `iscored:*` target — it has no login identity to ban.
- **m9** — the score-ban / suspend-room / ban-identity confirm modals no longer share one `banReason`/`banDurationDays` state pair — each gets its own, reset on both open and cancel (previously a value typed for one report could bleed into a different report's action).
- Reason inputs (suspend room, all three ban modals) now cap at 500 chars client-side, matching the server-side Zod limits.
- **Tests:** `discord-suspension-gate.test.ts` (`guildInteractionBlockReason` + `resolveActiveSubmitGame`), two new cases in `identity-link-flow.test.ts` (banned google id at both the nonce-mint and callback-consume steps), self-ban guard + same-day-expiry cases in `score-reports-admin.test.ts`, plus an `admin-ui` render test locking in the m8 fix.
- **Noted, not actioned:** local-admin password login (`POST /auth/login/:roomSlug`) is structurally outside identity bans — it has no provider id for `BanService` to check, by design (it's a room-scoped admin credential, not a player/OAuth identity). A super-admin who bans their own super-admin *identity* through some other path than `POST /admin/bans` (which now blocks literal self-service self-bans) could in principle still recover via password login if one exists for their room — an accepted gap for this phase, not a regression it introduces.

---

## [2.43.0] — unreleased

**Content moderation, Phase 1: reports queue + input blocklist (S22).** New report backbone for rooms and player names, a super-admin Reports page that also gives the pre-existing (and previously consumerless) score-reports admin API its first UI, and a prevention-at-input blocklist for unambiguous hate slurs. Phase 2 (admin action tools — suspend room, force-rename, ban enforcement expansion) is a separate, later contract.

- **`content_reports` table (migration 118)** — one unified table for room reports and player-name reports (same shape, rendered together). Anti-spam dedup is a partial UNIQUE index on `(target_key, reporter_user_id) WHERE resolved_at IS NULL` (the `join_requests` pattern) — INSERT and catch the constraint violation, not an app-level SELECT-then-INSERT race. A resolved report doesn't block a fresh one.
- **`ContentReportService`** — `submitRoomReport`/`submitNameReport` (name reports key dedup on identity when `targetUserId` is known, else on room+name), `list`/`dismiss`/`resolve`/`pendingCount`. Per-reporter cap of 20 open reports (mirrors `GameFeedbackService`), 429 beyond.
- **Public submit endpoints** — `POST /api/global/rooms/:roomId/report` and `POST /api/global/report-name`, both `writeLimiter` + `requireDiscordUser` (any provider — ids are namespaced through the same claims). Deliberately in `global.ts`, not `rooms.ts`: reporting a room must work for non-members of approval rooms, who can see the room's name/logo on the public portal — the view-visibility gate must never block reporting.
- **Super-admin endpoints** — `GET /api/admin/reports`, `GET /api/admin/reports/pending-count` (sums open `content_reports` + open `score_reports` for one badge), `POST /api/admin/reports/:id/dismiss`, `POST /api/admin/reports/:id/resolve`. The existing score-reports endpoints (list/dismiss/soft-delete/hard-delete/ban, admin.ts) are reused untouched — Phase 1's Reports page gives them a UI for the first time.
- **`admin-ui` Reports page** (`/admin/reports`, nav entry with a pending-count badge) — three tabs (Rooms | Player Names | Scores) each with a Resolved toggle. Rooms/Names consume the new endpoints with Dismiss + an inline resolution-note Resolve; room rows link out to the existing Game Rooms manager (Phase 1's "action" — rename/delete already live there). Scores tab consumes the pre-existing score-reports queue with Dismiss/Soft Delete/Hard Delete/Ban (destructive actions confirm via `ConfirmModal` / a small ban-details dialog).
- **Report affordances on public pages** — a discreet "Report room" link in `PublicLayout`'s footer (near Privacy/Terms) and a flag icon on the room player page header, both signed-in-only (hidden for guests), both opening the same shared, target-agnostic `ReportContentModal`.
- **Input blocklist (prevention, not retroactive scan)** — `src/utils/blocklistTerms.ts` (curated, unambiguous-hate-slurs-only array) + `src/utils/contentBlocklist.ts` (`normalizeForBlocklist`/`containsBlockedTerm`/`assertNameAllowed`: NFKD diacritic stripping, zero-width-character stripping, l33t-speak folding, separator-collapsed + raw views). Deliberately excludes general profanity (the Scunthorpe problem — a name containing an ordinary embedded substring must pass; reports are the retroactive mechanism for ambiguous abuse). Wired server-side at every write chokepoint: room create (public + super-admin schemas), room update (`PUT /api/admin/rooms/:roomId` previously had **no** Zod schema at all — now `UpdateGameRoomSchema`, scoped to exactly the fields `GameRoomService.update` whitelists), tournament create/update, global display name (`UserProfileService.setDisplayName`), and per-room name claims (`RoomNameClaimService.resolveAndClaim` + `checkAvailability`, including the `SubmissionSheet` pre-submit check and every submit-path catch block that resolves a claimed name).
- **Tests:** `content-reports.test.ts` (submit/dedup/authz/pending-count), `score-reports-admin.test.ts` (first-ever coverage of the pre-existing score-reports endpoints — list/dismiss/soft-delete/**hard-delete**/ban/lift), `contentBlocklist.test.ts` (normalization cases + chokepoint integration tests asserting the coded 4xx), plus `admin-ui` render tests for the Reports page and `ReportContentModal`.

**Fix round (adversarial review, same release).** An independent review before merge found several correctness/UX issues, all fixed here:
- **Separator-collapse false positives (M1a).** The blocklist's separator-collapsed matching view previously stripped every separator, so a term could match across an ordinary word boundary (e.g. "Bingo Okada" → collapsed "bingookada" contains "gook"). Fixed rule: only collapse a separator run when the alphanumeric runs on BOTH sides are exactly 1 character — the real letter-spacing attack shape (`n.i.g.g.e.r`) stays caught; ten reviewer-verified false-positive names (including "Bingo Okada", "Wet Backspin", "Mango OK") now pass.
- **Term-list precision (M1b).** Dropped `kike` (standard Spanish diminutive of Enrique) and `beaner` (substring of "beanery") for real-name/real-word collision risk.
- **Prevention-at-input-only claim policy (M2).** `RoomNameClaimService.resolveAndClaim` now skips the blocklist check entirely when the claimant already owns the exact requested name — an established player keeps submitting under a name they already hold even if a later blocklist update would now reject it. Only a genuinely new claim is checked. `checkAvailability` (the new-name pre-check) is unchanged.
- **Report headline correctness (m1).** A player-name report's headline is now the reported `target_name` **snapshot** (the offending string as reported), not the target's current resolved profile identity — a renamed player's report no longer disappears into their new clean name. The resolved identity renders as secondary "Currently: …" context.
- **Provider username laundering (m2, m3).** A blocked OAuth display name (Discord/Google) no longer gets persisted as the public `username` fallback (writes `NULL` instead — the login itself is never rejected); same treatment for the `IdentityLinkService` account-link profile copy, which previously could launder an unchecked name onto the canonical profile via `COALESCE`.
- **Silent no-op ban (m6).** Banning a score whose `player_id` is a synthetic `iscored:*` id (synced from iScored, no login identity) now 400s with a clear message instead of writing a `user_bans` row that can never match anything; surfaced as a toast in the Reports page's Scores tab.
- **Ban body validation (m7).** `POST /admin/score-reports/:reportId/ban` and `POST /admin/bans` now validate `durationDays`/`reason` via Zod — a garbage `durationDays` 400s instead of producing `new Date(NaN)` and a 500 further down.
- **Hard-delete coverage (m8).** Added the smoke test this endpoint was missing (the earlier CHANGELOG line overclaimed coverage that didn't exist).
- **Cheap hardening (m9).** Added soft hyphen (U+00AD) and word joiner (U+2060) to the zero-width strip set, and `6`/`9` → `g` to the l33t fold (`ni66er` shape) — no doubled-letter collapsing, which would have multiplied M1a's false-positive surface.
- **Tightened duplicate-report detection.** `ContentReportService`'s insert-error mapping now requires both the SQLite UNIQUE-constraint code AND message text before mapping to 409, so an unrelated constraint violation on the same table surfaces as a real 500 instead of a misleading "already reported".
- **Dedup key normalization (n4).** The name part of a room+name-keyed `target_key` is now NFKC-normalized, trimmed, and whitespace-collapsed before hashing into the key, so trivial variation no longer dodges the anti-spam index.
- **`short_tag` blocklist coverage (n3, partial).** The 6-character room short-tag field (renders publicly on room cards) now gets the same blocklist refine as name/slug on both room-create and room-update schemas.

---

## [2.42.0] — unreleased

**Room Players/Members page.** A new room page (nav: "Players") listing the room's active users, linking each to their player detail.

- **Open rooms** → everyone who has posted a score: distinct *identified* submitters from `score_history` (guests/anonymous excluded via `submitted_by_user_id IS NOT NULL`, orphaned scores excluded), with score count + last-active. Read from the scores themselves, not `room_members` (whose join-source flag is unreliable for "has posted").
- **Approval (private) rooms** → the approved-member roster from `room_members`, with owner/admin badges. Rides the existing view gate: the members list is **members-only** for approval rooms (a non-member gets `403 APPROVAL_REQUIRED`) and public for open rooms — verified with tests.
- Names resolve `display_name → username → iScored alias → id` server-side; rows link to `/:slug/players/:name` (plain text when a player has no iScored alias to link).
- New `RoomRosterService` + `GET /:roomId/members` (registered below the gate); FE page `/:slug/members`. No migration.

---

## [2.41.0] — unreleased

**Global Scoreboard sharing is the player's choice, per submission — not a room setting.** Removes the room-level `SHARE_TO_GLOBAL` toggle (v2.40.0) and the approval-room fan-out block (v2.39.0) in favor of the pre-existing per-submission opt-out that already governs open rooms.

- A room score fans out to the Global Scoreboard **by default**, and the submitting player can uncheck that per submission (`excludeFromGlobal`, already in the submit flow) — the same for open and approval (private) rooms. A private room's *content* (leaderboards, feed, membership) stays gated; each individual score is the player's to share.
- Deleted the `SHARE_TO_GLOBAL` admin toggle + its scrub/back-fill/flip machinery (`JoinPolicyService` removed entirely; `GlobalScoreService.scrub*/backfill*` and `GameRoomSettingsService.handleShareToGlobalFlip` gone). The flip-to-approval confirm no longer claims scores leave the Global Scoreboard (states only the view-gating consequence).
- **Verified (with tests): approval-room score submission is already members-only** — the `roomVisibilityGate` covers `submit-score`/`freeplay-score`/`community-scores`, so a non-member gets `403 APPROVAL_REQUIRED`. Only approved members can post to a private room's scoreboard.
- No migration (any stored `SHARE_TO_GLOBAL` key is now inert). All other approval-room gating unchanged.

*Note on discovery:* listing a private room on the landing page is the separate "list on landing page" (`is_public`) setting — an `is_public` approval room shows on the landing page (activity counts stripped) with entry gated by approval.

---

## [2.40.1] — unreleased

**Fix: join-request names reverted to raw IDs (v2.40.0 regression).** Two interacting bugs corrupted `user_profiles.username`: (1) `refreshAccessToken` degraded the token's username claim to the raw Discord/Google ID for any user without a chosen display name (it never read the v2.40.0 `username` column), and (2) the join-request-time upsert wrote that degraded claim straight back into `user_profiles.username`, clobbering the good value. A user who was approved, left, and re-requested therefore showed their ID again (pending + resolved history). Fixes: refresh now falls back `display_name → username → id`; the join-request upsert refuses to persist a username equal to the id. Corrupted rows are repaired on prod (recovered from the iScored alias where available, else cleared so the real name returns on next login).

---

## [2.40.0] — unreleased

**Join-request names + private-room Global Scoreboard opt-in.** Two fixes from live approval-room testing.

- **Join Requests now show a name, not a raw ID.** Login persisted only the avatar, never the provider username, and most users haven't set a global display name — so the approval queue rendered a bare Discord/Google ID. New `user_profiles.username` fallback (migration 117), written at every login and at join-request time; the queue renders `display name → username → ID`. (A request created *before* this release still shows its ID until that user next authenticates — one-time backfill gap.)
- **Private rooms can opt into the Global Scoreboard.** New per-room `SHARE_TO_GLOBAL` toggle (shown only when Join Policy is "Approval required", in `DANGEROUS_KEYS`): an approval room stays private but its scores appear on `/scoreboard`. Off by default. Turning it on back-fills the room's existing scores; turning it off (or flipping to approval without it) scrubs them. The flip-to-approval confirm copy is now conditional.
- **Security/integrity verified**: adversarial review confirmed no clickable path from a globally-shared private-room score into the gated room (game links → global game page, player names unlinked, room tag → public filter). Review also caught + fixed a MAJOR — the back-fill's row-restore was scoped to privacy-scrub tombstones only, so a moderated or self-deleted global score can never be resurrected by a share toggle (regression-tested).

Migration 117 consumed — **next free is now 118**.

---

## [2.39.1] — unreleased

**Fix: non-public rooms' admin panel showed "Game room not found."** `RoomAdminLayout` resolved the room from the public `GET /api/rooms` list (`is_public = 1` only), so the owner of a non-public room — now a common case with v2.39.0 approval/private rooms — couldn't open their own admin panel. It now resolves via the shared `getPortal(slug)` endpoint (the same slug→room resolver `PublicLayout` uses), which returns any room regardless of `is_public`. Admin data remains gated server-side by `requireRoomAccess` on every endpoint; this only fixes chrome resolution.

---

## [2.39.0] — unreleased

**Approval rooms (private rooms).** A room can now be set to require approval — invisible to non-members beyond its name/logo, with a request-to-join queue.

- **`JOIN_POLICY` per-room setting** (`open` default | `approval`), a hand-rendered select beside the login-policy control in room Settings, in `DANGEROUS_KEYS`. Flipping to approval shows a confirm dialog (room becomes invisible to non-members AND its scores leave the Global Scoreboard).
- **View gate** — one `roomVisibilityGate` mounted once in `rooms.ts` (after portal/scoreboard-config, which stay reachable so the join screen renders on-brand). Non-members/guests get `403 APPROVAL_REQUIRED` on every scores/stats/lobby/history/games/pick endpoint; members, room admins, and super-admins pass. Portal carries `join_policy` + `viewer_status` so the FE gates before calling anything.
- **Join requests** (migration 116, `join_requests` + partial-unique on pending): `POST /api/me/rooms/:roomId/join-request`; room-admin queue page with approve/deny (approve → membership via v2.38's hardened path) + a 60s-polled nav badge. Approvers = room owner + room admins.
- **Leak closures** — WebSocket `join:room`/`join:lobby`/`join:game` membership-checked (token via Socket.io handshake `auth`); OG link-preview returns the generic shell for approval rooms; the five Discord cross-room read commands exclude approval rooms; global fan-out skips approval rooms and flipping to approval scrubs already-fanned rows + recalcs; the public `GET /api/rooms` list zeroes approval rooms' activity counts and nulls their invite URL (keeps name/slug/logo/`join_policy` for discovery).
- **Member-picker admin add** — room admins are added by picking from the member list (name + avatar, works for Google- or Discord-authed members) instead of pasting an opaque user ID; raw-ID entry kept as an advanced fallback.
- **Kiosk on approval rooms: not supported** this release (renders the join gate; `KIOSK_KEY` pairing is on the roadmap).
- **Security**: Opus adversarial review PASS-with-minors — view gate un-bypassable incl. the legacy-alias vector; the one metadata leak found (activity counts) fixed. 63 new tests; backend 516, admin-ui 110.

Migration 116 consumed — **next free is now 117**.

---

## [2.38.1] — unreleased

**Super-admin login hardening (no data was ever exposed).** Removed the public "Admin" link from the landing page — it invited any visitor to OAuth in with super-admin intent and land on the (data-less, server-403-gated) Super Admin shell, which looked alarming despite exposing nothing. `SuperAdminLayout` now role-guards on the token's `role` claim: a non-super-admin token bounces to `/login` instead of rendering the chrome. Server-side `requireSuperAdmin` was and remains the real gate (every `/admin/*` call 403s for non-super-admins); this closes the confusing empty-shell and trims needless attack surface. Super admins reach the panel directly at `/login`.

---

## [2.38.0] — unreleased

**Explicit room join/leave.** My Game Rooms is now curatable, not just activity-derived.

- **Join/leave endpoints** — idempotent `POST`/`DELETE /api/me/rooms/:roomId` (any signed-in provider). Implicit membership on score submission stays; leaving never touches admin grants; re-submitting a score re-joins.
- **Bookmark toggle on landing room cards** (`BookmarkPlus`/`BookmarkCheck`) with optimistic section re-splitting; room pages get a contextual join/leave item in the user menu; My Rooms page gets per-room leave. Shared `useMyRooms` hook backs all three.
- **Migration 115** — widens `room_members.source`'s CHECK to admit `'self_join'` (table rebuild per house pattern; handler-based so a failed rebuild halts startup instead of being silently marked applied).
- **Silent-failure hardening** — the join route re-verifies the insert landed and errors loudly if not; found via the implementing agent proving the old CHECK constraint made joins silently no-op while reporting success (a live instance of the known swallowed-SQL-error gotcha). Regression test included.
- **Tests** — 22 new (9 BE route incl. the silent-failure regression; 13 FE hook/toggle/menu/leave).

Migration 115 consumed — **next free is now 116**.

---

## [2.37.1] — unreleased

**Landing-page user-menu z-fix.** The header's `backdrop-blur` creates a stacking context that trapped the UserMenu dropdown's z-index — page sections below (promo strip, room cards) painted over the open menu. Header now carries `relative z-40`.

---

## [2.37.0] — unreleased

**Landing-page login + My Game Rooms + Brave push hint.**

- **Sign in from the front door** — the landing page header now offers Discord/Google login (and the standard user menu once signed in) beside the existing Admin link. Logged-out layout unchanged.
- **My Game Rooms** — signed-in visitors see the rooms they belong to in their own section above the public grid (deduped from it; unlisted member rooms render gracefully without public stats). Powered by the existing `/api/me/rooms` — FE-only.
- **Brave push hint** — when enabling browser push fails with the push-service-abort class despite granted permission (Brave with "Use Google services for push messaging" off), the error now appends the exact brave://settings/privacy fix instead of leaving a bare browser error.
- **Tests** — 14 new (landingRooms split/dedupe, pushError classification, LandingPage mount incl. logged-out regression).

FE-only, no migration (next free still 115).

---

## [2.36.0] — unreleased

**Google ↔ Discord account linking.** A user who started with Google can link their Discord account — both logins then resolve to one canonical identity (the Discord one), so names, scores, admin grants, and Discord features all unify.

- **Migration 114**: `user_identity_links(provider_user_id PK → canonical_user_id)` + canonical index.
- **Login-time canonical resolution** in both OAuth callbacks and token refresh: once linked, "Sign in with Google" signs you in *as your Discord-linked self*. Unlinked users: exact no-op.
- **Ownership-proving link flow**: Account Settings → "Link Discord account" → one-time crypto-random nonce (10-min TTL, single-use, bound to the authenticated Google identity) → standard Discord OAuth → server proves both identities before writing the link and rewriting attribution (scores across all four score tables, room memberships, preferences, push subscriptions, admin grants, sessions) in one transaction. Last-write-wins conflict rules (beta-accepted).
- **Unlink** (row delete only — identities diverge going forward; no un-merge, the confirm says so).
- **UserMenu** shows a "Link Discord account" nudge for Google-identity users and now reports the actual login provider (fixed a hardcoded "Logged in with Discord" label).
- **Security**: Opus adversarial review PASS — account-takeover vectors (link-to-victim's-Discord incl. super-admin escalation, victim's-Google-to-attacker's-Discord, nonce replay/CSRF/race) all verified blocked; 35 new tests incl. fail-on-revert takeover cases.

Migration 114 consumed — **next free is now 115**.

---

## [2.35.0] — unreleased

**Sign in with Google.** ArcAid is no longer Discord-only — Google is a full second login provider.

- **Google OAuth** end-to-end: `GET/POST /api/auth/google[/callback]` mirroring the Discord flow (no new dependencies; identity proven via Google's userinfo endpoint). Google users get namespaced subject IDs (`google:<sub>`) flowing through the existing identity columns — score attribution, display names, room membership, admin grants, web push, and web picks all work identically. Discord-channel features (DMs, @mentions, slash-command identity) are provider-gated and simply don't fire for Google users.
- **`provider` JWT claim** (absent = legacy = Discord) + `src/utils/identityProvider.ts` helpers; six ID-vs-username dispatch sites fixed to recognize namespaced IDs.
- **Google users can win tournaments**: winner resolution now prefers the top submission's own attribution before the Discord-command-populated `user_mappings` lookup — Google (and previously-unmapped Discord web) winners get picker slots and web-push "your turn to pick" instead of the silent admin-picks-manually path. Includes a sentinel-ID guard (`ANON`/`COMMUNITY`/`SYSTEM` legacy values can never be crowned).
- **3-state room login policy**: `REQUIRE_DISCORD_LOGIN` becomes Guests / Any login / Discord required (3-option select in room Settings; SubmissionSheet shows the right buttons + copy per policy; orphan-on-flip semantics preserved incl. a fixed `false→discord` transition bug).
- **Avatars**: migration 113 adds `user_profiles.avatar_url` (Google picture URLs) beside the Discord hash; shared `resolveAvatarUrl` helper replaces six hardcoded CDN-template sites.
- **All 12 login surfaces** show both providers (Discord-integrated rooms get a "Sign in with Discord for DM notifications and picks" nudge at the two config-aware sites).
- **Also fixed en route** (pre-existing): `/scoreboard-config` never included `REQUIRE_DISCORD_LOGIN`/`DISCORD_ENABLED` (silently-dead FE prop); token-refresh username/avatar now read `user_profiles` per doctrine (was `user_mappings`).
- **Security**: `GOOGLE_CLIENT_SECRET` encrypted at rest from day one (`DISCORD_CLIENT_SECRET`'s plaintext-at-rest gap documented in ROADMAP — not flipped here to avoid breaking prod decrypt-on-read). Opus adversarial security review: PASS, no majors.
- **Tests**: 5 new backend suites (identity helpers, Google OAuth, 3-state middleware matrix, notification gating, winner attribution) + FE avatar/login-policy coverage — backend 425, admin-ui 74.

Migration 113 consumed — **next free is now 114**. Requires `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` in Global Settings for the Google buttons to function (Discord-only continues to work without them).

---

## [2.34.1] — unreleased

**Play-tester fixes: room-exit nav + number-field editing.**

- **Way back to the main page** — the ArcAid logo in the room header now links to the landing page (all game rooms); the room name still links to the room's home. Previously both were one link to the room home, leaving no path from inside a room back to the site's front page. Logged-in users also get an "All Game Rooms" entry in the user menu (all three surfaces that share it); guests' path is the logo (no guest menu exists).
- **Timeout/number fields can be emptied while typing** — `NumberStepper` (winner/runner-up pick windows, cleanup count, etc.) no longer snaps back to the minimum on every keystroke; the field may sit empty mid-edit and commits a clamped value on blur (reverting to the last valid number if left empty). ± buttons unchanged.
- **Tests** — 6 new NumberStepper cases (first coverage).

No DB migration (next free still 113).

---

## [2.34.0] — unreleased

**Card title alignment + info-popup hover.**

- **Reserved two-line title box** (Banner/Showcase/Minimal cards): a wrapping game title (e.g. "Black Knight Sword of Rage (Stern, 2019)") no longer pushes the card's meta row and podium/score area down relative to sibling cards — every title gets a fixed two-line box (derived from the card's title font size × its actual line-height), vertically centered, text clamped at 2 lines (full name remains on the game-detail page). Single-line titles center in the same box, so rows align exactly.
- **Game info "ⓘ" popup opens on hover** (mouse): hovering the icon opens the bubble after a 100ms intent delay; moving the pointer into the bubble keeps it open, and leaving both closes it after a 300ms grace period — so the game-source link inside is reachable and clickable. Touch keeps tap-to-toggle (hover handlers are gated on `(hover: hover)`); keyboard/Escape behavior unchanged.
- **Tests** — first GameInfoPopup coverage (3 fake-timer cases: open delay, grace-period close, re-enter cancels close).

No DB migration (next free still 113).

---

## [2.33.0] — unreleased

**Public self-serve room creation.** Anyone can create a game room from the landing site — no super-admin needed.

- **Landing page** gains a "Create Game Room" card after the room grid (doubles as the empty-state CTA). Links to the new `/create-room` page.
- **`/create-room`** — Discord-login-gated page (MyRooms pattern): room name, auto-derived editable URL slug, description, "list on landing page" checkbox. On success the creator is routed through the existing room-admin OAuth flow straight into their new room's admin dashboard (zero new auth surface — `DiscordCallback`/`auth.ts` untouched).
- **`POST /api/rooms`** (public, `requireDiscordUser`): creates the room in **standalone** mode (Discord/iScored off — upgrade later via Settings) and writes the creator as `role='owner'` in `game_room_admins`, atomically (room insert + settings seeds + owner grant in one transaction).
- **Guardrails:** 3 owned rooms per Discord user; new `roomCreateLimiter` (3/hour per user, per-`discordId` keyed) on top of the per-IP general limiter; server-side `RESERVED_ROOM_SLUGS` list so a room can't shadow `/admin`, `/scoreboard`, `/games`, `/assets`, etc.; `PUBLIC_ROOM_CREATION_ENABLED` global-setting kill switch (default on, unseeded — the future monetization lever).
- Super-admin create path (`POST /admin/rooms`, GameRoomManager) unchanged: no cap, no reserved-list.
- **Tests** — 6 new route-level cases (auth 401, create + owner grant + standalone seeds, reserved-slug 400, duplicate 409, cap 403, kill-switch 403).

No DB migration (next free still 113). Adversarial review PASS-with-minors; accepted residual risks documented in-code (bounded cap race) and in the PR (throwaway-account friction is Discord's, plus the kill switch).

---

## [2.32.0] — unreleased

**Standalone "pure ArcAid" room mode — Phase 1.** A room can now run with no Discord server and no iScored board, end to end.

- **Room creation choice** — super-admin create-room form gains a Connected / Standalone segmented choice (default Connected). Standalone seeds `DISCORD_ENABLED='false'` + `ISCORED_ENABLED='false'` at creation; the copy-onboarding-message generator branches to web-only setup steps (no Guild ID / iScored credential prompts). Absent mode = connected — existing callers and rooms unchanged.
- **Settings packaging** — the Discord and iScored credential categories collapse behind a quiet "Enable integrations…" affordance when their toggle is off (per-category; unset = visible, so existing rooms see no change). The Integrations toggles card and Discord Admins card stay visible — Discord OAuth is a room-independent identity provider.
- **Health card room-scoping (leak fix)** — `GET /:roomId/admin/health` now returns `iscored: {enabled, configured}` and filters poller accounts to the room's own iScored account. Previously the dashboard showed the GLOBAL poller map — i.e. other rooms' sync health — on every room's dashboard. Disabled rooms get a neutral gray "iScored disabled" state mirroring the Discord treatment.
- **Notification fixes (the bugs that would have silently killed the standalone winner flow):**
  - `NotificationService.notify()` no longer short-circuits on `DISCORD_ENABLED='false'` before the web-push branch — the gate now suppresses only the Discord DM, so standalone rooms' players get web push (`tournamentWin`, `rankDethroned`, and now `turnToPick`). Connected-room behavior is unchanged path-for-path.
  - `turnToPick` is now web-push-eligible with a deep link to the room's Picks page (was DM-only — the single most actionable notification in the pick flow had zero non-Discord delivery channel).
- **Tests** — 4 new web-push cases (Discord-disabled room still pushes, connected-room parity, turnToPick push with correct deep link, push-flag-off isolation).

No DB migration (next free still 113). Web push requires `WEB_PUSH_VAPID_*` keys seeded server-wide (S15) — verify on prod at deploy.

---

## [2.31.0] — unreleased

**Ranking-card restyle.** Ranking-group cards on the public scoreboard/kiosk no longer render flat gray for banner/minimal rooms, and now show which tournaments feed each ranking group.

- **Theme-derived card background** — banner/minimal rooms' ranking cards (all rankings styles: match, plaque, sidebar; compact keeps its deliberate no-chrome look) get an accent-tinted gradient built from the room theme's CSS variables (`--color-border-glow` over `--color-surface` via `color-mix`), so all 17 public themes flow through automatically. Root cause of the gray: the only themed background source was gated on showcase style — banner/minimal fell back to flat `var(--color-surface)` in every variant. Showcase rooms are background-unchanged.
- **Tournament chips** — each ranking card's header now lists the group's underlying tournaments as small pills colored by tournament type (gold/blue/purple/green — same scheme as Discord embeds, incl. tag-code types like `DG`/`WG-VPXS` via a FE port of `getTournamentColor`; unknown types render gray). Capped at 4 visible + `+N` overflow; chips wrap within the fixed card width.
- **Backend (additive)** — `GET /rooms/:roomId/rankings` group objects now carry `tournaments: [{id, name, type}]` (from the existing `ranking_group_tournaments` join — no schema change). FE tolerates its absence.
- **Tests** — new `tournamentColors` FE suite (5), `rankingsStyle` derivation coverage (3 — closing a pre-existing gap), and 3 backend `RankingService.tournaments` cases.

No DB migration (next free still 113).

---

## [2.30.2] — unreleased

**Kiosk scrollbar polish.** The kiosk page's horizontal card-row scrollbar is hidden entirely (`scrollbar-width: none` + webkit equivalent) — visual noise on a non-interactive TV display. Scrolling still works for the auto-scroll attract mode and incidental touch; the public Scoreboard page keeps its visible thin scrollbar (interactive surface, separate CSS copy).

---

## [2.30.1] — unreleased

**Kiosk auto-scroll attract mode.** When the kiosk's horizontal card row overflows the screen (typical once Kiosk Zoom is raised for TV distance), the row now slowly ping-pongs (40px/s, 3s dwell at each end) so every card gets screen time. Only activates on actual overflow; pauses 10s on any user input (wheel/touch/pointer); skipped under `prefers-reduced-motion`. New room toggle `KIOSK_AUTO_SCROLL` (Settings → Kiosk, default ON) — flows through the existing `KIOSK_` prefix whitelist, no backend changes.

---

## [2.30.0] — unreleased

**S21 — True mobile card layout + kiosk distance tuning.** Retires the mobile `zoom` shrink hack and decouples TV zoom from phone rendering.

- **True mobile layout (≤640px)** — cards render as one full-width column at natural type scale via `.scoreboard-card-slot` overrides (applied to layout wrappers AND the card components' own fixed-px root widths — Banner 280 / Showcase 380 / Minimal 380 / all six RankingGroupCard variants). Smallest text gets +1–2px readability floors (`.sb-fs-*` classes; `!important` so they beat inline `fontSize` styles).
- **`mobileScale` is now an opt-in densifier** — default 0.85 → **1.0** (no shrink unless a room/viewer explicitly sets it); relabeled "Mobile Density" in Settings + viewer prefs. S20's 0.85 was the interim mitigation; this is the promised fix.
- **`SCOREBOARD_ZOOM` no longer applies at ≤640px** on either page (`.scoreboard-page-zoom` gate) — a TV operator's zoom stops re-scaling phone visitors.
- **New `KIOSK_ZOOM` room setting** (Settings → Kiosk, 50–300%, hint recommends 130–150% for TV distance) with back-compat fallback chain `KIOSK_ZOOM → SCOREBOARD_ZOOM → 100` — existing TVs are byte-identical until the operator opts in. Flows through the `KIOSK_` prefix whitelist; zero backend changes.
- **Kiosk ticker** 12px → 16px text, bar height 36 → 46px (S20 safe-area pattern preserved).
- **Showcase secondary-text alpha floors ≥0.55** — glass-deck + neon-circuit `timerColor`/`metaColor` (neon-circuit meta was 0.15, near-invisible) + the hardcoded `cardBgFill` footer branch in `ShowcaseCard`.
- **Field-check fixes (pre-merge, all pre-existing defects surfaced by first real kiosk/mobile inspection):** the activity ticker was a fixed-bottom overlay painting over the Privacy/Terms footer — now mounted in-flow by `PublicLayout` above the footer (scoreboard route only; footer takes over the safe-area inset); both tickers' fixed 60s marquee (crawled on short feeds) replaced with distance-based speed (~70px/s, clamped 15–90s); bottom-anchored kiosk QR codes rendered cut off — the v2.13.3 overhang reservation had only ever been applied to `Scoreboard.tsx`, now mirrored across all six kiosk card-slot wrappers.
- **Tests** — first-ever coverage for `scoreboardConfig` derivation (15 cases: defaults, clamps, kioskZoom fallback chain incl. unparseable-input cascade) + a PublicLayout ticker-placement regression test.

No DB migration (next free still 113).

---

## [2.29.0] — unreleased

**S20 — Mobile & accessibility quick wins.**

- **Hover-only controls now touch/keyboard accessible** — the card submit "+" (ScoreCardGrid), GameDetail self-delete trash, Leaderboard admin toolbar + per-submission delete, StyleCatalogue icons: visible under `@media(hover:none)` and keyboard focus, with ≥44px hit areas.
- **`confirm()`/`alert()` → `ConfirmModal` + toast** in GameDetail, GlobalGameDetail, Leaderboard (remaining admin pages deferred to ROADMAP).
- **Global `prefers-reduced-motion` support** — index.css block for the shared keyframe classes + per-component guards (kiosk ticker, Neon Circuit glow, MysteryAward pulse, score toast).
- **PublicLayout nav** — `NavLink` with visible active state + `aria-current`, per-item aria-labels, small visible labels under icons on mobile, 44px targets (nav items, Discord button, UserMenu trigger).
- **ThemeProvider re-theme + per-slug theme key (S18-deferred)** — theme now derives from `useLocation()` (the "mounts above the router" premise was stale — it's a `BrowserRouter` descendant): admin↔public transitions and room changes re-theme immediately; the per-slug `arcaid-theme-public-<slug>` key is finally READ (was write-only — themes bled across rooms); reserved top-level routes guarded against slug misfire. Review caught + fixed a hydrate-on-every-navigation regression that would have reverted viewer-set personal themes (fails-on-revert regression test included).
- **`color-scheme`** — `.theme-light`/`.theme-coffee` get `color-scheme: light`; the default moved `body` → `html` so the per-theme cascade actually reaches native controls; GlobalCatalogue's hardcoded dark selects fixed.
- **Keyboard/ARIA** — HorizontalScrollNav focusable region + arrow-key scroll + focus-revealed arrows; GameQuickView + ConfirmModal get `role="dialog"`/`aria-modal`/focus management (`NeonButton` converted to `forwardRef` so refs actually work); expandable score rows keyboard-operable in all four implementations, with child-link Enter passthrough.
- **PWA polish** — new maskable 512px icon + real 180×180 apple-touch icon (the old link pointed at a non-square 1131×1189 logo); `viewport-fit=cover` + `env(safe-area-inset-*)` on the top nav and bottom tickers.
- **`mobileScale` interim default 0.6 → 0.85** (superseded by 2.30.0's 1.0).
- **44px touch-target sweep** — platform chips, scoreboard tab strip, ShareButton icon variant, GlobalGameDetail row icons.
- **Tests** — ThemeProvider navigation/per-slug isolation (4 cases) + ScoreList keyboard expand (2 cases).

No DB migration (next free still 113).

---

## [2.28.0] — unreleased

**S19 — Service-worker overhaul.** Kills the manual `CACHE_NAME` bump ritual and the unbounded image cache in `admin-ui/public/sw.js`, without breaking the update path for already-installed PWAs.

- **Build-derived BUILD_ID, no more manual bumping** — `admin-ui/vite.config.ts`'s new `arcaid-sw-build-id` Vite plugin (+ `admin-ui/scripts/swBuildId.ts`) computes a deterministic 12-hex-char id (sha-256 over the sorted built-asset filenames + `index.html` contents) and injects it into `sw.js`'s static cache name at `closeBundle`; throws loudly if the placeholder or `dist/sw.js`/`dist/index.html` are missing. Same build output → same BUILD_ID. `.claude/commands/release-docs.md` step 5 and `update-docs.md`'s doc inventory updated — the SW cache bump is no longer a release-checklist item.
- **Two caches, path-scoped routing** — `STATIC_CACHE` (`arcaid-static-<BUILD_ID>`, a new name every build) covers JS/CSS/fonts/`/assets/*`; `IMAGE_CACHE` (`arcaid-images-v1`, stable across deploys) covers the four image mounts (`/api/catalogue-images`, `/api/styles/images`, `/api/room-assets`, `/api/score-photos`) via stale-while-revalidate, LRU-capped at 200 entries. Image routes are matched before the static-asset extension regex, so they can no longer leak into the static cache — previously unbounded growth (4.9GB / 187k files of catalogue images alone) is now capped.
- **Activate sweep fixed to not eat the image cache** — deletes every cache except the two current names, clearing legacy `arcaid-v###` caches from pre-v2.28 installs and stale `arcaid-static-*` generations from prior deploys, while `IMAGE_CACHE` survives every deploy.
- **HTTP cache headers** (`src/api/server.ts`) — new exported `frontendStaticOptions()` sets `sw.js`/`index.html` to `Cache-Control: no-cache` on both the static mount and the SPA catch-all's `sendFile`/OG-shell response branches, so an installed PWA always revalidates and discovers the new BUILD_ID; `/assets/*` (Vite's content-hashed output) gets `public, max-age=31536000, immutable`.
- **Tests** — new `admin-ui/src/__tests__/sw.test.ts` (activate cache sweep, image/static/network-only routing, LRU eviction, `computeBuildId`/`injectBuildId`) and a new backend `src/__tests__/s19-static-cache-headers.test.ts` asserting the header contract against a fixture dist directory.
- Push notification handlers (S15) untouched, byte-identical.

No DB migration (next free still 113).

---

## [2.27.0] — unreleased

**S18 — RoomContext refactor (frontend-only).** Public pages resolved slug→room data redundantly: 9 raw `fetch('/api/portal?slug=…')` call sites plus 6 public pages fetching the FULL `/api/rooms` list just to resolve slug→roomId. Consolidated into one shared module-level portal cache plus one portal fetch in `PublicLayout`, provided to every child page via the existing `RoomContext`.

- **New `admin-ui/src/lib/portal.ts`** — `getPortal(slug)` returns a shared, module-level cached promise per (lowercased) slug, so concurrent callers for the same slug share one network request. Failed lookups are NOT cached (the map entry is deleted before the rejection propagates), so a transient failure doesn't permanently poison a slug.
- **`PublicLayout`** now does the ONE portal fetch for its entire subtree (dropped its separate full `/api/rooms` list fetch) and provides `RoomContext.Provider` around the `Outlet`/`PlayerQuickViewProvider` — every public page under it gets `{roomId, roomSlug, roomName}` for free via `useRoom()`, no fetch of its own. Loading renders the standard `LoadingState`; a portal 404 renders a friendly "Room not found" state instead of a blank/broken page. The nav-bar lobby-activity-dot poll no longer fetches the portal itself — it now waits on the layout's already-resolved roomId.
- **7 pages converted to `useRoom()`, 2 hooks to the shared cache:** `Scoreboard.tsx`, `Lobby.tsx`, `GameDetail.tsx` (were fetching `/api/portal` directly), plus `PlayerDetail.tsx`, `PublicStats.tsx`, `PublicHistory.tsx`, `ComparePlayers.tsx` (were fetching the full `/api/rooms` list purely to resolve slug→id). `usePickAwardEnabled` and `ThemeProvider`'s room-theme hydration now read through the same shared `getPortal` cache instead of their own private fetches. Five more pages call `getPortal(slug)` directly rather than `useRoom()` because they either sit outside `PublicLayout`'s subtree or need a field (`logo_url`) that isn't in `RoomContextType`'s frozen `{roomId, roomSlug, roomName}` shape: `KioskScoreboard.tsx`, `ScoreSubmit.tsx`, `GlobalGameDetail.tsx`'s `?from=<slug>` branch (standalone, can't sit under the provider), plus `Picks.tsx` and `MysteryAwardPage.tsx` (need `logo_url` for their cabinet backglass art — the portal response already carries it, so this drops their full `/api/rooms` list fetch too, at zero extra network cost since the slug's portal is already cached by `PublicLayout`).

Fetch-elimination tally: portal/rooms-list call sites collapsed from 9 raw `/api/portal` fetches + 6 full `/api/rooms` list fetches (used purely for slug→room resolution) down to 1 shared portal fetch per slug, reused by all 14 consumers. SW → `arcaid-v101`. No migration (backend untouched this sprint).

---

## [2.26.0] — unreleased

**S17 — Frontend performance (Phase D).** No behavior changes for players except faster loads and one filter-correctness fix.

- **Route-level code splitting** — the entire admin surface (both admin layouts + all 21 admin pages) is now `React.lazy`-loaded behind a single Suspense boundary. A player scanning a QR code no longer downloads a byte of admin code; admins pay one spinner on their first admin navigation per deploy. (Bundle numbers in the PR.)
- **`formatScore` centralized** — 11 page/component-local copies (plan said 8; it had grown) collapse into `lib/format.ts` (`formatScore` + `formatCompactNumber` for the LandingPage aggregate tiers). One deliberate keep: PublicStats' 4-tier K-compressor renders genuinely different output. Countdown helpers were already centralized next to `playerName()`; the two remaining variants have different signatures on purpose and were left.
- **GlobalScoreboard's third divergent platform taxonomy retired** — its local groups predated the FX-family split and sent retired tokens (`pinball_fx3`, `vr`) that match no post-migration-094 row, so **FX-era games silently dropped out of the "Virtual Pinball" filter chip; that's now fixed**. Groups + short chip labels now come from `lib/platforms.ts` (new `PLATFORM_GROUPS` + `getPlatformShortLabel` exports, mirroring the backend category taxonomy). One deliberate correction: AtGames moved from the Virtual Pinball group to Physical, matching the backend.
- **Lazy images** — `loading="lazy" decoding="async"` on below-the-header in-card images (score-row avatars, the global catalogue grid art, admin leaderboard style headers, YouTube tutorial thumbs); `decoding="async"` everywhere. Card-header art, page logos, and detail-page heroes deliberately stay **eager** — the first card row is the page's LCP candidate and the kiosk wall is always fully visible (adversarial-review catch).
- **Dead code deleted** — `PinballPicker.tsx` (1,093 lines) + the abandoned `cards/GameCard.tsx` wrapper (~450 lines), both zero-import.
- **Stale ROADMAP corrected** — the "batched score-counts endpoint" follow-up actually shipped in v2.19.0; re-verified and marked done. Folding counts into the leaderboard payload deliberately declined (one saved request isn't worth coupling the responses).

- **Flake-family straggler fixed (backend, 2 files)** — the v2.24.1 drain-hook sweep missed `void`-style fire-and-forgets: `MaintenanceRunService.record` raced the S10 tests' (and Force Maintenance's) read of the trail row — now awaited inside `runMaintenance` (record never throws, so the run can't break); ScoreSyncPoller's two `void OpsAlertService.sendOperatorAlert` calls now register with the background-task tracker. Surfaced by a CI flake on this PR's first run.

SW → `arcaid-v100`. No migration (next free still 113).

---

## [2.25.0] — unreleased

**Report-a-problem: user-filed catalogue corrections + per-field source stamping.** The long-parked ROADMAP feature, unblocked by ADR 0014's source-precedence policy.

- **"Report a problem" on game pages** — a flag link on the room Game Detail (below About This Game, shown when the game maps to a catalogue entry) and on the Global Game Detail hero. Discord-authed only (logged-out viewers get a login prompt in the modal). The form asks what's wrong (name / manufacturer / year / platforms / artwork / duplicate / other), an optional suggested correction, and an optional note. The server snapshots the disputed field's **current** value at filing time (never trusted from the client); duplicate open reports per (game, reporter, field) are rejected with a friendly 409, refiling after resolution is allowed.
- **Super-admin review queue** — new "Game Info Reports" card on `/admin/catalogue` (Open/Resolved toggle). Each report shows the game (with a "game removed" badge if it was merged/deleted since — reports are FK-less with a denormalized name), the disputed field, current → suggested values, the reporter's note, IPDB/OPDB reference links, a "Find in list" shortcut into the catalogue browser, and a **source badge** answering "is this field ours to fix or upstream's?". Resolutions: **Fixed** / **Upstream** / **Dismiss**, each with an optional resolution note.
- **Per-field source stamping (`global_games.field_sources`)** — the piece ADR 0014 deferred to this feature. Every write path now stamps which source last wrote each report-relevant field: catalogue importers via the `GlobalGameService.upsert` chokepoint (fields a source actually supplies get its `imported_from` label), admin manual edits stamp `manual` (presence-based — an explicit clear is still a manual write), and the background image downloaders stamp `artwork`. Legacy rows show "unknown" until a re-sync or edit touches them.
- **Migration 112** — `game_feedback` table (mirrors `score_reports`' shape; partial UNIQUE index blocks duplicate open reports) + the `field_sources` column. **Next free migration = 113.**

New `rap-game-feedback.test.ts` (9 cases: authz, server-side snapshot, duplicate/refile, unknown-game 404, empty-report 400, queue authz + list/resolve lifecycle, report-survives-game-deletion, and stamping at all three chokepoints). SW → `arcaid-v99`.

---

## [2.24.1] — unreleased

**Fix: CI flake — fire-and-forget post-submit chains raced the test DB reset.** The nested-transaction / `SQLITE_MISUSE` flakes (`community-scores-attribution` case (b), 2026-07-15; `room-scores` case (b), 2026-07-18 — the latter blocked the v2.24.0 deploy until rerun) were caused by fire-and-forget chains (lobby feed → achievements/milestones/friend events/notifications/web push, `RoomEventService.log`) still running when the next test reset the shared in-memory DB. New `src/utils/backgroundTasks.ts` — `trackBackground()` registry + `drainBackgroundTasks()` — wraps every such chain (the dynamic-import hops now RETURN the inner promise so the tracked chain settles only when the real work settles); the vitest setup drains before each DB reset. Production behavior unchanged (a Set add/delete per chain). `RoomEventService.log` is tracked at the source, covering its ~14 unawaited call sites at once.

---

## [2.24.0] — unreleased

**S16 — Shareability (Phase C): Web Share + OG link-preview meta.**

- **OG meta injection for link unfurls** — when a link-preview crawler (Discord, Slack, Twitter, Facebook, Telegram, WhatsApp, …) fetches `/:slug/games/:name` or `/:slug/players/:id`, the SPA shell is served with injected `og:title` / `og:description` / `og:url` / `og:image` + `twitter:*` tags, so shared links unfurl with the game or player name, the room name, and catalogue art (game art → room logo → ArcAid logo fallback). Player titles follow the display-resolution rule (`display_name ?? iscored_username`). **Safety contract:** only a curated preview-bot UA list ever receives modified HTML — human browsers always get the byte-identical shell via the unchanged `sendFile` path, every failure mode falls through to the unmodified shell, and the `OG_META_ENABLED` global setting (default on, select on Global Settings) is a kill-switch. New `src/api/ogMeta.ts`; the injection rides the existing SPA catch-all in `server.ts`.
- **Web Share buttons** — new `ShareButton` component (native `navigator.share` sheet where available; clipboard copy + 2s "Copied!" state otherwise): on the room Game Detail hero, the Player Detail action row (next to Follow/Compare), and the post-submit result card ("I'm #1 on Medieval Madness!" / "I'm #4 of 12 on …" with a link to the game's leaderboard — the OG meta above makes that link unfurl rich).

New `s16-og-meta.test.ts` (13 cases: bot-vs-human fall-through, kill-switch, unknown slug, display-name resolution, HTML escaping, catalogue-art og:image absolutization, route parsing incl. malformed encoding). SW → `arcaid-v98`. No migration (next free still 112).

---

## [2.23.2] — unreleased

**Room nicknames become a recognized identity lookup on room stat pages.** Discord OAuth login writes NO `user_mappings` row (a long-standing doc error claimed otherwise) — a player who logs in and submits on the web gets score attribution + a per-room `room_members.display_name` claim, but the name everyone sees them under was invisible to NAME-typed lookups, which read `user_mappings` only (field report: the operator's own alt). The room-scoped resolvers (`comparePlayersHeadToHead.resolve`, `getEnhancedPlayerStatsByUsername`) now fall back to `room_members(room_id, display_name)` when the global alias misses. Global alias always wins; **lookup-only** — no identity records are created, and NULL-attribution synced rows still fold solely via real alias links (per-room first-claim ≠ global alias ownership; the phantom-claim doctrine stands). Side benefit: player pages reached by a claimed nickname now expose `discordUserId`, so Follow gating works for web-native players. Backend-only, no SW bump, no migration. +3 tests.

---

## [2.23.1] — unreleased

**Fix: Compare / streaks / personal bests missed a Discord-linked player's pre-link scores (field report).** Comparing two players on the same leaderboard could return "No shared games yet": rows synced from iScored **before** an alias was Discord-linked carry `submitted_by_user_id` NULL and keyed as `iscored:<alias>` — a key the player-resolution side never produces for a mapped name, so half the player's history was invisible. All three S14/S13 per-player stats queries (`comparePlayersHeadToHead.bestPerGame`, `getParticipationStreak`, `getPersonalBests`) now use the **three-leg identity key** — `COALESCE(submitted_by_user_id, user_mappings.discord_user_id, 'iscored:' || LOWER(iscored_username))` — folding a linked alias's NULL-attribution rows into the mapped user (also collapses phantom split entries in personal-bests room ranks). Backend-only, no SW bump, no migration. +3 regression tests in `s14-social-loops.test.ts` (field-report shape, name-vs-snowflake cluster equality, streak fold).

---

## [2.23.0] — unreleased

**S15 — Web push (Phase C).** Browser push notifications as a second channel beside Discord DMs — opt-in, smallest shippable: `rankDethroned` + `tournamentWin` only.

- **Dispatch inside `NotificationService.notify`** — a push rides the SAME per-type opt-in + rate-limit result as the DM (one event = one budget slot), additionally gated on the user's `webPush` channel flag (in the `notification_prefs` JSON, set when they subscribe a browser) and the `WEB_PUSH_TYPES` allowlist. Fire-and-forget both ways: a push failure never affects the DM, and closed DMs never suppress the push. Payload = per-type title + markdown-stripped first line + deep link (`pushUrl` supplied by the two high-value call sites) + collapse tag.
- **`WebPushService`** — VAPID-signed sends via the `web-push` library; keys live in global settings (`WEB_PUSH_VAPID_PUBLIC_KEY` + `WEB_PUSH_VAPID_PRIVATE_KEY`, the private key added to `ENCRYPTED_SETTING_KEYS` so it's AES-GCM at rest), read through a 10s TTL cache. Both keys unset → the whole feature is inert (S10 OPS_ALERT ship-inert pattern). New `npm run generate-vapid-keys` prints a pair to paste into the super-admin Global Settings page (fields added there, private key masked).
- **Migration 111** — `push_subscriptions` (per-device rows keyed on `discord_user_id`, globally-unique `endpoint`, FK-less by design). Expired endpoints (HTTP 404/410) are pruned at send time; the account-deletion purge (S12) now deletes the user's rows.
- **Endpoints** — public `GET /api/push/vapid-public-key` (`key: null` = unconfigured, FE hides the UI); `POST /api/me/push-subscriptions` (Discord-authed + write-limited; endpoint-keyed upsert + merges `webPush: true` into the user's prefs server-side); `DELETE /api/me/push-subscriptions` (own rows only, device-level — the channel flag deliberately survives so other devices keep receiving).
- **Account Settings — "Browser push"** sub-block in the Notifications card: one device-level toggle (permission prompt → subscribe → server registration, with rollback on server rejection), blocked-permission guidance, iOS install-to-Home-Screen hint, hidden entirely when the server has no VAPID keys.
- **Service worker** — `push` (payload → tray notification) + `notificationclick` (focus an existing tab on the target URL or open one) handlers. SW → `arcaid-v97`.

New `s15-web-push.test.ts` (10 cases: payload shape/deep-link/markdown-strip, every suppress gate, shared rate budget, channel independence, 410 prune vs 500 keep, deletion purge, private-key encryption round-trip). **Migration 111 consumed → next free = 112.**

---

## [2.22.0] — unreleased

**S14 — Social & competitive loops (Phase C).** Built via the established Fable-orchestrated Sonnet workflow (recon → 4 work packages → check → orchestrator review; zero blockers).

- **Follow from player surfaces** — `POST /api/me/friends` now also accepts `{friendUserId}` (Discord snowflake; target verified against `user_profiles`/`user_mappings`, 404 unknown, 400 self; legacy typed-username path untouched). PlayerDetail + PlayerQuickView gain a Follow/Unfollow toggle (Discord-authed viewers, targets with a Discord identity only, optimistic with revert).
- **Head-to-head Compare** — new public `GET /:roomId/stats/compare?a=&b=` on the canonical `score_history` partition (best-per-game per player, alias-collapsed): shared games with leader + gap, exclusive-game counts, win totals. New `/:slug/compare` page (searchable picker; Compare buttons on PlayerDetail/QuickView pre-fill the viewer as the opponent).
- **Participation streaks** — `participationStreak {currentWeeks, bestWeeks}` on the enhanced player stats (SQL `LAG`-based week-consecutiveness — immune to the `%Y-%W` year-boundary trap), rendered as a Weekly Streak stat on both player surfaces (distinct from the champion streak). New `streak_extended` lobby feed event on a player's first score of the week when it extends a ≥2-week run (feed-toggle-gated).
- **Staleness challenge — the dead config knob finally works.** LobbyAdmin has shipped the setting (threshold, default 14d) and the feed renderer since Lobby v1 with **no backend emitter**; a new daily Scheduler job (per-room, `isTypeEnabled`-gated, app-level lookback dedupe, one emission max, per-room try/catch) now emits "It's been N days since anyone scored on X — beat the record!" with the record to beat in metadata.
- **Scoreboard ticker** — kiosk-style fixed-bottom marquee on the public Scoreboard (all three tabs): seeded from the lobby feed, kept live over the `lobby:` WebSocket channel (true push — the kiosk's poll-on-event pattern was not ported), pause-on-hover, `prefers-reduced-motion` fallback, hidden when empty.

Review fixes: compare pre-fill sends the viewer's snowflake (not the raw Discord username the resolver can't parse); `aOnlyGames`/`bOnlyGames` wire-type mismatch; Follow gated on the target having a Discord identity; `display_name` now mapped through on the all-players stats endpoint (pre-existing omission). New `s14-social-loops.test.ts` (follow-by-id, compare w/ alias collapse, deterministic streak week-math, streak-event dedupe, staleness gate/dedupe). SW → `arcaid-v96`. No migration (next free still 111).

---

## [2.21.3] — unreleased

**Safe bulk-merge learns corporate aliases + faithful JP recreations.** The first prod Execute (5 merged / 30 skipped) showed ~26 of the skips weren't real conflicts: (1) **corporate aliases** — the same maker under renamed/rebranded labels (`Alvin G.`=`Alvin G. & Co`, `Sonic`=`Segasa`, `Bell Games`=`Nuova Bell Games`, `MAC`=`Maguinas / Mac Pinball`, `Allied Leisure`→`Fascination`, `Cirsa`=`Unidesa`, `Spinball`=`Spinball S.A.L.`, `International`=`International Concepts`, `Jocmatic`≈`Joctronic`) — now a curated normalized-form alias map in the bulk-merge manufacturer normalizer (which also strips `/` and curly apostrophes); (2) **the `JP's` veto relaxed** — it now only fires when the manufacturer is *also* virtual-only, so JPSalas's faithful recreations of real machines (`JP's The Lord of the Rings (Stern, 2003)`) merge into the real machine's entry while `JP's Cyclone (Original, 2022)` fan tables stay excluded. Genuinely-different-maker groups (e.g. `Stern` vs `Allied Leisure`) still skip for human adjudication. +5 test cases. Backend-only, no SW bump. No migration (next free still 111).

---

## [2.21.2] — unreleased

**Safe bulk-merge surfaced on the Dedup Audit card.** After stripping, the second prod audit run left 35 real-vs-real shared-IPDB groups — exactly what `POST /admin/catalogue/merge-ipdb-duplicates` (the v2.13.0 safe bulk-merge: exact-year match, normalized-manufacturer agreement, community/digital rows excluded, richest-row-wins target selection) was built for, but it had no UI. The Dedup Audit card now has **Preview Safe Bulk-Merge** (dry run — shows mergeable count + per-group skip reasons) and **Execute Safe Bulk-Merge** (confirm-gated; re-runs the audit after). Skipped groups render with their reason (`year-disagreement` / `manufacturer-incompatible`) so the leftovers are a ready-made adjudication list. FE-only. SW → `arcaid-v95`. No migration (next free still 111).

---

## [2.21.1] — unreleased

**Fix: VPS "Not Available" placeholder junk polluted the dedup audit.** The first prod audit run (95 suspects) revealed a third failure mode: VPS ships a literal `"Not Available"` string in its `ipdbUrl` field and the importer copied it verbatim for years — harmless to dedup (unparseable, never matched the IPDB step) but junk in the identity column, and the v2.21.0 routing could even "preserve" it into `based_on_ipdb_url` on virtual rows.

- **Migration 110** — one-shot clear of every unparseable value (no `machine.cgi?id=`) from BOTH `ipdb_url` and `based_on_ipdb_url`; logs counts.
- **`upsert` door check** — unparseable IPDB values in either input field are dropped before routing/dedup, so junk can't re-enter from any importer.
- **Audit** — suspects now require a *parseable* link (real identity claims only); **strip** clears junk outright instead of relocating it to the reference column.

Extends `catalogue-dedup-hardening.test.ts` with junk cases (audit filter, strip-clears, upsert-drop, migration shape). No SW bump (backend-only). **Migration 110 consumed → next free 111.**

---

## [2.21.0] — unreleased

**Catalogue dedup hardening (ADR 0014)** — closes the class of corruption found in the 2026-07-02 prod dup review, where virtual-only tables (Zen Studios originals, `Original` fan tables) carrying the real machine's IPDB link got merged into the physical machine's catalogue identity. Doctrine: **manufacturer is the dedup discriminator** — same real manufacturer + shared IPDB = same machine; virtual-only/missing manufacturer = a different game whose IPDB link is a thematic reference.

- **Guard** — `resolveDedupCandidates`' IPDB step now refuses the match when either side's manufacturer is virtual-only (`isVirtualOnlyManufacturer`: 'Zen Studios'/'Original'/missing), falling through to name matching; covers `upsert` AND `findCandidates` via the shared walker. The old `manufacturerYearAgree` NULL-tolerance was the hole.
- **Routing (migration 109)** — new `global_games.based_on_ipdb_url` reference column; `upsert` normalizes input at the single chokepoint every importer flows through: a virtual-only row's incoming `ipdb_url` moves to `based_on_ipdb_url`, identity stays NULL. Also closes the re-plant hole: `upsert`'s `COALESCE(input, existing)` UPDATE meant every VPS re-sync since the 2026-07-04 strip run could silently restore stripped IPDB links.
- **Admin audit tool** — `GET /admin/catalogue/dedup-audit` (super-admin): state-based scan reporting suspects (virtual-only rows still holding an identity `ipdb_url`) and shared-IPDB groups (unresolved duplicates with a suggested action); `POST …/strip` remediates in-app (moves the link to `based_on_ipdb_url`, idempotent, auto-audited). Surfaced as a "Dedup Audit" card on the Catalogue admin page with per-row/Strip-All actions and merge-modal handoff for mergeable groups (`MergeModal` gained an optional `restrictToIds` prop).
- Source-precedence policy documented in ADR 0014 (real-machine mfr/year: IPDB > VPS > OPDB; external IDs: OPDB; virtual metadata: VPS). Per-field source storage deferred to report-a-problem.

New `catalogue-dedup-hardening.test.ts` (guard refusal + both-real merge, routing on virtual/missing mfr, re-sync re-plant regression, audit + strip idempotency). SW → `arcaid-v94`. **Migration 109 consumed → next free 110.**

---

## [2.20.2] — unreleased

**Three user-reported fixes from the v2.20.x tour (history completeness, game-page stats correctness, non-active game experience).**

- **History showed only recently-completed games** — `GET /:roomId/history` filtered `status='COMPLETED'` while the weekly cleanup flips old games to `ARCHIVED` (the `IN ('COMPLETED','ARCHIVED')` convention used everywhere else in StatsService). Both the admin History page and the public `/:slug/history` now show the full record.
- **Game-page stats missed community scores** — `StatsService.getGameStats` + `getGamePlayerRankings` read `submissions`, but community/freeplay submits write `score_history` only, so a new community high score didn't move Unique Players / Avg / All-Time High / Record Holder. Both now read `score_history` (canonical player partition, orphans excluded); Past Results stays tournament-derived. The rankings rewrite dodges SQLite's bare-column-with-multiple-MAX trap via the `ROW_NUMBER` pattern (a check-agent catch, reproduced empirically: a merged multi-alias user could otherwise show the wrong alias next to their best score).
- **Non-active games get the full page** — the game page only resolved a catalogue id (and leaderboard rows) from the ACTIVE tournament boards, so completed/pinned games had no About This Game section, no leaderboard, no expand/percentile. Now falls back to the room-scores data: an "All-Time Leaderboard" with expandable score-history rows + percentile, plus the About section. `GET /:roomId/score-counts` gains an optional `gameNames` param (name-keyed counts, needed because fallback cards carry catalogue ids, not games-table ids). The Leaderboard tab now also appears for permanently-pinned games.
- **About-section polish** — renders only when the catalogue row has real metadata; the "Unknown manufacturer" placeholder is gone (only present parts render).

New `gamedetail-history-stats.test.ts` (ARCHIVED inclusion, community-score stats, gameNames counts, orphan exclusion, multi-alias best-score alias regression). SW → `arcaid-v93`. No migration (next free still 109).

---

## [2.20.1] — unreleased

**Room game page gains the catalogue's "About this game" metadata** (user request, same-day as S13). The room Game Detail (`/:slug/games/:name`) and the global catalogue page (`/games/:id`) are deliberately separate — room-scoped scores/tournament context vs. the catalogue entity — but the room page never surfaced the catalogue metadata even though it already resolves the game's `globalGameId` (for the Global Leaderboard cross-link). Now, when a room game maps to an approved catalogue entry, the room page renders an "About This Game" section below the tab content: manufacturer/year/type, theme chips, designers, Table Authors, Downloads (`table_download_urls`), Tutorials (`tutorial_urls`, YouTube ids resolved), and References (`rules_urls` + IPDB). Fetched from the existing public `GET /api/global/games/:id`; hidden entirely (and silently) for unmapped games or fetch failures. SW → `arcaid-v92`. No migration (next free still 109).

---

## [2.20.0] — unreleased

**S13 — Trophy case + public history (Phase C Recognition).** Built via a Fable-orchestrated Sonnet workflow (4 work packages + cross-seam check; zero blockers).

- **`player_achievements` (migration 108)** — append-only, FK-less trophy log (the `maintenance_runs` treatment). Three types written from the moments that already detect them: `tournament_win` (TournamentEngine winner resolution; deduped one-per-game via a partial UNIQUE index), `milestone` (MilestoneService threshold crossings, metadata carries scope+threshold), `room_record` (hooked off `isNewRoomTop` directly — independent of the cosmetic feed toggle, same pattern as the dethrone DM). `AchievementService.award` never throws. Migration backfills historical tournament wins from the top `submissions` row per COMPLETED game (matching both live winner derivations), idempotent via INSERT OR IGNORE.
- **Trophies on player surfaces** — `stats/enhanced/player/:identifier` now ships `achievements` (per-type counts + 10 most recent) and `personalBests` (best per game with canonical-partition room rank + total players, cap 50). PlayerDetail gains a Trophies section + Personal Bests table; PlayerQuickView gains a condensed counts strip; GameDetail's player expand gains a "Top X%" percentile line.
- **Public history page** — new `/:slug/history` (the `GET /:roomId/history` endpoint was already public; the page was admin-mounted only). Winner + score + date per completed game, paginated, type filter; linked from the public Stats page.
- New `s13-achievements.test.ts` (backfill idempotency, win dedup, cross-identity `getForPlayer`, endpoint shape with room ranks).

SW → `arcaid-v91`. **Migration 108 consumed → next free 109.**

---

## [2.19.0] — unreleased

**Hardening: batched score-counts + community-scores attribution.** Two pre-beta trust/stability fixes, built via a Fable-orchestrated Sonnet workflow.

- **Batched score-counts** — new `GET /:roomId/score-counts?gameIds=…` (cap 100, one grouped `VALUES`-join query with the exact same per-game semantics as the single-game route, every requested id pre-seeded so callers get a stable key set) + a FE request coalescer (`scoreCountsBatcher.ts`, 50ms window, per-room dedupe + chunking, resolves `{}` on failure so cards degrade instead of throwing). A 48-card Room Scores page now fires **1** counts request instead of 48 — the burst that brushed the 100/min per-IP limiter in the v2.18.1 incident. The single-game route stays for `GameDetail`.
- **Attribution spoof closed** — `POST /:roomId/community-scores/:gameName` no longer reads `discord_user_id` from the request body (a guest could attribute a score, and its global fan-out, to any Discord user). Attribution now derives exclusively from the verified Bearer token (`req.user.discordId`); the field is removed from `CommunityScoreSchema`. Audit of every other `submitScore` call site (global routes, freeplay, pick-award, Discord command) confirmed none trust client-supplied ids. New `community-scores-attribution.test.ts` (guest spoof rejected, authed spoof overridden by token, non-regression).
- CLAUDE.md corrections: documented the `community_scores` → `score_history` dual-write (score_history is the physical union — the fact whose absence misled the v2.18.0 design agents) and removed the phantom public `/catalogue` route from the standalone-pages list.

SW → `arcaid-v90`. No migration (next free still 108).

---

## [2.18.1] — unreleased

**Fix: Room Scores tab infinite fetch loop (v2.18.0 launch-day bug).** `RoomScoresView` put the object returned by `usePlayerHeaders()` into its `fetchPage` `useCallback` deps — but that hook builds a **new object every render**, so the first-page effect refired on every render: each cycle toggled `loading`, unmounting/remounting all 48 cards, and every remounted card's `useScoreExpand` re-fetched `score-counts/:gameId` on mount. The resulting request storm tripped the 100/min per-IP rate-limit backstop, 429ing everything including `/room-scores` itself — the tab blipped in and out with a permanent spinner. Fixed by deriving the Authorization header inside `fetchPage` from the stable `playerToken` string (already destructured from `useViewerAuth()`) and depending on that. The Tournaments and Global tabs were unaffected (neither has the headers object in a dep array). SW → `arcaid-v89`.

---

## [2.18.0] — unreleased

**Scores-page redesign — Tournaments | Room Scores | Global.** The room Scoreboard's fragmented "All Games" tab (a community-only "Played at" list plus a scoreless catalogue browser) is replaced by three top-level tabs, each a real score scope. Built via a multi-agent design/judge → implement → adversarial-verify workflow per the session's execution directive.

*Room Scores (new).* Every score ever set in the room, best-per-player-per-game across sources. Served by the new `RoomScoresService` reading `score_history` alone — it is already the physical union (community submits dual-write into it), and the admin wipe path deletes `score_history` but deliberately not `community_scores`, so a literal two-table union would resurrect admin-wiped scores. The ranking query is the exact canonical partition from `LeaderboardService.recalculate` minus the tournament-window filter, so Tournaments, Room Scores, and Global agree on player identity; `display_name` now resolves via `user_profiles` (the old community endpoint never JOINed it — multi-alias users rendered under raw iScored names). Endpoint renamed `GET /:roomId/community-leaderboards` → `/:roomId/room-scores` (single grep-verified consumer, no alias) returning `{data, total, hasMore}` with symmetric offset pagination, server-side search, Recent/A–Z/Most-played sort, and a best-effort per-card `viewerEntry` ("Your best — Rank #N") from an optional player Bearer.

*Global (new lens).* Per-game global top scores inside room chrome, bounded to games that actually have global scores via a new opt-in `hasScores` flag on `GET /api/global/scoreboard` — flag absent leaves the standalone `/scoreboard` byte-identical (regression-tested). Cross-link banner to `/scoreboard`; card submits keep the freeplay path.

*Catalogue browsing* leaves the scores page: role-aware link (room admins → Game Library, everyone else → the Global Scoreboard).

- **Migration 107** — one-time backfill of legacy pre-dual-write `community_scores` rows into `score_history`, double-guarded: an idempotent twin check plus a `deleted_score_suppressions` tombstone check so admin-wiped scores are never resurrected. Logs the candidate count (expected ~0 on prod).
- **FE** — new shared `ScoreCardGrid` (one card renderer for all three tabs, extracted from the deleted `GamesTabView.tsx`), `RoomScoresView`, `GlobalScoresView`, and a centralized `scoresCopy.ts`. Legacy `?tab=all-games`/`games`/`played-here` URLs redirect and normalize to `?tab=room`; `GameDetail`/`GlobalGameDetail`/`GameQuickView` back-links echo the new tabs. Tournaments tab body unchanged.

Adds `room-scores.test.ts` (cross-source best, multi-alias collapse, display-name/`iscored:*` resolution, canonical player_count, orphan exclusion, search/sort/pagination, viewerEntry incl. bad-token 200, agreement with `/leaderboard`, 404 on the old path, migration idempotency + suppression guard) and `global-scoreboard-hasscores.test.ts`. SW → `arcaid-v88`. Migration 107 consumed → next free 108.

---

## [2.17.0] — unreleased

**S12 — Privacy floor.** Account deletion, Terms/Privacy pages, and photo-on-delete cleanup — the data-rights baseline before public beta. Built via a multi-agent audit → design → implement → verify workflow; a dedicated completeness lens independently re-derived the schema and confirmed the purge misses no table.

*Account deletion (anonymize-and-keep-scores).* `DELETE /api/me/account` (self, Discord-authed) + an admin-assisted `DELETE /api/admin/users/:id` (super-admin), both audit-logged, via a new transactional `AccountDeletionService`. It **deletes** all personal/identity data — `user_profiles`, `user_mappings`, `user_preferences`, `sessions`, `room_members`, friendships (both directions), comments + ratings (room and global), per-room/super-admin grants, the milestone ledger — and **anonymizes** the score rows: identity columns are stripped (attribution nulled; a `DELETED` sentinel on NOT-NULL id columns) while `iscored_username` + score stay, so leaderboards and rankings remain intact and de-identified. Proof-photo files are deleted from disk and `photo_url` nulled. Documented policy carve-outs: `user_bans` are retained (abuse-evasion prevention — legitimate interest), `merge_records` / `score_reports` are kept-but-anonymized, `audit_log` is retained, and guest `anon_room_claims` are untouched (device token, not the account).

- **Terms of Service + Privacy Policy** — new public `/terms` and `/privacy` pages (footer-linked) covering what's collected, why, retention, and the deletion path. **Starter copy — needs operator/legal review before launch** (contact, jurisdiction, entity, liability).
- **Photo-on-delete cleanup** — the existing per-row and admin score-delete paths (room + global) now delete the proof-photo file from disk, not just the DB reference.
- **Delete-account UI** — a type-to-confirm Danger Zone in Account Settings that calls the endpoint and logs the user out.

Adds `AccountDeletionService`, the `scorePhotoCleanup` util, and `s12-account-deletion.test.ts` (24 cases: every table purged/anonymized, scores survive de-identified, cross-user isolation, authz tiers). SW → `arcaid-v87`. No migration.

---

## [2.16.1] — unreleased

**Fix: S11 broke game comments in login-required rooms.** S11 mounted `conditionalRequireDiscordUser` on the room comment GET/POST/DELETE routes, which enforces the room's `REQUIRE_DISCORD_LOGIN` setting — but the comment form sends no Bearer token, so in a login-required room (the default for new rooms) the comment routes returned **401 for everyone** (guests *and* logged-in users): viewing showed an empty section, posting silently failed. Comments/tips are lower-stakes social content that stayed open to guests pre-S11. Fixed with a new `optionalDiscordUser` middleware — decodes a token when present (so the S11 author/admin delete-authz tiers still work when a client sends one) but **never blocks** — swapped onto all three comment routes. The score-submission gate (`community-scores`) is unchanged and still honors `REQUIRE_DISCORD_LOGIN`. Regression tests added (guest POST/GET in a login-required room; score gate still 401s).

---

## [2.16.0] — unreleased

**S11 — Trust & safety hardening.** Guest-write rate limiting, an authorization sweep, and input-validation hardening across the public API. Built via a multi-agent audit → implement → verify workflow; the adversarial verify pass surfaced several gaps beyond the initial scope, fixed here.

*Rate limiting.* Dedicated limiters now guard every guest-writable route that previously sat on only the 100/min general backstop: room community-scores, comments (POST + DELETE), and ratings; global submission-drafts (POST / commit-as-guest / DELETE) and rating; plus the account-creating `invite/accept` (now at the 5/min auth tier) and the Discord-lookup `submit/anonymous-check`. New `guestContentLimiter` (10/min) for comment/rating spam — keyed on IP, **not** the client-controlled `x-user-id` header (which could be rotated to bypass it).

*Authorization.* Room comment-delete now enforces tiered authz mirroring the score-history delete (super-admin → any; room-admin → any in their room; author → their own) with a cross-tenant room-scope guard. The comment-list endpoint no longer discloses other users' author ids (each caller sees only their own), closing a broken-access-control hole where a stranger could read a comment's id and replay it as `x-user-id` to delete it.

*Input validation.* Score values are bounded at `MAX_SCORE` (1e15, below 2^53) on the three submit schemas **and** on the two inline-parsed global paths (`/global/scores`, submission-drafts) — guards against precision-loss / overflow leaderboard poisoning. Uploaded images are validated by magic bytes (PNG/APNG, JPEG, WebP) after multer rather than by the spoofable client MIME type, across all room/global/admin upload routes.

*Deferred (tracked for follow-up):* comment moderation for password/local (non-Discord) admins needs token-bearing FE wiring (→ S22 moderation); `community-scores` still trusts a client-supplied `discord_user_id` for attribution; room ratings key on `x-user-id` and aren't room-scoped in `RatingService`.

Bumps SW cache to `arcaid-v86`. Adds `s11-trust-safety.test.ts` (rate-limit enforcement, comment-delete authz tiers, score caps, upload magic-byte checks).

---

## [2.15.2] — unreleased

**Help search reworked into a real in-page find** — replaces the section-filter-only search that just hid non-matching sections.

- **Highlights every occurrence** of each search term across the whole guide, via the CSS Custom Highlight API (no DOM mutation, so it's safe against React re-renders; degrades gracefully to jump-to chips where the API is unavailable).
- **Match navigation** — a live match count + prev/next (‹ / › buttons, or Enter / Shift+Enter) that scrolls to and emphasizes the current hit in cyan while all other hits stay amber.
- **Multi-term** — space-separated terms are each highlighted.
- **Stops hiding content** — the sidebar TOC now always shows all sections, with a per-section match-count badge, instead of filtering everything else away.

`::highlight()` styling lives in `admin-ui/src/index.css` (lightningcss warns it's an unrecognized pseudo-element but preserves it in the output). Bumps SW cache to `arcaid-v85`.

---

## [2.15.1] — unreleased

**Help guide brought current + made searchable, plus a Tournaments timezone polish.** Follow-up to S10.

*Help search.* A top-of-page full-text search on the room-admin Help guide (`admin-ui/src/pages/Help.tsx`), indexed by walking the rendered content once after mount (no per-section rewrite). Filters the sidebar TOC and surfaces clickable jump-to chips — works on mobile where the sidebar is hidden; `✕` clears.

*Help currency — all 14 sections.* A 3-agent content audit found the guide had drifted 3–4 sprints behind the app; corrected throughout: Settings reorg (read-only Game Room, Integrations + Kiosk cards, 17 themes, QR/Zoom moved to Leaderboard Display, dead Tournament Defaults / Platforms / System Actions cards removed), Game Library = the shared global catalogue (correct Add Game / CSV flows, Pin/Tag/smart search), Tournaments (Pause/Resume, delete-with-auto-deactivate, the S10 Last-run/Next-fire columns, corrected field labels + platform-rule semantics), the Dashboard System Status health card, missing Discord commands (`/ping`, `/arcaid-notifications`) + corrected `/setup`, corrected public routes (Picks, Lobby, Global Scoreboard, Friends), Game States (Reconcile iScored, Archived status), and the Leaderboard Manage Scores modal + Suppressions.

*Tournaments "Next fire" timezone.* The Next Fire column now renders in each tournament's configured timezone with an abbreviation (e.g. "Tue, 10:00 PM CDT") so it agrees with the Schedule column instead of the viewer's browser-local time.

Bumps SW cache to `arcaid-v84`.

---

## [2.15.0] — unreleased

**S10 — Room-admin observability + alerting.** Turns "why didn't my game activate / is sync down?" from an undiagnosable mystery into a real in-product health surface, plus a server-level alert on sustained iScored-sync failure and an in-app version/build display.

*Real health, not env-var theater.* The Dashboard "Bot Online" dot was `!!(DISCORD_BOT_TOKEN && DISCORD_CLIENT_ID)` — env-var presence, not connection state. `DiscordClient` now exposes `isReady()` / `isInGuild(guildId)` via a module-level `getDiscordClient()` accessor (the gateway `Client` was previously unreachable from route code), so the new health card reports genuine gateway readiness + guild membership.

*`GET /:roomId/admin/health`.* Aggregates Discord readiness, `ScoreSyncPoller` sync status (per-account last-success / last-error timestamps via a new `getStatus()`), per-tournament last-run outcome + next-fire time, and the running version. The Dashboard renders it as a live health card (30s poll); the Tournaments page gains "Last run" + "Next fire" columns.

*Maintenance-run trail (migration 106).* `runMaintenance()` now records a `maintenance_runs` row (success / skipped / error + summary + duration) for every cron and forced run, so failure paths are finally admin-visible. `MaintenanceRunService` reads latest-per-tournament for the health surface.

*Force Maintenance tells the truth.* `POST .../game-states/force-maintenance` now **awaits** the run and returns its real outcome, replacing the optimistic "triggered" response + blind 3s refetch; the Game States page reports what actually happened.

*Operator alerting (ships inert).* After 5 consecutive `ScoreSyncPoller` failures for one iScored account, `OpsAlertService` fires a one-time Discord DM to `OPS_ALERT_DISCORD_USER_ID` (re-armed on recovery). Gated behind `OPS_ALERT_ENABLED` (default off) — zero behavior change until a super-admin configures it.

*In-app version display.* `GET /api/version` → `{ version, commit, builtAt }` (version from root `package.json` via `npm_package_version`; commit/builtAt baked as Docker build-args in `deploy.yml` + `Dockerfile`). Shown on the Dashboard health card + Help footer. Distinct from the SW cache counter.

*Tests.* New `s10-observability.test.ts` — OpsAlert gating, poller alert-once/re-arm debounce, and maintenance-trail success/skipped/error (via the S2 fake-client seam). Full suite 229/229.

Bumps SW cache to `arcaid-v83`.

---

## [2.14.0] — unreleased

**Dependency + platform modernization: the entire Dependabot backlog cleared (16 PRs), and production moved to Ubuntu 24.04 (noble) + Node 24 + sqlite3 6.** Plus a super-admin Backups Delete button.

*Dependency overhaul (16 Dependabot PRs).* Safe minor/patch group (`actions/checkout` 6→7, admin-ui minor/patch ×11, backend minor/patch ×13 — including `playwright` 1.58→1.61, which required a coordinating Dockerfile base-image bump to keep the pinned browsers in sync). Admin-ui majors (#43): **vite 7→8 (Rolldown bundler)**, `@vitejs/plugin-react` 6, TypeScript 6, ESLint 10, lucide-react 1, react-easy-crop 6, `@types/node` 26, globals 17, uuid 14 — validated on both glibc and musl. Backend majors (#44): uuid 14, TypeScript 6, `@types/bcryptjs` 3.

*Production OS migration (#46).* sqlite3 6.0.1's prebuilt binary requires glibc ≥ 2.38, which the jammy base (glibc 2.35) lacks, so the production image moved **`playwright:v1.61.1-jammy` → `-noble`** (Ubuntu 24.04, glibc 2.39). Noble ships Node 24, so the prod runtime is now Node 24 (pinned via NodeSource `setup_24.x`; the Docker build stages stay Node 20). `arcaid` is pinned to **uid 999** so it can write the existing 999-owned `/app/data` — a UID mismatch (noble's default 997) caused a `SQLITE_READONLY` crash on the first attempt (#45, reverted), diagnosed by reproducing against a copy of the prod DB. Added a `.dockerignore` (the repo had none).

*Backups Delete button (#47).* `DELETE /api/admin/backups/:name` (super-admin, auto-audited) + `BackupService.deleteBackup` (path-traversal guarded, refuses the shared assets-mirror) + a per-row Delete button/confirm modal on the super-admin Backups page. Closes the gap that let backups accumulate until prod hit 100% disk.

Bumps SW cache to `arcaid-v82`.

---

## [2.13.16] — unreleased

**Public-side player names now open a lightweight `PlayerQuickView` modal on click + `PlayerDetail` back link respects originating tab.** Same UX pattern as `GameQuickView` from v2.13.12.

*New `PlayerQuickViewContext`* (`admin-ui/src/contexts/PlayerQuickViewContext.tsx`) provides `open({ slug, entry, fromTab })`. The provider renders the modal itself; descendants only need the hook. Wrapped around the `<Outlet />` in `PublicLayout` so any public-side page can trigger it.

*Modal content (lightweight preview).* Header: avatar + display name + iScored alias when different. Stats grid: Games / Wins / Win % / Avg Finish / Top 5 % / Streak (sourced from the existing `/api/rooms/:roomId/stats/enhanced/player/:id` endpoint — no schema changes). Best Game callout. Top 5 recent scores list. Footer: "View full player page →" (links to `/:slug/players/:name?from=<slug>&tab=<tab>` so the full-page back link returns to the correct view) and "All Players →" (keeps the existing entry point visible from the modal). ESC closes, click-outside closes, body scroll locked while open.

*New `PlayerNameLink` component* (`admin-ui/src/components/PlayerNameLink.tsx`) wraps a player name in a `<Link>` whose `to=` is the real PlayerDetail URL with `?from` + `?tab` threaded, AND intercepts plain left-click to open the modal via context. Modifier-click (ctrl/cmd/shift) falls through to native navigation so middle-click and "open in new tab" still work. Accepts `style` + `className` + caller `onClick` (for parent-row stopPropagation patterns). Replaces all 6 inline `<Link to={`/${slug}/players/${name}`}>` call sites across the public side: `BannerCard`, `MinimalCard`, `ScoreList`, `ShowcasePodium`, `GameDetail`, `PublicStats`.

*`PlayerDetail` back-link.* Now reads `?from` + `?tab` via `useSearchParams()`. When `from` is present (set by `PlayerNameLink` or the modal's full-page link), renders two header links: `← Back to Leaderboard` (to the originating room) AND `All Players` (kept available as before). Without `from`, falls back to the original `← All Players` single link. Fixes the v2.13.0 regression where users coming from a leaderboard had no path back besides browser-back.

*Mobile sizing.* Modal uses `items-start sm:items-center` so small screens land it at the top (better when content is taller than viewport), `w-full max-w-md` for fluid sizing with a cap on tablets+, `max-h-[90vh] overflow-y-auto` so internal scrolling kicks in for long content, `p-3 sm:p-4` for tighter padding on mobile. ESC won't fire on touch but the X button + tap-outside-to-close both work.

Bumps SW cache to `arcaid-v68`.

---

## [2.13.15] — unreleased

**Leaderboard horizontal scroll: arrows extend to viewport edges + click-and-hold drag-to-scroll.** Two enhancements to the v2.13.14 edge-hover nav.

*Arrows now reach the viewport edge.* Pre-fix the arrow buttons sat at the wrapper's left/right edges, which left a clickable gap between the wrapper and the actual browser edge — clicks in that gap did nothing. Refactored `HorizontalScrollNav` to render the arrow buttons via `createPortal` to `document.body` at `position: fixed` with width computed as `wrapperRect.left + zone` (left arrow) and `viewportWidth - wrapperRect.right + zone` (right arrow). The chevron icon stays anchored to the visible edge (`justify-start` / `justify-end` with `pl-3` / `pr-3`); the rest of the button is a transparent click target that extends to viewport edge. Hover detection moved from `onMouseMove` on the wrapper to a document-level `mousemove` listener so cursor in the viewport-edge gap still triggers the arrow.

*Drag-to-scroll on the card area.* Mousedown on a non-input element starts tracking; once cursor movement exceeds `dragThresholdPx` (default 5px) it engages drag mode — `cursor: grabbing` on body, `userSelect: none` to prevent text selection, `scrollLeft` follows the cursor delta. On mouseup, if drag was engaged the upcoming click event is suppressed via a one-shot capture-phase listener so a card title click that turned into a drag doesn't also open the QuickView modal. Movement under threshold passes through normally — quick clicks on titles still open the modal. Touch unaffected — native swipe still handles horizontal scroll, and the drag listeners check for mouse-button only.

Bumps SW cache to `arcaid-v67`.

---

## [2.13.14] — unreleased

**Public leaderboard horizontal scroll: scrollbar replaced with edge-hover arrow controls.** New `HorizontalScrollNav` component wraps the horizontal-scroll layout's card row. Behavior:

- Scrollbar hidden (CSS — `.scoreboard-hscroll-layout` and `.scoreboard-hscroll-nobar` both set `scrollbar-width: none` and `::-webkit-scrollbar { display: none }`).
- Two arrow buttons (chevron left / chevron right) sit absolutely positioned over the wrapper's left and right edges.
- An arrow is visible only when (a) the cursor is within ~120px (or 15% of the wrapper width, whichever is smaller) of the corresponding edge, AND (b) there's actually more content to scroll in that direction (`scrollLeft > 0` for left; `scrollLeft + clientWidth < scrollWidth` for right). At the leftmost position the left arrow stays hidden even on hover; at the rightmost position the right arrow stays hidden — matches the user's "if there's no more cards to display, don't show" requirement.
- Click → smooth scroll by 400px. Mousedown sustained → after a 280ms delay, continuous scroll kicks in at 18px/frame so a held button glides through the list. Quick click only fires the chunk.
- Cleanup on mouseleave/mouseup/unmount cancels any pending hold timers + intervals.
- Touch / mobile unaffected: `mousemove`/`mousedown` don't fire on touch so arrows stay hidden; native swipe still scrolls because the container keeps `overflow-x: auto` (just with the scrollbar visually removed).
- `ResizeObserver` on the scroll element re-checks `canLeft`/`canRight` when content or container width changes (cards added/removed, sidebar toggle, window resize).

Currently wired into `Scoreboard.tsx` (public leaderboard) only. `KioskScoreboard.tsx` still uses the same `.scoreboard-hscroll-layout` class so its scrollbar is also hidden, but no arrow nav is added there (kiosk auto-scrolls and isn't mouse-driven).

Bumps SW cache to `arcaid-v66`.

---

## [2.13.13] — unreleased

**Three follow-up fixes to v2.13.12** — the GlobalGameDetail nav still said "Scoreboard", clicking the per-card "i" info icon was also firing the new GameQuickView modal, and the resulting info bubble was clipped by the card's `overflow: hidden`.

*GlobalGameDetail nav text:* `GlobalGameDetail.tsx`'s secondary "Scoreboard" link and the "Global Scoreboard" not-found copy both renamed to "Leaderboard" / "Global Leaderboard". v2.13.12's terminology sweep updated the `to=` href via the `backToRoomHref` refactor but left the visible text unchanged in two spots.

*Info-icon click no longer triggers the quick-view modal:* `handleTitleClick` in both `Scoreboard.tsx` and `GamesTabView.tsx` now bails early when `e.target.closest('button')` is truthy — defense-in-depth in case `e.stopPropagation()` inside the `GameInfoPopup` button doesn't reliably block the parent `<Link>`'s onClick in production builds.

*Info bubble visibility:* `GameInfoPopup` refactored to render the bubble via `createPortal` to `document.body` with `position: fixed` coordinates computed from the trigger button's `getBoundingClientRect`. Pre-fix the bubble was `position: absolute` inside the trigger's wrapper, which sat inside a card with `overflow: hidden`, so the bubble (positioned above the icon) was clipped at the card's top edge and invisible. Now it floats above all card chrome at `z-[60]`. Added ESC-to-close and scroll-to-close handlers. The trigger button's click also now calls `e.preventDefault()` in addition to `e.stopPropagation()` for stronger isolation from the parent `<Link>`.

Bumps SW cache to `arcaid-v65`.

---

## [2.13.12] — unreleased

**Four targeted fixes shipped together** — Overall Rankings query correctness, game-info navigation, QR positioning + sizing, and a Scoreboard→Leaderboard terminology sweep.

*Overall Rankings query rewritten to read from `score_history` filtered by `submitted_during_tournament_id` matching the game's owning tournament — mirrors `LeaderboardService.recalculate`'s pattern. Pre-v2.13.12 the query read from `submissions` filtered only by `games.tournament_id`, which mis-attributed scores submitted via the community/freeplay path (`source = 'community'`, `submitted_during_tournament_id = null` in score_history) because submissions doesn't carry submission-time tournament context — `submissions.game_id` was set to the matching tournament game's id, and the query treated it as a tournament-window score. Confirmed on prod: mekelburgj's 450,000 on Black Rose was a community submission landing in Daily Grind Overall as 100 points / 1 game played, despite no tournament-window context. After fix, that row is correctly excluded (its score_history row has `submitted_during_tournament_id = NULL`). Per-row deletes naturally fall out — the watermark was also updated to source from `score_history` so per-row deletes invalidate the cache correctly. Multi-alias collapse via `COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))`. Old cache rows auto-invalidate on first read after deploy (different watermark formula).*

*Game-info navigation — back link now preserves the originating tab.* `titleLinkTo` constructions in `Scoreboard.tsx` (tournament cards) and `GamesTabView.tsx` (All Games cards) append `&tab=tournaments` / `&tab=all-games`. `GlobalGameDetail` and `GameDetail` read the `tab` query param and use it in the back link. Pre-v2.13.12 `GlobalGameDetail` hardcoded `?tab=all-games` so users who started on the Tournaments tab landed on All Games after going through any global-page round trip.

*Game-info lightweight modal preview.* New `GameQuickView` component, triggered by plain left-click on a card title. Modal shows top 10 scores + game image + catalogue metadata (manufacturer, year, platforms). Footer links: "View full info →" (navigates to `GameDetail` with tab preserved) and "Global Leaderboard →" (navigates to `GlobalGameDetail` when `globalGameId` is present). Modifier-click / middle-click / right-click on the title falls through to the underlying `<Link>` so users can still open the full page in a new tab. Wired into both `Scoreboard.tsx` (tournament cards) and `GamesTabView.tsx` (All Games cards) via the existing `titleLinkOnClick` prop on `CardRouter`. Also renamed the "More info →" link in `GameDetail`'s header to "Global Leaderboard →" since that's its actual destination.

*QR codes: new bottom-edge overlap setting + bigger default size.* New `SCOREBOARD_QR_OVERLAP_PX` setting (default 10) controls how many pixels the QR overlaps the card's bottom edge — 0 = QR touches the bottom edge from below, higher = more of the QR sits inside the card. Applies to both `bottom-right` and `bottom-center` QR positions (was bottom-center only; `qrBottomMetrics` refactored to handle both). Bumped default `SCOREBOARD_QR_SIZE` from 24 → 30 (~25% larger) for easier phone scanning at desk distance. Layout reservation (`cardMarginBottom`) updated to use the new overlap so the QR's overhang is properly reserved below the card. Threaded `qrOverlapPx` through `CardRouter` → all 3 card variants (Banner/Showcase/Minimal) and through both `Scoreboard.tsx` and `KioskScoreboard.tsx`. New setting exposed in `ScoreboardPreferencesModal`'s Advanced section.

*Terminology sweep: visible "Scoreboard" → "Leaderboard" across the app.* ~25 user-visible strings updated across `GameDetail`, `GlobalScoreboard` (page title), `GameLibrary` (Pin dialog), `GlobalSettings`, `Settings` (descriptions + section heading + dropdown options + toggle labels), `Help` (admin help tables), `Tournaments` (admin descriptions), `LandingPage`, `ScoreSubmit` (back link), `GameRoomManager` (admin column header), `Rankings` (display style picker labels), `ScoreboardPreferencesModal` (QR mode option + Rankings Card Style option + description text), `GameQuickView` (links + descriptions), and `Scoreboard.tsx` (tabs aria-label). URL paths, code identifiers, setting keys (`SCOREBOARD_STYLE` etc.), DB columns, and API paths intentionally kept unchanged — backward compat. One link description ("global ArcAid Leaderboard at arcaid.app/scoreboard") keeps the URL path literal.

Bumps SW cache to `arcaid-v64`.

---

## [2.13.11] — unreleased

**Ranking-card variants now stretch vertically to match the tallest game card in their row.** Follow-up to v2.13.10 — width parity was fixed but height wasn't. The ranking cards sat at their natural ~150px content height while game cards next to them filled 700px+, leaving an awkward gap below the rankings cards.

*Root cause:* in horizontal-scroll and grid layouts the parent flex/grid container has default `align-items: stretch`, so the immediate wrapper around `<RankingGroupCard>` (lines 454/494/532 in `Scoreboard.tsx`) does stretch to the row's max height. But the `outerWrap` div inside that wrapper had no `height: 100%`, so it collapsed to its content height. The inner card's `height: 100%` then resolved against the already-collapsed `outerWrap`, not the stretched outer slot.

*Fix:* added `height: '100%'` to `outerWrap` in `ScoreboardComponents.tsx`. Safe across layouts — in horizontal scroll and grid the value fills the stretched slot; in vertical layout the parent's height is indeterminate so `100%` falls back to `auto` (natural content height stays).

*Compact variant only — internal layout:* added `display: flex; flexDirection: column; height: 100%` to Compact's inner div and wrapped the rankings rows in a `flex: 1` div, so the footer ("X players · METHOD") floats to the bottom of the stretched slot instead of hugging the header. Plaque and Sidebar already had this distribution via their existing `flex-1` body div.

Bumps SW cache to `arcaid-v63`.

---

## [2.13.10] — unreleased

**Ranking-card variants (Plaque / Compact / Sidebar) now occupy the same slot dimensions as game cards and align with their top edges.** Follow-up to v2.13.9 — the new variants were rendered at intrinsic widths (220 / 320 / 180px) that made the layout look unbalanced beside game cards, and they didn't apply the 42px showcase top-padding so they sat above the game-card top edge.

*Width:* all three variants now derive their inner card width from the parent scoreboardStyle (showcase/minimal=380, banner=280, other=320) instead of fixed values. Visual distinction comes from internal rendering — frame, typography, chrome — not footprint. `rankingsStyleWidth()` removed; `RankingsColumn` / `RankingsRow` reverted to the original game-card-width logic.

*Top-edge alignment:* a new `outerWrap` helper in `RankingGroupCard` applies `paddingTop: 42` when scoreboardStyle is `showcase` (matching the existing showcase ranking variant's pattern). Removed the v2.13.9 `RankingsColumn` change that stripped column-level topPad for non-match styles.

*Mobile vertical centering:* `outerWrap` is a `display: flex; justifyContent: center` container so the inner card centers horizontally within its slot whenever the slot is wider than the card — covers mobile vertical layout and any narrow-slot edge case.

*Sidebar header content:* replaced the literal "Rankings" label with a two-line header — small "OVERALL" eyebrow + `{group.name}` as the main title. Players can now tell which ranking group the card represents (e.g., "Daily Grind Overall" vs "Monthly").

Bumps SW cache to `arcaid-v62`.

---

## [2.13.9] — unreleased

**Overall Rankings cards can now be styled independently of game cards.** Three new ranking-card treatments — Plaque, Compact List, Sidebar Block — plus the existing Match-Scoreboard default. Addresses the problem where the rankings card mirrored game-card layout 1:1 (same header, same body shape, same width) and read as "yet another game card" on the scoreboard.

*New setting key `SCOREBOARD_RANKINGS_STYLE`* in `game_room_settings`. Reader in `admin-ui/src/lib/scoreboardConfig.ts` validates against `{match, plaque, compact, sidebar}` and falls back to `match` for unknown/missing values, so existing rooms see no visual change.

*Renderer in `RankingGroupCard`* (`admin-ui/src/components/ScoreboardComponents.tsx`) — three new early-return branches before the existing showcase/minimal/banner trio. When `rankingsStyle === 'match'` the legacy 3-branch logic runs unchanged. The new variants borrow theme tokens (card background, border color, title color, fonts, Google-fonts href) from the active showcase theme when one is set, so a Glass-Deck-flavored Plaque looks Glass-Deck-y rather than generic. `RankingsColumn` / `RankingsRow` derive their container width from the new style's intrinsic width (plaque 220px, compact 320px, sidebar 180px) instead of the parent scoreboard style's width.

- **Plaque** — tall + narrow (220px) hall-of-fame frame with double-border outline, centered rank/name/score stack per entry, ✦ glyph above the title. Reads as a commemorative object distinct from any game card.
- **Compact List** — text-only, no card chrome, dotted leaders between name and score. Quietest variant; great when rankings are reference info that shouldn't compete for attention.
- **Sidebar Block** — narrow (180px) column with abbreviated scores (`2.4k`, `1.2M`). Best when rankings sit beside the game-card grid as a supporting widget.

*Pickers in two places* — room-admin default on the Rankings admin page (`/:slug/admin/rankings`, new "Display Style" section above the groups list, reads/writes via `/api/rooms/:roomId/settings`), and per-user override in the Scoreboard Preferences modal (`SCOREBOARD_RANKINGS_STYLE` added to the `SELECT_PREFS` list so it picks up the existing Reset-to-default affordance). Same option set in both places.

*Plumbed through* `admin-ui/src/pages/Scoreboard.tsx` + `admin-ui/src/pages/KioskScoreboard.tsx` to all 12 ranking-card call sites (RankingsRow, RankingsColumn, and inline RankingGroupCard inside layout containers).

Bumps SW cache to `arcaid-v61`.

---

## [2.13.8] — unreleased

**Public landing page room cards are now clickable surfaces.** Clicking anywhere on a room card at `arcaid.app` navigates to that room's scoreboard at `/<slug>/`. Previously only the small "View Scoreboard →" link in the card footer was clickable, which most visitors didn't notice.

*Implementation:* absolutely-positioned `<Link to="/${room.slug}/">` overlay (`inset: 0`, `z-index: 1`) layered over the card content as a sibling, with the existing "View Scoreboard →" Link and the "Join Discord" anchor lifted to `z-index: 2` so they continue catching their own clicks (Discord still opens in a new tab; the visible CTA still works). Uses a real `<Link>` rather than `onClick + useNavigate` so middle-click, ctrl-click, and right-click → "Open in new tab" all keep working. Added a subtle hover affordance (2px lift, green-tinted shadow, border tint) so users know the card is clickable. `aria-label` on the overlay names the destination ("View {room.name} scoreboard") for screen readers. Avoided the `<a>`-nested-inside-`<a>` trap that wrapping the card in a single `<Link>` would have caused.

Bumps SW cache to `arcaid-v60`.

---

## [2.13.7] — unreleased

**Game-detail leaderboard defaults to the originating room + paginates 20/page; mobile score input no longer summons the OS keypad.** Three small UX fixes that came up testing a locked-tournament submit on rtx_pinball.

*Tournament-card title clicks land on `GlobalGameDetail` (rich page with wheel art, downloads, tutorials) when the game has a `globalGameId`. The leaderboard there was hardcoded to `scope=global`, so a player who just submitted to their room's locked tournament saw all-rooms scores instead of theirs.* Fix: when navigated with `?from=<slug>`, default the scope dropdown to that room. Picking "All rooms (global)" now writes `?room=global` as an explicit sentinel so the choice persists across refresh / share. URL `?room=<slug>` semantics unchanged. Known limitation, intentional: `GlobalGameDetail` reads `global_scores`, which excludes guest/anon submissions per the existing `GlobalScoreService.fanOutFromRoomSubmission` gate — so scoping to a room here is not 100% identical to the room's `GameDetail`. To bridge, added a small "More info →" link in the room `GameDetail` header that opens the rich global page from a room context.

*Leaderboard had no pagination — `?limit=50` hardcoded, no controls past the 50th row.* Now 20 per page with prev/next + "Showing X–Y of N" + "Page N of M" footer. Server (`/api/global/scoreboard/:globalGameId`) already supported `offset` / `limit`; client wiring + footer was missing.

*Mobile OS keypad obscured the score photo when the player focused the score input.* The in-app `OnScreenKeyboard` was already opening on focus, but `type="number"` + `inputMode="numeric"` also triggered the native keypad (and `inputMode="none"` is silently ignored on iOS Safari when paired with `type="number"`). Fix: on touch devices only, swap to `type="text"` + `inputMode="none"` so the in-app keyboard is the sole input path; added a digit-only `onChange` filter to compensate for losing the numeric-type guard. Desktop unchanged. Name field unchanged — alpha input still relies on the OS keyboard.

Bumps SW cache to `arcaid-v59`.

---

## [2.13.6] — unreleased

**AtGames cabinet sub-tags moved from platform list to feature list.** The AtGames importer wrote 9 platforms per machine — the umbrella `atgames` plus up to 8 cabinet variants (`atgames_hd`, `atgames_4k`, `atgames_micro`, `atgames_hdp`, `atgames_alu`, `atgames_mini`, `atgames_gamer`, `atgames_core`). The variants polluted the tournament Platform Rules picker with options no realistic tournament design uses ("must be available on AtGames Micro only" is not a thing). Cabinet availability is a catalogue-level attribute — same axis as `wizard_auto` / `has_puppack` / `fps_45` — and now lives in `global_games.features` where it can drive a future "filter by my cabinet" UX without cluttering tournament eligibility rules.

*Migration 101* — for every `global_games` row with `atgames_*` in `platforms`: strip the sub-cabinet entries and union them into `features`. Idempotent; safe to re-run. Same pass strips dead sub-cabinet entries from any `tournaments.platform_rules` JSON (`required` + `excluded` arrays) since the umbrella `atgames` already covers eligibility on those rows. On prod: 8 catalogue rows touched (out of 273 with the umbrella `atgames` tag — the source sheet only fills cabinet-availability cells for a subset of titles), 1 tournament (WG-VPXS) cleaned. No `room_game_tags` entries reference sub-cabinets; no `submissions` / `score_history` / `community_scores` / `global_scores` rows have sub-cabinet platforms.

*Importer + canonical lists* — `AtGamesImportService` now writes `platforms: ['atgames']` and `features: [...cabinetVariants]`. Both canonical platform maps drop the 8 sub-cabinet entries (`src/utils/platformMapping.ts` and `admin-ui/src/lib/platforms.ts`). FE platform filter groups (`src/utils/platformMapping.ts` Physical group and `admin-ui/src/pages/GlobalScoreboard.tsx` vpin group) drop `atgames_hd` / `atgames_4k`.

*Out of scope:* `scripts/analyze-catalogue.ts` still references `atgames_hd` / `atgames_4k` defensively — harmless (umbrella `atgames` is in the same `.includes()` check) and the script isn't user-facing.

Bumps SW cache to `arcaid-v58`.

---

## [2.13.5] — unreleased

**Discord-login round-trip on public room pages now keeps you on the page, surfaces the "Room admin" link immediately, and skips the second password prompt at `/admin/login`.** Three symptoms, one root cause + one wiring miss.

*Login redirected to `/lobby` regardless of origin.* `PublicLayout.tsx`'s Discord login button called `loginWithDiscord(slug)` with no `returnPath`, and `ViewerAuthContext.loginWithDiscord` hardcodes `/${slug}/lobby` as the default. Fix: pass `location.pathname + location.search` so `DiscordCallback` round-trips you back to the originating page.

*"Room admin" item missing from the profile menu after Discord login, even for users who are in `game_room_admins`.* `UserMenu` gates the link on the `hasAdminToken` prop, which `PublicLayout` derives from `localStorage.getItem('arcaid_token')` — the *admin* token slot. Backend already issues a `role: 'room_admin'` JWT for these users (`src/api/routes/auth.ts` via `AdminService.getRoomsForDiscordUser`), but `DiscordCallback`'s player-flow branch writes the JWT only into `arcaid_player_token`. Fix: when the decoded role is `room_admin` or `super_admin`, also seed `arcaid_token` + `arcaid_admin_refresh_token`. Guarded on the admin slot being empty so a higher-privilege session already active in the browser isn't silently downgraded.

*`/:slug/admin/login` re-prompted for a password even though you'd just authed via Discord.* `RoomLogin.tsx`'s `isTokenValid(getToken())` auto-bounce checks the admin slot, which was empty by the bug above. Falls out of the same fix — the auto-bounce now triggers and lands you on the dashboard.

*Admin Leaderboard page button labelled "View Public Scoreboard".* Renamed to "View Public Leaderboard" per terminology preference. (Caveat: the destination page is still titled "Scoreboard" elsewhere in the product — broader rename out of scope.)

Bumps SW cache to `arcaid-v57`.

---

## [2.13.4] — unreleased

**Two All-Games-tab card bugs.**

*Banner cards overlapped horizontally in the All-Games grid.* `BannerCard.tsx` hardcoded `width: 280` on its outer container without a `maxWidth: '100%'` escape, so when `GamesTabView`'s grid sized cells from `minmax(min(238px, 100%), 1fr)` each card bled ~40px to the right, into the next column. The Tournaments tab forces banner into horizontal scroll (`effectiveLayout = 'scroll'`) where every cell is exactly 280px wide, so it never showed. Fix: add `maxWidth: '100%'` to the BannerCard root, matching the existing pattern on `ShowcaseCard` (`width: 380, maxWidth: '100%'`) and `MinimalCard` (`maxWidth: 380`).

*"Played at" cards rendered without backgrounds or header art.* `/api/rooms/:roomId/community-leaderboards` returned `imageUrl` as the raw DB column (`data/catalogue-images/foo.png`) instead of the public-URL form (`/api/catalogue-images/foo.png`), so every `backgroundImage: url(...)` lookup 404'd silently. The Tournament tab's `LeaderboardService.getActiveLeaderboards` runs the same value through `normalizeImageUrl()`; the community endpoint didn't. Fix: export the helper from `LeaderboardService.ts` and apply it in the community handler. Untouched: cards whose `community_scores.game_name` doesn't case-insensitively match a row in `global_games(name)` will still render bare — that's a data-hygiene gap, not a code path.

**`IScoredClient.deleteGame` now post-flight-verifies the delete.** The modal-hidden + networkidle signal isn't proof that iScored actually deleted the row — observed failure mode: modal hides on click even on silent backend reject, leaving the entity on iScored while the caller logs success. `deleteGame` now re-navigates to the Games tab and re-checks `#selectGame` for the option; returns `false` if the row is still present (so callers can branch on real success vs. false success). Pre-flight skip path (game not in dropdown) still returns `false`, unchanged. Throw behavior unchanged.

Bumps SW cache to `arcaid-v56`.

---

## [2.13.3] — unreleased

**Bottom-center QR overhang now reserved in layout.** Symptom: at common viewport sizes, only a 4px sliver of each card's QR was visible — the rest hung below the viewport, and scrolling to the maximum still left ~30-60px of QR clipped. Root cause: `marginBottom: qrMetrics.overhang` was set on each card component's outer div (BannerCard, ShowcaseCard, MinimalCard). That div also has `height: 100%`, which interacts with `align-items: stretch` and parent auto-sizing such that the margin escapes outside the parent's border-box. The flex line cross size (and grid track size) was computed without the overhang, so the QR — positioned `absolute, bottom: -overhang` — rendered outside the scrollable region entirely.

Fix: move the `marginBottom` from each card's inner outer-div to the wrapper around `<CardRouter>` in `Scoreboard.tsx` (the actual flex/grid layout item). Flex item margins DO contribute to flex line cross size and grid track sizing, so the QR's reserved space now lives inside the scrollable layout. No visual change to the QR's relative position; the QR still peeks 4px inside the card with 96px hanging below (for `qrSize=100`).

Also applied to the inline `RankingGroupCard` wrappers so they stay vertically aligned with adjacent leaderboard cards.

Bumps SW cache to `arcaid-v55`.

---

## [2.13.2] — unreleased

**Bottom-center QR peek tightened.** `qrBottomMetrics` in `admin-ui/src/lib/scoreboardConfig.ts` lowered the peek cap from 10px → 4px and the size-proportional factor from 0.2 → 0.1. Effect at common QR sizes: `18` → peek 3.6 → 1.8, `24` → peek 4.8 → 2.4, `50+` → peek 10 → 4. The QR's bottom-edge `overhang` grows correspondingly, so every QR sits noticeably lower below the card. Bumps SW cache to `arcaid-v54`.

The May 1 (v2.10.x) tightening from `qrSize * 0.2` to `min(10px, qrSize * 0.2)` was correct for medium/large QRs but kept the 20% factor for small QRs (18-24), where the peek-to-size ratio is what the eye reads — so users who'd shrunk their QR via `SCOREBOARD_QR_SIZE` user-pref still saw "mostly inside the card." This release closes that gap.

---

## [2.13.1] — unreleased

**iScored game-create lookup hardened.** `IScoredClient.createGame` previously located the newly created row by case-insensitive exact name match against the post-create lineup. iScored mutates names on save (observed: strips apostrophes — `JP's` → `JPs`), so any catalogue entry with apostrophes (and likely other punctuation) failed activation with `Failed to find newly created Game in lineup.` while silently leaving 1-2 orphan rows per attempt on iScored (one per retry).

The lookup now snapshots lineup IDs before clicking *Create Blank Game* and identifies the new row by ID-diff. Robust to any name mutation iScored applies. When the stored name differs from the requested one, the divergence is logged at INFO for observability. If somehow more than one new row appears between snapshot and check, a WARN is logged and the last row is selected.

Orphan rows on iScored from prior failed activations are not auto-cleaned — manual delete on iScored is required.

---

## [2.12.0] — unreleased

**Catalogue source provenance + structured Wizard download.** v2.11.0's merge primitive correctly cascaded data but dropped the Wizard row's `external_url` whenever the target row already had its own (e.g. VPS database link). Manual merges done before this release for Blood Machines and Ace Ventura therefore lost the GitHub link to the vpxs_manual table source. This release ships the structural fix and a Wizard re-sync covers the backfill automatically.

### Migration 100

```sql
ALTER TABLE global_games ADD COLUMN merged_from_sources TEXT DEFAULT '[]';
```

Tracks which sources a row absorbed via `merge` or cross-source `upsert`. The base `imported_from` column says where the row was *first* imported from; `merged_from_sources` accumulates additional contributing sources. Used to render `vps, wizard` in the admin catalogue when both have fed metadata into the same row.

### Wizard importer now emits `table_download_urls`

Every Wizard table now writes `[{ format: 'wizard', url: <github tree URL> }]` to `table_download_urls` alongside the existing `external_url`. The structured entry is what survives a merge — `external_url` is per-row metadata that a merge fills only when the target's is empty.

### `upsert` UPDATE branch: cross-source semantics

When `input.imported_from` differs from `existing.imported_from`, the URL object-arrays (`table_download_urls`, `tutorial_urls`, `rules_urls`) now **union by `.url`** instead of overwriting via COALESCE. Same-source re-imports keep overwrite semantics so source-side updates can prune stale entries; cross-source imports preserve everything from both sides. The cross-source path also appends the input's source name to `merged_from_sources`.

This is what backfills Blood Machines and Ace Ventura on the next Wizard sync: dedup finds the post-merge row, the upsert's UPDATE branch detects the cross-source case (input from `wizard`, row from `vps`), unions the GitHub link into `table_download_urls`, and records `wizard` in `merged_from_sources`.

### `merge` primitive: fold external_url + track source provenance

When source has an `external_url` that target doesn't already have, the merge primitive now folds it into target's `table_download_urls` with `format: <source.imported_from>`. Source's `imported_from` and any prior `merged_from_sources` are union'd into target's `merged_from_sources` so the lineage survives multi-step merges.

### Admin catalogue UI

Each row in the Browse Games list now shows platform tags (chips, large screens) and a combined source string. Rows that absorbed cross-source data render as `VPS, WIZARD` instead of just `VPS`. Expanded view's Source detail follows the same convention.

### Backfill plan

After deploy, run a Wizard sync from `/admin/catalogue`. The sync's upsert path matches the merged Blood Machines and Ace Ventura rows via the v2.11.0 dedup improvements, detects the cross-source case, and writes the GitHub link + `wizard` source provenance. No separate migration needed.

### Risks worth flagging

- **Cross-source upsert semantics changed.** A future cross-source import of a row's `tutorial_urls` will now append rather than replace. If a source is the canonical owner of a row's tutorials and you want it to fully replace, the row's `imported_from` would need to be set to that source first.
- **`merged_from_sources` is additive only.** No code path removes a source from this list. If a merge gets reversed (no current path for that), the lineage entry persists. Acceptable: this is metadata for display, not for FK integrity.

---

## [2.11.0] — unreleased

**Catalogue dedup: merge vpx + vpxs_manual variants of the same game.** The Wizard importer's `(VPW Original 2022)` parenthetical was producing manufacturer mismatches against VPS's plain `Original`, blocking step-4 dedup. Hyphen-as-separator names like `Ace Ventura - Pet Detective` vs `Ace Ventura Pet Detective` weren't normalizing equal either. Plus the existing `merge` primitive was throwing away the source row's `table_download_urls`, `themes`, `designers`, `table_authors`, etc. — exactly the data admins want to keep on the surviving row.

### `GlobalGameService.merge` now actually unions data

Before this release, `merge` only cascaded FK references (scores, library links, games table) and unioned `platforms`. Source's content arrays and scalar fields were dropped on `DELETE FROM global_games`.

Now the merge primitive:

- **Cascades** `global_scores`, `global_leaderboard_cache`, `game_room_game_library`, `games`, plus the previously-missing `global_game_ratings` (UNIQUE-constraint-aware), `global_game_comments`, and `room_game_tags` (PRIMARY-KEY-aware).
- **Unions** the target's content from the source: `platforms`, `themes`, `designers`, `table_authors`, `features` (string arrays); `table_download_urls`, `tutorial_urls`, `rules_urls` (object arrays, deduped by `.url` so re-merging is idempotent).
- **Fills target gaps** from source for `description`, `image_url`, `local_image_path`, `wheel_image_path`, `source_rating`, `source_updated_at`, plus the existing external IDs (`opdb_id`, `vps_id`, `igdb_id`, `ipdb_url`, `external_url`).
- **Never** pulls identity fields from source: `name`, `display_name`, `manufacturer`, `year`, `subtype`, `players` belong to the target.

The clicking-Blood-Machines-game-detail-shows-vpxs_manual-download path the user asked for falls out for free: both download URLs now coexist in `target.table_download_urls`.

### Merge UI on the Browse Games admin page

Per-row Merge button next to Reject/Delete, opens a search-driven target picker. Modal warns that target's external IDs (vps_id, opdb_id) are preserved and source is deleted, so the admin should pick the rich row as target. Source self-filters out of candidate list.

### Dedup prevention for new imports

- **`normalizeGameName`** now collapses whitespace-surrounded hyphens (`Ace Ventura - Pet Detective` → `ace ventura pet detective`). Hyphens between letters (`Spider-Man`, `X-Men`) untouched. Run before the existing punctuation pass.
- **`WizardImportService.parseNameParts`** strips short all-caps team prefix when manufacturer is `<TEAM> Original` or `<TEAM> MOD` (matches `[A-Z]{2,5}\s+(Original|MOD)`). `VPW Original` → `Original`, `VPDB MOD` → `MOD`. Real manufacturer names (`Williams`, `Stern`) are case-mixed and left alone.

### Migration 099

```ts
// Strips team prefix from existing global_games rows so the next Wizard
// import can find them via concrete (mfg, year) match instead of inserting
// new rows alongside.
UPDATE global_games SET manufacturer = '<stripped>' WHERE manufacturer matches /^[A-Z]{2,5}\s+(Original|MOD)$/i
```

Idempotent re-run: subsequent runs find no matching rows.

### Risks and mitigations

- **`normalizeGameName` change affects every existing row.** New "concrete match" hits between previously-distinct rows could cause the next sync to merge things that shouldn't merge. Spot-check by running a Wizard sync after deploy and watching `imported_from='wizard'` counts; if `updated` jumps unexpectedly, investigate.
- **Merge UI's target picker uses the existing `/admin/catalogue/games` search endpoint.** No new endpoint, no new auth surface.
- **Existing `POST /admin/catalogue/games/merge` semantics changed.** Anyone calling it gets the enhanced behavior; the only existing caller is the catalogue-approval pending flow, which benefits from preserving more data.

---

## [2.10.2] — unreleased

**Rename game status `HIDDEN` → `ARCHIVED`.** The pre-rename name conflicted with iScored's own "Hidden" concept (game still in lineup, soft-hidden from scoreboard). ArcAid's value actually means "post-cleanup, kept locally as a historical anchor for score attribution." `ARCHIVED` captures that intent.

### Migration 098

```sql
UPDATE games SET status = 'ARCHIVED' WHERE status = 'HIDDEN';
```

Idempotent. No CHECK constraint to update — the column is plain TEXT.

### Code surface touched

Pure mechanical rename of the string literal across:
- `GameStatus` type union (`src/types/index.ts`)
- `UpdateGameStateSchema` Zod enum (`src/api/schemas.ts`)
- `TournamentEngine.runCleanup`, log messages, and the doc comment on `deleteGameCompletely` (`src/engine/TournamentEngine.ts`)
- 14 `('COMPLETED', 'HIDDEN')` clauses in `StatsService` queries
- `RankingService` test that simulated post-maintenance hiding
- The two `iscoredGame.isHidden ? 'HIDDEN' : ...` mappings in `/sync-state` (Discord)
- The admin status-change endpoint at `rooms.ts` (`PATCH /:roomId/admin/game-states/:gameId/status`)
- `GameStates.tsx` filter chips + badge map and `StatusBadge.tsx`

### UX: ARCHIVED chip + ALL excludes archive

The Game States page's "ALL" chip used to silently include archived rows, but no chip targeted ARCHIVED specifically — so a room with cleaned-up tournaments would show `ACTIVE (0) QUEUED (0) COMPLETED (0)` next to a populated table, which is what surfaced this rename in the first place. Now:

- ALL = ACTIVE + QUEUED + COMPLETED only (matches the page's "rescue" intent)
- New ARCHIVED chip with its own count
- Every chip displays its count, including ALL
- Frontend always fetches every status; chip filtering is client-side so counts stay accurate regardless of which chip is active

### Behavior preserved

- The `setGameStatus(..., { hidden: true })` call to iScored when an admin sets status=ARCHIVED with `syncIScored=true` is unchanged. iScored's API still calls this "hidden"; we just don't conflate the names locally.
- `Stats` and `Ranking` services continue to read from rows in `('COMPLETED', 'ARCHIVED')`, so historical leaderboards stay coherent across the rename.

---

## [2.10.1] — unreleased

**Ranking groups self-invalidate via data watermark.** Eliminates the class of bugs where a score-mutation code path forgot to call `RankingService.invalidate*()` and rankings stayed stale until a manual recompute. Resolves the user-reported staleness after weekly maintenance and after manual game deletes.

### Root cause

`ranking_groups_cache` had no auto-invalidation — it was only cleared by (a) the manual admin "Recompute" button, (b) `RankingService.update()` when a group's config changed, and (c) the Discord `/submit-score` command. Every other score-mutation path (web `/submit-score`, `/freeplay-score`, `/community-scores`, the v2.9.0 per-row delete + admin wipe-player endpoints, `TournamentEngine.{deactivateGame, deleteGameCompletely, runCleanup}`, ScoreSyncPoller, pin/unpin) silently skipped invalidation. After Wed maintenance flipped games' status to HIDDEN, `computeRankings`'s `WHERE status IN ('ACTIVE','COMPLETED')` filter dropped them, but the cached snapshot still reflected the pre-maintenance state — so the public ranking page showed stale points/standings until manual intervention.

### Fix — data watermark

Migration **097** adds `data_watermark TEXT` to `ranking_groups_cache`. `RankingService` computes a cheap fingerprint of the underlying data state at compute time, stores it alongside the cached rankings, and re-validates on every read. If anything changed, the cache silently recomputes. **No invalidation calls anywhere in mutation code paths** — adding a new score endpoint requires zero ranking-related awareness.

The watermark composition (one round-trip, sub-10ms over indexed columns):

| Component | Captures |
|---|---|
| `eligible_games_count` (status IN ACTIVE/COMPLETED) | maintenance hiding games, new games activating, status flips |
| `score_count` (non-orphaned, in eligible games) | inserts, deletes, orphans |
| `score_sum` | inserts (sum rises), deletes (drops), upserts to higher value (rises) |
| `MAX(games.end_date)` over the group's tournaments | game completions |
| `MAX(games.start_date)` over the group's tournaments | game activations (auto-pick / manual / queue rotation) |

The only mutation the watermark can't detect is an upsert that lands the same value as before — which is a no-op anyway. Display-name and avatar updates from `user_profiles` are deliberately excluded; the slight rendering lag in cached rankings is acceptable and including them would add a JOIN per read for negligible UX benefit.

### Why this over alternatives

- **vs. application-level invalidation hooks at every mutation site (~7 fan-out points)** — every new score endpoint is a chance to forget. The data tells us when it's stale; no code-path discipline required.
- **vs. SQLite triggers** — opaque, hard to debug, log poorly, can fire on operations we don't care about.
- **vs. compute-on-every-read** — wastes CPU when nothing changed (the common case).
- **vs. version-counter on writes** — still needs every mutation site to increment. Same forgetfulness problem at smaller scale.

### Behavior carried forward

- **Manual "Recompute" button stays** as a diagnostic escape hatch (`POST /:roomId/admin/ranking-groups/:id/recompute` and the room-wide variant). With the watermark, it's no longer load-bearing; pressing it just deletes the cache row to force a fresh compute.
- **`RankingService.update()`'s explicit invalidate** is retained — config changes (best_n, rank_method, tournament_ids) aren't reflected in the data layer, so the watermark wouldn't catch them.
- **Discord `/submit-score`'s `RankingService.invalidateAll()` call removed** — now redundant. Pre-fix, it nuked all groups' caches on every Discord submit, even groups that didn't include the affected tournament. Watermark recomputes only the groups that actually changed.

### Tests

- 4 new `cache watermark auto-invalidation` tests in `RankingService.test.ts`. Cover: insert score after first compute, status flip to HIDDEN, score deletion, no-op (cache hit when nothing changed). 133/133 total tests pass.

### Migration / rollout

- **Migration 097** adds the column with NULL default. Existing cache rows have NULL watermarks; `getRankings` treats NULL as "always recompute" so the first read after deploy lands fresh data. No-downtime upgrade.
- **No FE changes.** SW `CACHE_NAME` unchanged.

---

## [2.10.0] — 2026-05-02

**Per-account iScored session registry.** Eliminates the parallel-Playwright-session contention that caused silent `deleteGame` no-ops at Wed 22:00 maintenance fires. Resolves the open ROADMAP entry from the 2026-04-29 incident (CSI / X-Men Wolverine LE / Paranormal / Attack from Mars stayed visible on iScored despite local DB being marked HIDDEN).

### Root cause

iScored treats one logged-in user as one browser session. When 4 weeklies + Daily Grind fire maintenance at the same minute on `rtx_pinball` — all sharing the `mekelburgj@gmail.com` iScored account — each path used to construct its own `IScoredClient`. Multiple Playwright contexts on the same iScored account contend over server-side state. Symptom: the `<select id="selectGame">` dropdown gets repopulated mid-call between `navigateToGamesTab()` and the option lookup, `IScoredClient.deleteGame` finds zero matching options at line 692, logs `Game '<name>' not found in dropdown. Skipping delete.`, and returns. The caller then logged `Deleted from iScored: <name>` regardless because `deleteGame` returned `void` — failure was indistinguishable from success.

### Architectural fix

- **New `IScoredSessionRegistry` (`src/engine/IScoredSessionRegistry.ts`).** Singleton with `withSession(creds, fn)` API. Calls for the same iScored account chain serially: only one `fn` callback runs at a time per account. The underlying `IScoredClient` is held open across consecutive calls within a 1.5s idle TTL so cron-fire batches reuse the same Playwright login (saves ~3-9s per fire when 5 tournaments share an account).
- **All iScored mutations route through the registry.** Refactored every direct `new IScoredClient()` call site to use `withSession()`: `TournamentEngine` (runMaintenance, runCleanup, runScheduledCleanup, deactivateGame, deleteGameCompletely, reorderIScoredLineup), `TimeoutManager.fallbackToAutoSelection`, `gameCreation.{pinGameToScoreboard,unpinGameFromScoreboard}`, `IScoredSubmitSync`, the four `rooms.ts` admin endpoints, the `admin.ts` backup endpoint, and the four Discord commands (`/activate-game`, `/pick-game`, `/submit-score`, `/sync-state`). The only construction site is now `IScoredSessionRegistry.acquireClient`.
- **Inline cleanup reuses the maintenance client.** Pre-fix, `runMaintenanceWork` opened one client for slot processing then `runCleanup` opened another — two sequential Playwright sessions per maintenance run, even within a single tournament. Now the same client threads through. `runCleanup` accepts an optional `(sharedClient, sharedCreds)` pair; when present it skips its own registry acquisition.
- **`reorderIScoredLineup` scoped to one room.** Pre-fix, every maintenance fire reordered every room's lineup (5 weeklies on rtx_pinball = 5× redundant reorders of the same lineup). Now it accepts `(gameRoomId?, sharedClient?)`; the maintenance flow passes its own room and shared client, and the function only reorders that room. Standalone calls preserve the iterate-all-rooms behavior.

### Honest `deleteGame` return value

- **`IScoredClient.deleteGame` now returns `Promise<boolean>`.** Returns `false` when the dropdown short-circuit fires (no matching option), `true` when the delete confirmation modal was driven through. Throws on actual errors.
- **All callers branch on the result.** `runCleanup` logs `-> Cleanup skipped <name> on iScored (not in dropdown). Local row will still be marked HIDDEN.` instead of the false `Deleted from iScored: <name>`. `deleteGameCompletely` sets `iscoredStatus: 'failed'` with an actionable error (`Game not found in iScored dropdown — iScored entity may need manual cleanup.`) so admin UI surfaces the orphan rather than reporting a fake success.

### Behavior carried forward

- **Per-tournament maintenance mutex** (`maintenanceLocks` in `TournamentEngine`) is preserved — guards re-entry within the same tournament. Cross-tournament serialization is now handled by the registry instead.
- **`ScoreSyncPoller.pause()/resume()`** is preserved at the `runMaintenanceInternal` level. Concurrent maintenance fires for different tournaments still pause/resume the poller; the registry serialization means the work itself is sequential, so the pause window is well-defined.
- **`runMaintenanceWork` v2.9.0 inline cleanup behavior** is preserved (cleanup-cron-matches-now still fires inline). Now load-bearing for fewer reasons since registry serialization solves the original race, but kept for belt-and-suspenders.

### Tests

- Build clean (`tsc` + `vite build`), **129/129 tests pass**. No new test files — the registry's chain logic is small and best validated by the next Wed 22:00 maintenance run; the fan-out through every iScored caller is covered by existing route smoke tests.

### Migration / rollout

- **No DB schema changes.**
- **No frontend changes.** SW `CACHE_NAME` does NOT need a bump — backend-only refactor.
- **Backwards-compatible deploy.** Drop-in replacement; old code paths and new code paths produce identical correct outputs in the single-fire case. The fix is observable only at concurrent-fire moments (Wed 22:00, Thu/last-day-of-month 22:00 for rtx_pinball).

---

## [2.9.0] — 2026-04-29

**Per-row score moderation + multi-slot picker correctness.** Two user-visible features and two latent-bug fixes that surfaced during the same arc, shipped as a single minor.

### Score moderation

Players were able to self-delete on the **Global** scoreboard's GameDetail page (`DELETE /api/me/global-scores/:scoreId`) but had no equivalent for room-scoped scores. Room admins had a backend endpoint (`DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId`) but its only UI was on the legacy `AdminGameCard` rendering path which doesn't render once `SCOREBOARD_STYLE` is set — i.e. dead code in production for everyone using the v2.x card system.

- **Player self-delete + admin per-row delete on `GameDetail.tsx`.** Trash icon appears on hover next to each `score_history` row in the per-player history expand, gated client-side by decoded JWT claims (`role`, `gameRoomIds`, `discordId`). Server-side authorization in the new endpoint independently re-checks. Restricted to `source IN ('tournament','sync')` rows — community-source delete needs a `community_scores` cascade that isn't built yet.
- **Admin "Manage Scores" modal on the Leaderboard page.** New "Scores" button in `AdminCardWrapper` (alongside Style/Notes/Name/Remove) opens a modal listing per-player submissions with delete buttons. Targets the existing admin endpoint (now fixed — see below).
- **Latent bug: existing admin endpoint didn't actually remove the score from the leaderboard.** Tournament leaderboards have read `score_history` filtered by `submitted_during_tournament_id` since v2.1.0, but the admin delete endpoint only ran `DELETE FROM submissions`. Cache invalidation re-computed from `score_history` on next render and the score reappeared. Fix: cascade to `score_history` rows matching `(game_room_id, iscored_username, game_id-or-game_name)`.
- **Latent bug: pinned games were 404'ing.** The verification query in the admin endpoint used `INNER JOIN tournaments` — pinned rows (`tournament_id IS NULL`, ADR 0005) didn't match. Switched to `LEFT JOIN tournaments` with an `ownedByRoom` check that accepts either `tournaments.game_room_id` or `games.game_room_id`.
- **New per-row endpoint: `DELETE /api/rooms/:roomId/score-history/:historyId`.** `requireDiscordUser` + per-row authorization (`super_admin` OR `room_admin` for this room OR `submitted_by_user_id === viewer.discordId`). Recomputes the corresponding `submissions` row from remaining `score_history` (`ORDER BY score DESC, created_at ASC LIMIT 1` — preserves the timestamp of the displayed highest score) — deletes if no rows left, else updates `score`+`timestamp`.
- **Sync-resistant tombstone (migration 096).** New `deleted_score_suppressions(game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)` table. Both delete endpoints write a tombstone (`MAX(existing, deleted_score)` on conflict so repeat deletes never lower the threshold). `ScoreSyncPoller.pollOneAccount` bulk-loads the suppression map per game and skips `score <= suppressed_score` before the existing `>` check — new higher scores still flow through, deleted scores stay deleted across poll cycles. iScored has no per-score delete API, so without this the sync poller would re-import deleted scores within ~30s. Caveat documented: the iScored side keeps the entry; admins must clean up manually until the iScored cascade lands (ROADMAP).

### Cron race fix

Daily Grind on rtx_pinball had `0 22 * * *` maintenance + `0 22 * * 3` cleanup. On Wednesdays both cron tasks fired at the same instant, with no serialization between them. Cleanup's first SELECT ran before maintenance had completed today's active game; one game per Wed survived as `COMPLETED`-but-not-`HIDDEN` until next week's cleanup. Black Knight 2000 on 2026-04-29 was the latest casualty.

- **Fix.** When `runMaintenanceWork` finishes the slot loop, if `cleanupRule.mode === 'scheduled'` AND the cleanup cron's `min/hour/dom/mon/dow` would all match right now in its timezone, run cleanup inline. The separate cleanup cron is left registered — it still fires (idempotent: zero `COMPLETED` rows left after the inline pass).
- **New helper.** `TournamentEngine.cleanupCronMatchesNow(cron, tz)` — small private cron-field matcher supporting `*`, single integers, comma lists (`1,3,5`), and inclusive ranges (`1-5`). That's the full set the codebase uses; no `step` values, no named weekdays, no `L` (the maintenance cron's `L`-handling is in `Scheduler.resolveCron`).
- **`emitLeaderboardUpdated` now broadcasts globally.** The function existed but was never called and was scoped to `io.to('game:gameId')` — no FE page joins per-game rooms, so it would have reached zero clients. Both delete endpoints now emit globally so other open Scoreboard / admin Leaderboard / Game Detail tabs repaint without a manual reload.

### Multi-slot picker correctness

When one user won multiple slots in a single maintenance run (e.g. Weekly Grind - VPXS `max=2` with the same player on top of both), we emitted exactly **one** `[Pending Pick]` placeholder + **one** turn-to-pick DM, collapsing the wins. Symptom on rtx_pinball 2026-04-29: user won X-Men Wolverine LE + CSI in one rotation; only one slot got refilled, the other sat empty.

- **Dedup rescoped.** Was `(tournament_id, picker_discord_id)`, now `(tournament_id, picker_discord_id, won_game_id)`. Each slot win emits its own placeholder + DM; re-runs of maintenance for the same `(tournament, winner, won_game)` still no-op.
- **DM + embed copy now names the won game.** Channel embed: `Pick Needed — {gameName}` / *"you won {gameName}! Use /pick-game within X minutes to select the next game for this slot."* DM: *"You won {gameName} in {tournamentName} — it's your turn to pick the next game for that slot."* Players who win multiple slots get one set per slot, each clearly labeled with which slot they're filling.
- **`/pick-status` API extended.** Now returns `pick_slot_id`, `won_game_id`, `won_game_name` per pending pick. `Picks.tsx` uses `pick_slot_id` for stable React keys (was `tournament_id`, which collided on multi-slot pendings) and renders `won {game}` next to the tournament name.
- **Discord `/pick-game` now fulfils placeholders.** Pre-fix the command branched only on `hasOpenSlot` — never checked for an outstanding `[Pending Pick]`. Effects: with an open slot, the placeholder dangled as stale `QUEUED`; with all slots full, the new game appended to the queue tail while the placeholder sat at the front, so the next rotation activated nothing useful and the user waited an extra round. Three branches now mirror the web `/pick-game` route:
  - **Pending + slots full** → `UPDATE` the placeholder's name + style_id (keeps `queue_order = NULL`, sorts ahead of explicit queue games via `processSlotMaintenance`'s `ORDER BY queue_order ASC, rowid ASC`).
  - **Open slot (with or without pending)** → create on iScored, drop placeholder if present, `activateGame` — all in one txn.
  - **No pending + slots full** → `queueGame` (unchanged, appends to tail).
- **Embed adds a third "queuedFromPick" path** so the user can tell whether their pick jumped the queue (won-pick reward) vs landed at the tail (regular queue).

### Files

- `src/api/routes/rooms.ts` — admin endpoint cascade + pinned-game support, new per-row endpoint, websocket emit, `/pick-status` extended
- `src/services/ScoreHistoryService.ts` — `getPlayerGameHistory` returns `submitted_by_user_id`
- `src/api/websocket.ts` — `emitLeaderboardUpdated` global broadcast
- `src/database/database.ts` — migration 096 (`deleted_score_suppressions`)
- `src/engine/ScoreSyncPoller.ts` — suppression check before insert (matches both `resolvedName` and original iScored name post-alias)
- `src/engine/TournamentEngine.ts` — picker dedup rescoped, embed/DM copy, inline-cleanup-on-overlap, `cleanupCronMatchesNow` helper
- `src/discord/commands/pickgame.ts` — three-branch fulfillment matching the web route
- `admin-ui/src/pages/GameDetail.tsx` — viewer claims decode, `ScoreHistoryRow` trash icon, `handleDeleteScoreHistory`
- `admin-ui/src/pages/Leaderboard.tsx` — `ManageScoresModal`, `Scores` button on `AdminCardWrapper`
- `admin-ui/src/pages/Picks.tsx` — `PendingPick` interface gains `pick_slot_id` / `won_game_id` / `won_game_name`; row keying + render
- `admin-ui/public/sw.js` — `CACHE_NAME` walked `arcaid-v42` → `arcaid-v43` → `arcaid-v44`

### Migration notes

- **096 (`deleted_score_suppressions`)** — idempotent, runs on container start. No backfill (forward-looking).
- No data migrations, no breaking schema changes. Pre-existing `[Pending Pick]` rows that were dangled by the old Discord `/pick-game` path will be cleared by `TimeoutManager.fallbackToAutoSelection()`'s orphan sweep at their pick-window expiry (default 60min).

### Tests

129/129 passing. No new test files this release — handlers exercise paths already covered by route smoke tests; the cron-field matcher is a small private helper best verified by inline-cleanup behaviour next Wed at 22:00 Central.

### Known followups (in ROADMAP)

- **iScored per-score delete (true cascade)** — current model suppresses re-import on our side only; iScored's public page keeps the deleted entry until manual cleanup.
- **Parallel iScored Playwright sessions step on each other on Wed 22:00** — multiple maintenance/cleanup runs spin up concurrent sessions against the same iScored account; symptom 2026-04-29: WG-VPXS cleanup logged `Game 'CSI' not found in dropdown. Skipping delete.` for both CSI and X-Men Wolverine LE despite the DB marking them HIDDEN.

---

## [2.8.2] — 2026-04-28

**Display-name on the two surfaces deferred from v2.8.1.** Closes the v2.8.1 loose ends.

- **`GET /api/global/recent-scores`** (LandingPage ticker) now returns `player_display_name` alongside the existing game-level `display_name`. SQL pulls from `user_profiles` joined via `COALESCE(submitted_by_user_id, um.discord_user_id, gs.player_id)` so attributed-by-merge rows resolve correctly. FE `RecentScore` interface adds `player_display_name`; `ScoreTickerCard` renders the chosen name with a `playerLabel` fallback to `iscored_username`.
- **`StatsService.getRoomOverview`** (`/:roomId/stats/overview`) latest-submission card now includes `display_name`. Same JOIN pattern (`user_mappings` for iscored:* synthetic ids → `user_profiles` for the chosen name). `PublicStats` overview card renders display_name when set.

No schema changes. No new tests; both are read-only display tweaks covered by manual verification.

---

## [2.8.1] — 2026-04-27

**FE polish: render user-chosen display_name in scoreboard cards.** The v2.8.0 BE work shipped `display_name` alongside `iscored_username` in every leaderboard, ranking, and stats response, but the FE components were still rendering raw `iscored_username`. After saving a display name on `/account/settings`, users saw their old iScored alias on every public surface.

- New `playerName(entry)` helper exported from `ScoreboardComponents` — single resolution rule (`display_name || iscored_username`) used across components. Match/key/route logic deliberately keeps using `iscored_username` for stable identifiers.
- Display substituted in: `BannerCard`, `MinimalCard`, `ScoreList`, `ShowcasePodium`, `ScoreboardComponents` (compact/horizontal/ranking-group rows), `Leaderboard`, `GameDetail` (tournament leaderboard, score history, community board, recent submissions, player rankings list), `GlobalScoreboard` (podium + spillover list), `GlobalGameDetail` (rankings table), `Stats`, `PublicStats`, `Rankings`, `Friends`.
- `RankedEntry`, `RankingGroupData.rankings[]`, plus the local interfaces in `GlobalScoreboard`, `GlobalGameDetail`, `GameDetail`, `PublicStats`, `Rankings`, `Stats`, `Friends` all now carry an optional `display_name` field.
- `FriendsService.getFriends` LEFT JOINs `user_profiles` so the friends list pulls each friend's `display_name` and `avatar_hash` (replacing the old `user_mappings.avatar_hash` source). Many-to-one mapping handled by `MIN(m.iscored_username)` + GROUP BY.

### Known still-pending
- `LandingPage` recent-scores card still renders the iScored alias (its `display_name` field already serves the *game* name; needs a separate `player_display_name` field added to the BE response).
- `PublicStats` "Latest submission" overview card on the Stats overview row (`StatsService.getOverview`) doesn't include `display_name` yet.

Both are minor non-leaderboard surfaces; rolled into a future v2.8.2 cleanup.

---

## [2.8.0] — 2026-04-27

**Identity merge forward-attribution + Discord-style display names.** Two-part feature shipped together. Closes the long-standing gap where admin "merge anonymous identity → Discord user" only retrofitted historical rows; future iScored scores under the same nickname continued to land as anonymous synthetic IDs.

### Forward attribution

- `MergeService.recordMerge` now writes a `user_mappings` row inside the merge transaction, so the next `ScoreSyncPoller` cycle attributes new scores under the merged nickname to the target Discord user automatically.
- `MergeService.reverseMerge` cleans up: drops the `user_mappings` alias row + re-anonymizes any post-merge auto-attributed rows that aren't in the original snapshot. Restores the pre-merge state across all four score tables.
- `user_mappings` schema now many-to-one (one Discord user can hold many iScored aliases): dropped the `discord_user_id` PRIMARY KEY, added `UNIQUE(iscored_username COLLATE NOCASE)`, added `created_at`. Migration 095 detects and refuses to run if any case-only collisions exist on existing rows.
- New helper `fetchAvatarHash` in `src/utils/discord.ts` — best-effort Discord REST call; called after merge to seed the user's avatar cache.
- Mapping-conflict pre-check in `recordMerge` surfaces a `MAPPING_CONFLICT` typed error when the alias is already owned by a different Discord user, so the admin sees a clean message instead of a 500.

### Discord-style display names

- New `user_profiles` table (one row per Discord user). Holds the user-chosen `display_name` plus the avatar cache. Globally unique display name, case-insensitive, also collision-checked against other users' iScored aliases.
- New `UserProfileService` (validate, upsert, batch-lookup, availability check).
- New `/account/settings` page (admin-ui). Display-name input with debounced availability check, read-only avatar preview, list of linked iScored aliases. Linked from the user menu dropdown.
- New `/api/users/me/profile` (GET/PATCH) and `/api/users/me/profile/check-display-name` (GET).
- Leaderboards collapse-by-Discord-user: `LeaderboardService.recalculate`, `getForGameByPlatform`, `GlobalLeaderboardService.recalculate`, and the cross-game top-N helper now `PARTITION BY COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))`. Multi-alias users render as one row per game; anon rows still partition per-name.
- All leaderboard responses + ranking groups + Stats overview now ship `display_name` alongside `iscored_username`. FE renders `display_name` when set, falls back to `iscored_username`.
- `LobbyFeedGenerator` resolves display name for new-#1 / rank-change / score-posted / friend-score event titles + `rankDethroned` / `friendScore` DMs.
- `TournamentEngine` winner announcement embeds + picker-assigned ticker use the user-chosen display name.
- Avatar cache moved from `user_mappings.avatar_hash` to `user_profiles.avatar_hash`. `auth.ts` Discord OAuth callback now writes the new column. Existing leaderboard reads now pull avatar from `user_profiles` via `discord_user_id` (with `user_mappings` still resolving `iscored:*` synthetic IDs).

### Behavior changes

- **`/map-user` Discord command** changes from "replace this user's mapping" to "add an alias for this user." With many-to-one mappings the old replacement semantic no longer makes sense. Errors if the name is already mapped to a different user. A `/unmap-user` companion command is deferred.
- All `user_mappings` UPSERT call sites (auth.ts, global.ts, mapuser.ts, submitscore.ts, IdentityManager.ts) switched conflict key from `discord_user_id` to `iscored_username`. The intent of each call site is unchanged: "register this alias for this user; if the name is already taken, leave it alone."

### Tests

- `MergeService.test.ts` — coverage for forward-attribution write, MAPPING_CONFLICT, idempotent re-merge, case-insensitive collision check, reverseMerge cleanup, and a regression check for the v2.7.x freeze-gate fix.
- `UserProfileService.test.ts` — display-name validation, uniqueness rules, own-alias allowance, batch lookup.

### Migration

- **095** — `user_mappings` rebuild + `user_profiles` create + backfill. Aborts with a clear error if pre-existing case-only collisions are present.

---

## [2.7.2] — 2026-04-27

**Duplicate dethrone DM root cause + Deactivate/Delete admin split.** Bug fix arc that grew into a small admin-UX refactor when the simple "always delete on deactivate" first cut turned out wrong for normal end-of-round semantics.

### Bug

User received two identical `rankDethroned` Discord DMs for the same WHO dunnit submission on rtx_pinball at 2026-04-27 02:56 UTC. Same score (96,814,400), same dethroner (PBW2023), 763ms apart.

Forensics: two `games` rows shared an `iscored_id = "95570"` — one ACTIVE in **Daily Grind**, one COMPLETED in **Weekly Grind - VR**. Both were created when WHO dunnit was activated in two different tournaments; the older row never had its iScored game deleted (just locked under the legacy contract), so the newer activation's `IScoredClient.createGame` reused the existing iScored entity.

When PBW2023 submitted via web `/submit-score` (anonymous), the route inserted into `submissions` keyed on the Daily Grind row's `game_id`. `CommunityScoreService.submitScore` fired `LobbyFeedGenerator.onScoreSubmitted` once → DM #1. Then the SyncPoller pulled the score back from iScored: its `db.get` lookup matched the *Weekly Grind* row first (no `ORDER BY`, no status filter), found no `submissions` entry under that `game_id`, treated the score as new, and fired `onScoreSubmitted` a second time → DM #2.

### Fix

Two architectural changes plus one admin-UX addition, shipped across three commits.

**Fix B — `7c7cf8b8` — SyncPoller deterministic lookup.** `ScoreSyncPoller.pollOneAccount` now orders by `CASE g.status WHEN 'ACTIVE' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END, g.created_at DESC LIMIT 1`. With this in place, the poller always picks the same row the web/Discord routes pick, regardless of how many legacy rows share an `iscored_id`. This alone neutralizes the duplicate-DM bug for the existing prod data — it's the correctness fix.

**First-cut Fix A (reverted) — `7c7cf8b8`.** Deactivation hard-deleted the iScored game and NULLed `iscored_id` on the games row. This killed the structural cause but turned out wrong for normal end-of-round behavior — admins still want history visible on iScored after a round closes; deletion belongs to the rare "wrong game in wrong tournament" case. Reverted in `aef1d0ff`.

**Final Fix A — `aef1d0ff` — Deactivate vs Delete split.** Two distinct admin actions on an ACTIVE game:

| Action | iScored | ArcAid `games` row | Use case |
|---|---|---|---|
| **Deactivate** | `setGameStatus({ locked: true })` | status=COMPLETED, `iscored_id` retained | Normal end-of-round / cron rotation |
| **Delete** | `deleteGame()` | DELETE FROM games, scores orphaned per ADR 0005 | Wrong game in wrong tournament |

Both run a new `TournamentEngine.finalSyncScoresForGame()` helper first — pulls iScored scores into `submissions` + `score_history` so anything submitted between the last poll cycle and the action is captured before destruction. The helper does **not** fire `LobbyFeedGenerator.onScoreSubmitted` (data capture only, no live events).

`processSlotMaintenance()` (cron rotation) follows the same lock+sync contract as admin Deactivate. Keeping `iscored_id` non-NULL on COMPLETED rows lets `runCleanup` (cleanup_rule retain/scheduled/immediate) find them later.

**Retained-completed admin section — `bd58481c`.** Daily Grind on rtx_pinball uses `cleanup_rule.mode = 'scheduled'`, which keeps every COMPLETED game on the public scoreboard until the Wednesday cleanup cron. Pre-fix, an admin who deactivated a game with no scores had no UI affordance to remove it before that scheduled run. New endpoint `GET /api/rooms/:roomId/games/retained-completed` mirrors `LeaderboardService.getActiveLeaderboards`'s retention logic (capped at 100 rows per tournament for `scheduled` mode). Tournaments admin page now renders a "Retained Completed Games" card below Active Games with a Delete button per row, reusing the same type-to-confirm dialog and the new `DELETE /api/rooms/:roomId/games/:id` endpoint.

### Architecture

`TournamentEngine.deleteGameCompletely(gameId, opts?)` is the new destructive variant. Steps: final-sync → `deleteGame()` on iScored (shared-`iscored_id` guarded) → orphan local scores (`UPDATE submissions/score_history SET game_id = NULL`, `UPDATE global_scores SET origin_game_id = NULL`) → `DELETE FROM games`. Score *records* are preserved per the ADR 0005 cascade pattern so player personal history survives a "wrong game" delete.

The `finalSyncScoresForGame()` helper is shared by `deactivateGame()`, `processSlotMaintenance()`, and `deleteGameCompletely()`. It pulls via `IScoredApiClient.getGameScores` (HTTP, fast), respects `player_aliases` + `user_mappings` exactly like the live SyncPoller, and uses `iscored:<name>` synthetic discord_user_ids for unmapped iScored users.

The duplicate-DM bug had two layers:
1. **Root cause** — iScored game IDs got reused across `games` rows because the legacy "lock on deactivate" never deleted them. Cleared structurally for new flows by the Deactivate-vs-Delete split (Delete cleans iScored when an admin chooses to; Deactivate locks but keeps the link, and the SyncPoller's `ORDER BY` handles the legacy reuse case).
2. **Surface fault** — SyncPoller's non-deterministic `db.get` could pick the wrong row when an `iscored_id` was shared. Fixed by Fix B's `ORDER BY`.

Both layers shipped — Fix B is the correctness patch, Fix A is the structural cleanup.

### Files

Backend:
- `src/engine/ScoreSyncPoller.ts` — `ORDER BY` status pref + `created_at DESC LIMIT 1` on the per-account local-game lookup
- `src/engine/TournamentEngine.ts` — `deactivateGame()` rewritten (lock + final-sync, keeps `iscored_id`); `processSlotMaintenance()` follows the same contract; new `deleteGameCompletely()` method; new private `finalSyncScoresForGame()` helper
- `src/api/routes/rooms.ts` — new `DELETE /:roomId/games/:id` route → `deleteGameCompletely`; new `GET /:roomId/games/retained-completed` route mirroring `LeaderboardService` retention logic
- `src/discord/commands/deactivategame.ts` — embed wording reverted to "locked on iScored"; surfaces `finalSyncedScores` count

Frontend:
- `admin-ui/src/pages/Tournaments.tsx` — new "Retained Completed Games" `NeonCard`; new "Delete" button on Active Games rows; new type-to-confirm dialog; broadened `deleteGameTarget` state to a structural `DeletableGame` type so both ActiveGame and RetainedCompletedGame work; deactivate toast wording updated to reflect lock semantics + captured-late-scores suffix
- `admin-ui/public/sw.js` — `CACHE_NAME` bumped `arcaid-v34` → `arcaid-v37` (three bumps across the v2.7.2 cycle)

Docs:
- `CLAUDE.md` — "iScored integration" section now documents the Deactivate vs Delete contract, `finalSyncScoresForGame` semantics, and the SyncPoller `ORDER BY` defense
- `CHANGELOG.md` — this entry
- `package.json` — `version: 2.7.2`

Note: commit `e28cdb81` (between `7c7cf8b8` and `aef1d0ff`) was a user-authored fix for a `MergeService` query referencing a non-existent `tournaments.end_date` column — the query was rewritten to derive a completion timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` for the tournament. Unrelated to the dethrone-DM arc but bundled into the same release window.

### Migration notes

None — no schema or data changes.

One-off prod cleanup: a "Spooky Retro" games row (deactivated under the first-cut "always delete" version of v2.7.2) was sitting on the public scoreboard with no admin affordance to remove it. Deleted via `docker exec arcaid node -e ... TournamentEngine.getInstance().deleteGameCompletely('5fab0c5e-…')` — `iScored: skipped` (admin had already cleared it manually), 0 scores orphaned. Future occurrences of this scenario are now self-service via the Retained Completed Games card.

### Open followups

None new from this arc. Existing items in `ROADMAP.md` (style overlay re-keying, ScoreSyncPoller adaptive backoff, fetch-agent self-heal on N consecutive failures) are unaffected.

---

## [2.7.1] — 2026-04-26

**Tournament platform-rules orthogonality (ADR 0009).** Patch release fixing a submission-picker bug surfaced after v2.7.0 deploy.

### Bug

Player attempting to submit a VPX score for **WHO dunnit** (catalogue + room tags = 6 platforms: vpx, vpxs, real, pinball_fx, pinball_fx_vr, atgames) under the **Daily Grind** tournament (`Must = [atgames]`, `NotAllowed = []`) saw only AtGames in the picker — captioned "(only platform for this game)".

The game *is* multi-platform; the tournament rule's `Must` clause was incorrectly narrowing the submission picker. Per the user-clarified semantics, `Must` is purely a game-level eligibility gate ("this game qualifies for the tournament") — once a game is admitted, scores from any of its platforms count (modulo `Not allowed on`).

### Fix

Two commits, FE + BE:

- **`9dc58ad4` (FE)** — `SubmissionSheet` now also tracks `data.platforms` (full pre-rule set) from `/api/submit/platforms` into `fullGamePlatforms` state. The single-platform chip caption disambiguates: `fullGamePlatforms.length > 1` → "(only platform allowed by this tournament)" else "(only platform for this game)". SW `CACHE_NAME` → `arcaid-v34`.
- **`faf86557` (BE)** — `resolveSubmittablePlatforms` drops the `required` clause. Returns `gamePlatforms − excluded`, period. `passesplatformRules` (game-level gate) unchanged — still checks `required` only. The two helpers now enforce one axis each, no overlap. JSDoc on both helpers rewritten to spell out the orthogonal-axes contract. `ensurePlatformAllowed` (server-side validator) inherits the corrected behavior through the same helper.

### Architecture

ADR 0009 — **Tournament platform rules are orthogonal axes**:

| Rule | Helper | Axis |
|---|---|---|
| `required` ("Must") | `passesplatformRules` | Game-level eligibility ONLY |
| `excluded` ("NotAllowed") | `resolveSubmittablePlatforms` | Submission-level filter ONLY |

Worked example: WHO dunnit on `[vpx, vpxs, real, fx, fx_vr, atgames]`, tournament `Must=[atgames], NotAllowed=[]`:
- `passesplatformRules` → TRUE (game has atgames → admissible)
- `resolveSubmittablePlatforms` → all 6 platforms (nothing excluded)
- Picker: 6-option dropdown. Player submits any.

ADR 0006 (platform stratification) is not formally superseded — its core decision (every score row carries `platform`; per-game picker UX) is intact. The Decision section's "∩ required" phrase is now stale; ADR 0006 has a Notes section pointing at 0009 for the corrected resolver semantics.

### Files

- `src/utils/platformRules.ts` — `resolveSubmittablePlatforms` simplified; both helpers' JSDoc rewritten
- `admin-ui/src/components/SubmissionSheet.tsx` — `fullGamePlatforms` state + caption disambiguation
- `admin-ui/public/sw.js` — `CACHE_NAME` → `arcaid-v34`
- `CLAUDE.md` — Platform stratification section rewritten with two-axis table + worked example
- `README.md` — feature blurb + Tournament Settings table corrected to reflect orthogonality
- `docs/decisions/0009-tournament-platform-rules-orthogonal.md` — new ADR (full Context / Decision / Consequences / Alternatives)
- `docs/decisions/0006-score-platform-stratification.md` — Notes section pointing at 0009
- `docs/decisions/README.md` — index entry

### Migration notes

None — no schema or data changes. Behavior shift is deliberate: tournaments previously created with `Must=[X]` expecting it to lock submissions to platform X will now accept all of an admitted game's platforms. Admins wanting a hard submission lock should use `NotAllowed` for the platforms they want to block.

---

## [2.7.0] — 2026-04-26

**Multi-arc release.** Per-room game tagging (ADR 0008), tournament platform-rules semantics shift, two new catalogue sync sources (Pinball FX VR + AtGames Sheet), library bulk operations + search overhaul, iScored credentials hardening, ScoreSyncPoller log-spam fix.

### Per-room game tagging — ADR 0008

New `room_game_tags(game_room_id, global_game_id, tag)` table. Variant-keyed via `global_games.id` so the FE's variant rows tag independently. Tags are lowercased + trimmed on write; rendered via `getPlatformDisplay` (uppercase fallback for non-canonical tokens like "WMS"). Distinct from the surviving (deprecated) `game_room_game_library` overlay so the eventual style-overlay re-keying doesn't have to touch tags.

Read paths union catalogue platforms with room tags everywhere a game-level platform check happens:
- `ensurePlatformAllowed` (submission-level)
- `/api/submit/platforms` resolver
- `/:roomId/platforms/available` (tournament rules picker)
- `/:roomId/game_library` returns `room_tags: string[]` per row
- Web pick-game route, admin activate-game route
- Discord `/activate-game`, `/pick-game` autocomplete
- `TournamentEngine.autoPickAndActivate` (tournament rotation auto-pick)
- `TimeoutManager` fallback auto-pick

Endpoints (all under `/api/rooms/:roomId/`): `GET /games/:globalGameId/tags`, `POST /games/:globalGameId/tags`, `DELETE /games/:globalGameId/tags/:tag`, `POST /games/bulk-tag` (cap 500), `POST /games/bulk-untag`.

`RoomGameTagsService.getTagMapByGameNameForRoom(roomId)` powers the autopick / autocomplete batch lookups (single SQL JOIN, no N+1).

Migration 093 inline. See ADR 0008 for the rationale.

### Tournament platform-rules semantics shift

`Not allowed on` was previously a game-level rejection ("game with this platform tag won't enter the tournament"). It's now a **submission-level filter only** ("the score's selected platform can't be in this list — game itself can still be picked"). `Must be available on` stays a game-level gate (game must list at least one required platform).

The shift required:
- `passesplatformRules` drops the `excluded` clause (game-level gate checks `required` only).
- `TournamentEngine` autopick + `TimeoutManager` fallback autopick filters drop the inline excluded check.
- Tournament form's "Not allowed on" subtitle copy: "(blocks score submissions, not game selection)".
- Inline validator catches the contradictory case: same platform in both `Must` and `Not Allowed` → error chip + Create/Save buttons disabled. `getPlatformRuleConflicts` exported helper.

Backwards-compat note: existing tournaments with `excluded=[X]` under the old semantics silently begin admitting games that carry X. Behavior shift is deliberate.

### Pinball FX VR catalogue tagger

Hand-curated source-of-truth (`tmp/fx-vr-tables-draft.md`, gitignored) → emitted TS data module (`src/services/fxVrPackContents.ts`, committed) → `FxVrImportService.applyTags()`. 39 tables across 17 packs (Williams Vols 1/2/3/9/10 + Tomb Raider + Universal Monsters + Scared Stiff + Elvira + Charlie Brown + Godzilla vs Kong + Bethesda + Universal TV Classics + 5 standalone titles + 3 base FX VR Zen originals).

Service uses `GlobalGameService.upsert` so real-machine recreations (Theatre of Magic, etc.) merge `pinball_fx_vr` into existing VPS-imported rows without clobbering manufacturer/year, and Zen originals (Sky Pirates: Treasures of the Clouds, etc.) auto-create with `imported_from='fx-vr'`. Idempotent.

Migration 094 cleans up the legacy bare `vr` token (3 prod rows: Monster Bash, Indiana Jones, Theatre of Magic) — promotes to `pinball_fx_classic_vr` if `pinball_fx_classic` was already present, then strips the bare token.

Admin endpoint `POST /admin/catalogue/sync-fx-vr` + button on the Catalogue page. Refresh cycle: edit `tmp/fx-vr-tables-draft.md`, regenerate via `node tmp/emit-fx-vr-data-ts.js > src/services/fxVrPackContents.ts`, click "Sync FX VR".

### AtGames catalogue sync from curated Google Sheet

`AtGamesImportService` pulls column A of the user's curated availability sheet (`https://docs.google.com/spreadsheets/d/.../export?format=csv&gid=...`, no API key — public CSV export). Same upsert pattern as FX VR.

Phase 2 extension parses cabinet variants from columns H/I/J/K (per-porter-studio cells with values like `HD`, `4K`, `Micro`, `HDP`, `ALU`, `Mini`, `Gamer`, `Core`). Strips `(most)` / `(some)` parentheticals; skips leading-paren `(coming soon)` cells; skips non-cabinet tokens (Steam, Pinball Arcade, Mobile, Xbox, etc.). Always-tag invariant: every row in column A gets the broad `atgames` tag plus one `atgames_<variant>` per detected cabinet (deduped).

Six new canonical platform IDs: `atgames_micro`, `atgames_hdp`, `atgames_alu`, `atgames_mini`, `atgames_gamer`, `atgames_core`. HD + 4K already existed. Display labels shortened: "AtGames Legends" → "AtGames" (and HD/4K variants). Mirrored across `src/utils/platformMapping.ts` (BE) and `admin-ui/src/lib/platforms.ts` (FE).

Tiny inline CSV parser in the service (no `papaparse` backend dep). Unicode-quote normalization (`’` → `'`) so curly-quoted sheet names match catalogue rows that store straight quotes. Studio attribution via column A fill color skipped per user direction — HTML export path is achievable later if a use case appears.

Endpoint `POST /admin/catalogue/sync-atgames` + button. Production result: 260 rows updated, 0 created (every sheet name matched an existing VPS-imported catalogue row).

### Library page — bulk ops + manufacturer filter (initial) + search overhaul

**Bulk select** — checkbox column on the library table, header checkbox toggles "select all on this page" with selection persisting across pagination. Sticky bottom action bar when ≥1 row is selected: `Tag…` / `Activate…` / `Pin` / `Clear`. Bulk tag uses the new `bulk-tag` endpoint (single SQL multi-insert). Bulk activate + pin use 5-way concurrent worker loops over the existing single-game endpoints with best-effort summary toasts.

**Per-row Tag button** next to Activate/Pin/Style. Opens a dialog with chip-style remove + add input + suggestions from existing room tags.

**Tag chips** render in amber (distinct from cyan catalogue platform chips) so room-only tags are visually separable from catalogue truth.

**Search bar** rewritten:
- Substring match across `name`, `manufacturer`, `year`, `platforms`, `room_tags`, `designers`, `themes`, `table_authors`, `catalogue_aliases`. (Server endpoint extended to ship `designers` / `themes` / `table_authors` / `catalogue_aliases` — VPS catalogue metadata that wasn't in the FE response before.)
- Inline year-range syntax: `2001-2020` (with optional whitespace around the hyphen). `Williams 2001-2020` ANDs the range with the substring query. Strict `\d{4}-\d{4}` pattern in `[1900, 2100]` so we don't consume hyphens in real game titles.
- Live preview line shows what the parser extracted vs. substring-matched.
- Hint text under the input lists every searched field.

**Manufacturer chip-row filter was added then removed in the same release.** Initial design overshot; user wanted smarter search instead. Reverted in favor of the search-bar metadata expansion above.

**Variant disambiguation on the library row** (post-step-2 follow-up): catalogue rows for "Carnival" (4 variants: Bally 1948, Bally 1957, Sega 1971, Playmatic 1977) now show a sub-line `Manufacturer, Year` to visually distinguish. Server returns `id`, `manufacturer`, `year` per row; FE keys React rows by `id` to fix the duplicate-key reconciliation glitch causing the "alphabet restart" symptom users were seeing.

**Client-side pagination** (100 rows/page, `[Prev] [1] [2] … [N] [Next]` with truncation). Resets to page 1 on filter/search/sort change. Search/filter/sort still operate over the full dataset; only the render is paged.

`PlatformChips` got an uppercase fallback for unknown platform IDs: `fx2` → `FX2`, bare `vr` → `VR` (until cleanup migration kills these legacy tokens).

### iScored credentials hardening

**Bug**: admin would activate a game (worked), then deactivate the game (silently failed to lock on iScored — game orphaned). Cause: activate handler used `new IScoredClient()` (env fallback creds), deactivate handler used `getIScoredCredsForRoom()` (per-room creds). When per-room creds were misconfigured, only deactivate failed.

**Fixes**:
- Activate handler now uses `getIScoredCredsForRoom()` like every other path. If per-room creds are wrong, activate fails visibly upfront — before the DB row is created — instead of papering over with env fallback.
- `TournamentEngine.deactivateGame` return signature gains `iscoredStatus: 'locked' | 'failed' | 'shared' | 'skipped'` plus `iscoredError`. FE renders four distinct toasts so admins know whether iScored was locked, skipped intentionally (DB-only), still active in another tournament, or failed (with the error).
- `IScoredClient.connect` classifies login-timeout failures: detects whether the Log In button is still visible after the userDropdown wait fails, and throws either `"iScored rejected the credentials (wrong username or password)."` or `"iScored login timed out — possible rate limit, iScored slow/down, or login page changed."` — replacing the raw Playwright `locator.waitFor: Timeout 15000ms exceeded waiting for #userDropdown` dump.
- New `POST /api/rooms/:roomId/iscored/validate` endpoint runs a quick login attempt and reports `{ ok, username, error }`. New `IScoredCredentialsCheck` component on Settings → iScored renders a `Validate Credentials` button + green-check / red-x result inline. Useful for pre-flighting credential issues.

### ScoreSyncPoller — per-account error suppression

After a 14-minute iScored API outage produced 32 consecutive identical `TimeoutError` log lines, found two bugs:

1. **Per-account errors logged unconditionally.** Outer `poll()` catch had suppression (logs first 3, suppresses thereafter), but `pollOneAccount` failures were caught at the per-account level inside the for-loop and logged on every cycle.
2. **`_lastPollSucceeded` was always `true`.** Set after the per-account loop completed regardless of per-account outcomes.

Fixes:
- New `accountConsecutiveErrors: Map<gameroomName, number>` mirrors the outer counter at per-account scope. Logs first 3 errors per account, suppresses thereafter, logs a `recovered after N failure(s)` line when an account that was failing succeeds.
- `_lastPollSucceeded` reflects whether at least one account succeeded.

Not in scope (next step if needed): adaptive backoff during sustained outages (currently still hits iScored every 5s during outage, just doesn't log it).

### Build + deploy

SW `CACHE_NAME` walked v20 → v33 across 11 UI-visible commits. Backend tsc clean throughout. Admin-ui vite build clean. **109/109 tests pass.**

Migrations 090 (alias column), 091 (alias backfill), 092 (DROP TABLE game_library), 093 (room_game_tags), 094 (legacy `vr` cleanup) all idempotent. New canonical platform IDs require no DB migration (platforms are JSON-array TEXT).

---

## [2.6.0] — 2026-04-26

**Refactor.** Step-2 cleanup of the legacy `game_library` table and the `game_room_game_library` overlay reads. Completes the "library = global catalogue" arc started in v2.5.1 — tournaments, Discord autocomplete, leaderboard image fallback, and the per-room library page now all read from `global_games` directly. Plan: `docs/step-2-cleanup-plan.md`. Shipped in 7 sequential commits (2c → 2a → 2b → 2g → 2d → 2f → 2e), each independently buildable.

**2c — drop `game_room_game_library` overlay reads.** Removed all reads of `custom_platforms` and per-room `display_name` (added in v2.4.0). Nine sites dropped the JOIN + `mergeEffectivePlatforms` step: `ensurePlatformAllowed`, `/api/submit/platforms`, pick-game route, activate-game route, TournamentEngine auto-pick, TimeoutManager fallback, Discord `submitscore` + `pickgame` + `activategame`. Deleted `PUT /:roomId/game_library/:name/overlay` (server-only — no FE caller). `GameLibraryService.{setRoomCustomPlatforms,setRoomDisplayName,getEffectivePlatformsForGame}` removed. `roomOverlay.test.ts` deleted.

**2a — preserve `game_library.aliases` onto `global_games`.** Migration 090 added `global_games.aliases TEXT DEFAULT '[]'`. Migration 091 walked `game_library` and JSON-encoded each non-empty CSV alias list onto the matching `global_games` row, keyed via `gl.global_game_id`. Production: **2523 rows** backfilled. Honest scope note — `game_library.aliases` turned out to be write-only metadata; no runtime reader. Preserved as insurance for a future search-by-alias / iScored alt-name feature.

**2b — switch tournament/leaderboard reads to `global_games`.** `LeaderboardService.getActiveLeaderboards`, `TournamentEngine.activateGame`/`processSlotMaintenance`/auto-pick, `TimeoutManager` fallback auto-pick, `gameCreation.ts` (pin path), `rooms.ts` (game-info image_url, game-availability listing, pick-game read, freeplay/community card-data, admin activate-game, pin validation, iScored sync-create), Discord `submitscore`/`pickgame`/`activategame`/`viewstats`/`viewselection` autocomplete — all switched. Image fallback collapses to `gg.local_image_path → gg.wheel_image_path → gg.image_url`. iScored `client.createGame(name, styleId)` now passes `undefined` (defaults take over). `client.applyStyle(...)` calls dropped — the style-learning loop had no consumer post-2c.

**2g — admin-ui catalogue browser.** `GameLibrary.tsx` is now read-only with two write paths: Add Game (→ `submit_to_global` only) and Import CSV (→ `submit_to_global` only). Removed: edit modal, delete-selection checkboxes, "Edit" + "Delete Selected" buttons, "Style ID" column, `aliases` / `style_id` / CSS-override fields in the Add form, `ConfirmModal` import. Proposal panel: exact-match shows "already in catalogue, pin/activate from the table"; possible-match shows duplicates as informational rows + a single "submit as new" CTA. CSV preview's needs_review rows lose the per-row "use existing" / "room_only" buttons. CSV template simplified: `name,manufacturer,year,mode,platforms`. Sort key drops `style_id`. Backend: `GameLibraryService.search` queries `global_games` (status='approved', `GROUP BY LOWER(name)`). SW `CACHE_NAME` → `arcaid-v19`.

**2d — simplify proposal + CSV-import endpoints.** DELETE `POST /:roomId/game_library/use_global` (catalogue is the library — link is a no-op). DELETE `POST /:roomId/game_library/room_only` (no per-room library). KEEP `/proposals` (read-only dedup preview). Simplify `/submit_to_global` to insert the pending `global_games` row only — no library writes. Simplify `/import-csv-commit` to handle `submit_to_global` decisions only; auto_link rows skipped client-side. Counts shape: `{ submitted_pending, skipped, errors }`. `UseGlobalGameSchema` removed; `ImportCsvCommitSchema.decision` narrowed to `z.literal('submit_to_global')`.

**2f — drop legacy admin endpoints.** Removed 7 endpoints from plan §2f plus 3 sibling super-admin endpoints depending on dying tables: `GET /admin/game_library`, `POST /admin/game_library/{import,delete,merge,import-vps,import-wizard}`, `PUT /admin/game_library/:name`, `POST /:roomId/game_library/{import,delete}`, `PUT /:roomId/game_library/:name`. `VpsImportService` + `WizardImportService` dropped their dual-write to `game_library` + the `addToRoom` calls in `/catalogue/sync-vps`+`/catalogue/sync-wizard`. `TournamentEngine` style-learning loop (`client.syncStyle` → `GameLibraryService.updateStyles`) removed. `/admin/games-for-picker` switched the "library games" half to query `global_games` directly. `GameLibraryService` trimmed to 3 still-used methods: `search`, `setRoomGameStyle`, `getRoomGameStyle`. Schemas dropped: `ImportGamesSchema`, `UpdateGameSchema`, `gameFields`, `platformsField` helper.

**2e — DROP TABLE game_library.** Migration 092 (`DROP TABLE IF EXISTS game_library`) runs after 091's alias backfill. Final reader cleanups: `/api/submit/platforms` drops the `gl` first-leg lookup; admin display_name endpoint drops the dual-write; `GlobalScoreService.fanOutFromRoomSubmission` third resolution leg switches from `game_library` to `global_games WHERE status='approved'`; `GlobalGameService.merge` drops the `UPDATE game_library SET global_game_id` repointing call; boot-time `tournament_types→platforms` migration code removed (years-old, applied long ago in prod); `migrateToMultiRoom` step 5 (`INSERT INTO game_room_game_library SELECT FROM game_library`) removed. The `CREATE TABLE` for `game_library` at the top of `initDatabase` is intentionally left in place — fresh DBs need it to satisfy the early ALTER migrations (005, 006, 009, 027, 033, 039) and the alias backfill in 091, before 092 finally drops it.

**Scope deviation from the plan: drops only `game_library`, not `game_room_game_library`.** The plan's column audit for the bridge table listed `custom_platforms`, `display_name`, `global_game_id`, and the PK — but missed the per-room style overlay columns (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) that are still actively read by `gameCreation.ts` + `TournamentEngine` + `StyleCatalogueService` and written by `GameLibraryService.{set,get}RoomGameStyle` + the StylePicker FE. Dropping `game_room_game_library` without re-keying that overlay onto a new `(game_room_id, global_game_id)` table would lose data and break Style assignment. Out of step-2 scope; tracked as a follow-up cleanup.

**Tests:** 109/109 pass. Three test files affected: `roomOverlay.test.ts` deleted (4 tests — overlay surfaces gone); `catalogueBackfill.test.ts` deleted (4 tests — tested migration 069 backfilling the soon-to-be-extinct table); `thinDuplicateMerge.test.ts` first test dropped its `repoints game_library` assertion (game_library no longer exists at runtime); `pinEndpoint.test.ts` setup seeds `global_games` instead of `game_library`.

**Production deploy verification:** migration 091 backfilled aliases onto **2523 `global_games` rows**; migration 092 dropped `game_library`; `ScoreSyncPoller` resumed normally with 18 entries on first poll. ADR 0007 ("Library = global catalogue") still applies — this release is the natural completion of step 1.

---

## [2.5.2] — 2026-04-26

**Patch.** Game library page showed duplicate platform tags per game (`fp` AND `FP`, `vpx` AND `VPX`, `pinball_fx_classic` AND `FX3`). Migration 083 only rewrote the literal `pinball_fx3` token; case mismatches and aliases survived in `global_games.platforms` / `game_library.platforms` JSON arrays.

- **Migration 089** — one-time normalization sweep. Walks every JSON platform array (`global_games.platforms`, `game_library.platforms`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules`) and folds each entry through `normalizePlatform()`. Dedupes case-insensitively. Production landed: 2733 `global_games` rows, 2813 `game_library` rows, 4 tournament rule rows normalized. Idempotent.
- **`GameLibrary.tsx`** — defense-in-depth at render time. `PlatformChips` alias-folds + dedupes via `normalizePlatformList()` then renders `getPlatformDisplay(id)` (e.g. "FX Classic" instead of `pinball_fx_classic`). Filter pill row above the grid does the same. Filter match logic normalizes the game's raw list so filtering works on pre-089 data too.

SW `CACHE_NAME` → `arcaid-v18`.

---

## [2.5.1] — 2026-04-26

**Feature + patch.** Per-room library page reads from `global_games WHERE status='approved'` directly — every room sees the full approved catalogue. The legacy `game_room_game_library` curation overlay is no longer consulted for the list view. This is "step 1" of a two-step cleanup; step 2 (drop the legacy `game_library` / `game_room_game_library` tables, move aliases onto `global_games`, simplify proposal endpoints) is documented in `docs/step-2-cleanup-plan.md`. Tournaments still pick from `game_library` for now — out of scope for step 1.

Three platform-display bugs fixed:

- **Submission picker showed raw IDs and case-mismatch duplicates.** `/api/submit/platforms` resolver now alias-folds + dedupes via `normalizePlatform()` server-side; `SubmissionSheet` renders display names from a new FE-side `admin-ui/src/lib/platforms.ts` helper. Same treatment applied to `GameDetail` tabs and per-row platform badges.
- **Display names shortened** for the Zen Studios FX family + Zaccaria: `"Pinball FX Classic"` → `"FX Classic"`, etc. Catalogue IDs unchanged. Display-only — no DB migration.
- **Global game detail page now has a Platform column** on the cross-room leaderboard. `GlobalLeaderboardService.recalculate` SELECTs `gs.platform`, propagates through `GlobalRankedEntry`, renders as a chip. Migration 088 flushes both leaderboard caches so existing entries pick up the platform field on next read.

SW `CACHE_NAME` → `arcaid-v17`.

---

## [2.5.0] — 2026-04-26

**Feature.** VR + Steam-pinball platform taxonomy expansion, score-platform stratification, per-room contribution flow rationalization. Coordinated bundle — score-platform is required end-to-end, so partial deploys would reject every submission.

**Platform taxonomy.** Adds 7 canonical IDs: `pinball_fx_classic` (replaces `pinball_fx3`, Zen rebrand), `pinball_fx_classic_vr`, `pinball_fx_midnight`, `pinball_fx_vr`, `star_wars_pinball_vr`, `zaccaria`, `zaccaria_vr`. Removed legacy `pinball_fx3` + generic `vr` bucket. New `'VR'` `PLATFORM_GROUPS` quick-pick. `PLATFORM_ALIASES` + `VPS_FORMAT_MAP` fold pre-rebrand names forward.

**Steam Pinball importer.** `SteamPinballImportService` pulls DLC lists from six Steam apps. Curated `PACK_CONTENTS` map (78 packs → 220 table entries) baked in via `steamPinballPackContents.ts`; pack DLCs expand into per-table upserts rather than landing as a single pack-named row. Skip-list catches Volume/Pack/Bundle/Tables/VR/Soundtrack/Editor/Mode entries. `cleanTableName` strips ™/®/©/℠ + wrapping quotes. `findSuffixVariantMatch` folds "X" / "X Pinball" duplicates pre-upsert. 1100ms inter-fetch throttle; 30s back-off on HTTP 429. Production import: 152 imported / 198 updated / 78 packs expanded / 0 errors. Admin route: `POST /api/admin/catalogue/sync-steam-pinball`. UI: new "Steam Pinball" button on `/admin/catalogue`.

**Score-platform stratification.** Required `platform` field on `submissions`, `score_history`, `community_scores`, `global_scores` (column nullable in SQL for legacy rows; required at the API boundary via Zod). New `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` helper — game's effective platforms ∩ active tournament rules. Server-side `ensurePlatformAllowed` re-validates at every submit handler. `SubmissionSheet` picker: read-only chip when 1 platform, required dropdown when 2+. Discord `/submit-score` auto-fills when 1, rejects with valid-choices reply when 2+. `ScoreSyncPoller` stamps `tournament.iscored_default_platform` on synced rows. Leaderboard endpoint accepts `?platform=<id>`; per-game distinct-platform list returned for the GameDetail tab strip. RankedEntry carries per-row platform; "All" view shows platform badges + demotes NULL-platform rows to a "Platform unknown" tail.

**Per-room contribution flow.** Removed legacy "Import from VPS" / "Import VPXS Wizard" buttons from the per-room game library page (server endpoints kept for now). New `GlobalGameService.findCandidates` (read-only dedup walker, extracted from `upsert`) powers four new per-room routes: `/game_library/proposals`, `/use_global`, `/room_only`, `/submit_to_global`. Add Game UX renders an inline result panel (exact / possible / no-match) with the three commit choices. CSV import switched to two-step preview/commit: `/import-csv-preview` categorizes rows into `auto_link` / `auto_submit` / `needs_review`; FE renders bucketed preview with per-row decision UI; `/import-csv-commit` applies decisions per-row best-effort.

**Super-admin Catalogue Approvals.** `GET /admin/catalogue/pending` (joined with submitter + room), `/pending-count` (nav badge polled every 60s), `POST /pending/:id/approve`, `/reject` (audited reason), `/merge_into/:targetId` (delegates to `GlobalGameService.merge`). New `CatalogueApproval.tsx` page; nav badge in `SuperAdminLayout`.

**Visibility hardening.** Public `GET /global/games` hard-codes `status='approved'` (was honoring `?status=` query — leak risk). Aligned `'pending_review'` stub references to `'pending'` across `getCounts` + status PATCH validator.

**Migrations 083–087.**
- 083 — rename `pinball_fx3` → `pinball_fx_classic` across `global_games`, `game_library`, `game_room_game_library`, tournament `platform_rules`. Production landed: 102 `global_games` rows + 99 `game_library` rows.
- 084 — `ALTER TABLE … ADD COLUMN platform TEXT` on submissions/score_history/community_scores/global_scores + composite indexes; `tournaments.iscored_default_platform`; `submission_drafts.platform`.
- 085 — backfill platform on legacy score rows where the source game has exactly 1 platform; multi-platform rows stay NULL. Production: resolved 62 submissions / 9 score_history / 67 community_scores; left NULL: 18 / 80 / 10 / 23 (multi-platform games).
- 086 — flush `leaderboard_cache` + `global_leaderboard_cache` for the new platform-bearing `RankedEntry` shape.
- 087 — `global_games.{submitted_by_user_id, submitted_by_room_id, submitted_at}` + partial index on `(status, submitted_at) WHERE status='pending'`.

**Bug surfaced + fixed inline:** four sites used `JOIN game_library gl ON gl.id = grgl.game_library_id` — but `game_library`'s PK is `name` and the FK column is `game_name`. Would have failed at runtime on first `docker compose up`.

SW `CACHE_NAME` → `arcaid-v16`.

---

## [2.4.16] — 2026-04-25

**Patch.** Catalogue UX + diagnostics.

- **Logger writes `Error.stack` to file instead of `{}`.** `formatLogArg()` in `src/utils/logger.ts` special-cases `Error` so the rotating file stream and the admin Logs viewer get the actual stack — previously every `logError(msg, err)` site silently lost detail because `Error.message` and `.stack` are non-enumerable and `JSON.stringify` skipped them. Console output was unaffected (Node's `util.inspect` handles Error specially), so this had been hiding for the entire life of the project. The trigger was `Background OPDB sync error: {}` showing in the file.
- **OPDB / IGDB sync routes return 400 when credentials are missing.** Previously they returned `202 started`, threw inside the background task, and the only signal was a swallowed log line. Routes now validate `process.env.OPDB_API_KEY` / `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` upfront. The admin-ui catch-and-toast pattern surfaces the message directly.
- **OPDB API Key + Twitch Client ID/Secret added to Global Settings → Configuration.** Three new fields with masked inputs + reveal toggles for the secrets. The error messages now point to a section that actually exists.
- **`OPDB_API_KEY` and `TWITCH_CLIENT_SECRET` join the at-rest encryption allowlist.** Parity with `ISCORED_PASSWORD`. Twitch Client ID stays plaintext (it's a public identifier).
- **VPS catalogue import accepts broken-flagged entries.** Bluey, Britney Spears, Chime Speed Test Table and similar rows showed up as bare entries on `/scoreboard` because the importer's `playable` filter (gating both legacy `game_library` and global catalogue) excluded VPS entries with `broken: true`. The filter served the legacy path correctly — broken tables shouldn't be selectable for tournament picks — but it also blocked the global catalogue, which is just identity + metadata + images. Split into `playable` (game_library) and `cataloguable` (any entry with a name → global_games + image download pass).

SW `CACHE_NAME` → `arcaid-v15`.

---

## [2.4.15] — 2026-04-24

**Patch.** VPS re-indexing case. VPS occasionally re-registers entries with new `vps_id` values; on the next sync, step 1 (external-ID lookup) misses, and step 4's dedup excluded the row via the `hasExternalIdConflict` Frankenstein-prevention guard, causing `INSERT` to collide on the composite UNIQUE INDEX. Three games failed: "Hot Tip" (Williams 1977), "A-ha" (Original 2025), "Evel Knievel" (Bally 1977).

Fix: step 4 concrete-match path now filters against the full `nameMatches` set instead of `nonConflicting`. A pinball machine has a single canonical `(name, manufacturer, year)` identity by physical reality — divergent external IDs just mean the source re-indexed itself, not that we'd merge unrelated rows. The COALESCE-based UPDATE adopts the new authoritative external ID. The loose path (NULL mfg or year) still applies the conflict guard, since there's no canonical anchor without those.

---

## [2.4.14] — 2026-04-23

**Feature.** Per-tournament scheduler logs gain a `[room-slug]` prefix so site-admin Logs no longer show un-attributed "Scheduling maintenance for Daily Grind" lines. `Scheduler.start()` LEFT JOINs `game_rooms` to obtain the slug; `scheduleTournament` and `scheduleCleanup` accept it as an optional parameter. Super-admin Dashboard adds an **Activity Log** link per room card linking to `/${room.slug}/admin/activity` for per-room drill-down.

---

## [2.4.13] — 2026-04-22

**Feature.** Wizard import is now section-aware. The README parser distinguishes `wizard_auto` (verified VPXS auto-install tables) from `wizard_manual` (Manual Install Tables — hit-or-miss on AtGames Standalone). `WizardImportService.platformsForTable()` tags rows accordingly: `vpxs` for auto, `vpxs_manual` for manual. New canonical platform `vpxs_manual` ("VPX Standalone (Manual Install)") added to `platformMapping.ts`. `reconcileWizardPlatformTags` strips stale tags when a table moves between sections on a re-import. Tournaments requiring reliable VPXS can now exclude unreliable manual ones.

Also: SpongeBob no-parens edge case. Wizard input had no `(Original, 2021)` parens so `parseNameParts` returned undefined mfg/year, and the catalogue had both a rich (Original, 2021) row and a thin backfill residue (NULL, NULL) — both passed the NULL-tolerant `manufacturerYearAgree`. Step 4 loose path now applies a richest-row tie-breaker (`opdb_id + vps_id + igdb_id + manufacturer-not-null + year-not-null` score; created_at as final tie).

---

## [2.4.12] — 2026-04-22

**Patch.** `findByNormalizedName` rewritten to drop the SQL `LIKE '%word%'` prefilter. The previous version computed `firstWord = normalizeGameName(input).split(' ')[0]` and used it to prefilter rows by raw `name` LIKE, but normalization strips punctuation while raw names retain it — so `"gilligans"` couldn't match the stored `"Gilligan's Island"` because the apostrophe broke the substring match. Now does a full-table scan and JS-side normalize compare. At ~5k rows the scan runs in milliseconds; negligible for admin-triggered imports.

---

## [2.4.11] — 2026-04-22

**Patch.** Step 4 concrete filter now requires exact year match (not ±1 tolerance). Tolerance let "Breaking Bad (Original, 2021)" and "Breaking Bad (Original, 2022)" both count as concrete matches for a 2022 input — `concrete.length=2` → fall-through → INSERT → UNIQUE collision. Multi-concrete case adds a richest-row tie-breaker (most external IDs first, oldest `created_at` as tiebreak).

---

## [2.4.10] — 2026-04-22

**Patch.** Two-tier step 4 match. `manufacturerYearAgree` treats NULL mfg/year as "pass," which lets thin-backfill rows (NULL/NULL leftovers from the v2.4.0 backfill) blend into the candidate set and prevent single-hit resolution. Step 4 now prefers candidates that *concretely* agree on both mfg AND year (non-null on both sides, exact match) before falling back to the NULL-tolerant check. Migration 082 re-runs the thin-duplicate merger.

---

## [2.4.9] — 2026-04-22

**Patch.** Removed stale `SYNC_ALERT_CHANNEL_ID = 1467561374040461527` from the seed; it had been baked in and was firing 404s on every sync attempt. Migration 081 scrubs the value if it exists in the live `settings` table.

---

## [2.4.8] — 2026-04-21

**Patch.** Composite UNIQUE INDEX swap. Migration 080 drops `idx_global_games_name_type` (UNIQUE on `(LOWER(name), type)`) and creates `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. The strict 2-column index rejected legitimate same-name pinballs from different manufacturers (Stern Batman 2008 vs Data East Batman 1991, etc.) — 115 errors on the first Wizard import. The composite preserves dedup of true duplicates while letting variants coexist.

---

## [2.4.7] — 2026-04-21

**Patch.** Migration 079 catches no-comma `(Mfg YYYY)` thin duplicates that 078's strict comma regex missed.

---

## [2.4.6] — 2026-04-21

**Patch.** Migration 078 merges thin backfilled catalogue duplicates (rows where `name` contains a parens-baked-in `(Mfg, YYYY)` suffix and a corresponding rich row exists with stripped name + populated mfg/year).

---

## [2.4.5] — 2026-04-21

**Patch.** All Games tab fixes: catalogue card link now resolves to room game detail when mapped (was always going to global); rows with no image are hidden by default to keep the carousel art-forward.

---

## [2.4.4] — 2026-04-21

**Patch.** Migration ledger order fix. Migration 077 (drop NOT NULL on `submissions.game_id`) now runs before 070 (orphan cleanup, which `UPDATE`s `submissions.game_id = NULL`). Pre-fix, prod boot crashed on the orphan cleanup because the column still required non-null.

---

## [2.4.3] — 2026-04-21

**Patch.** v2.4.0 backfill (migration 069) now uses a strict `LOWER(name) + type` exact-match helper instead of `GlobalGameService.upsert`'s 4-step dedup. The dedup matched too aggressively (normalizeGameName collapsed multiple distinct names to the same key) and re-INSERTed rows the migration was meant to backfill, recreating duplicates.

---

## [2.4.2] — 2026-04-21

**Patch.** Migration 068 audit pass now runs multi-pass (up to 3 iterations) to catch residuals where a duplicate group's "winner" itself has another duplicate. Logs unresolved-group diagnostics if any remain.

---

## [2.4.1] — 2026-04-21

**Patch.** Migration 068 auto-merges legacy duplicate `(name, type)` groups instead of aborting. Prod had 112 duplicate groups in `global_games` — pre-fix the unique index creation aborted on first attempt and prod failed to boot.

---

## [2.4.0] — 2026-04-21

**Major.** Catalogue Unification + Pin to Scoreboard.

**Catalogue unification.**
- **Backfill.** Migration 069 populates `global_game_id` on every relevant row in `games`, `game_library`, and `game_room_game_library`. Pre-sprint fill rate was 0% / 0% / 51%; identity now resolved through the FK rather than name-based JOINs (with name-based COALESCE fallbacks kept as defense in depth).
- **UNIQUE INDEX `idx_global_games_name_type`** on `(LOWER(name), type)` (later replaced by composite identity index in v2.4.8) closes the read-check-insert race in `GlobalGameService.upsert`.
- **Orphan cleanup.** Migration 070 deletes the 5 legacy pinned games (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id=NULL` that the broken `/list-active` was returning. Reference audit confirmed zero dangling submissions.
- **Per-room overlay.** `game_room_game_library.custom_platforms` and `display_name` columns (migration 071). `effectivePlatforms = union(global, room-custom)`. WMS leagues can add their own platform tags without touching the shared catalogue.
- **Query migration.** High-impact joins switched to FK-based: `rooms.ts` library JOIN, `GameLibraryService` room-library queries, `GlobalScoreService` fan-out short-circuits, `LeaderboardService` + `DashboardService` style-resolution.

**Pin to Scoreboard.**
- Room admins can now pin a game to the scoreboard from the Game Library page, optionally creating it on the room's iScored account in the same step. Pinned games render with a "Pinned" chip on Banner/Showcase/Minimal cards, stay ACTIVE until manually unpinned, don't contribute to cross-tournament rankings, and survive maintenance cycles.
- **Schema.** `games.game_room_id` (denormalized for pinned rows; tournament rows still derive via `tournament_id`), `games.display_order`, unique partial index `idx_games_pinned_unique` on `(game_room_id, LOWER(name)) WHERE tournament_id IS NULL`.
- **Cascade on unpin.** Submissions, score_history, and global_scores `origin_game_id` get `UPDATE … SET game_id = NULL` before the row DELETE — score history preserved even when the game row goes away.
- **Shared `createGameWithIScoredSync()` helper** (`src/engine/gameCreation.ts`) extracted from three duplicated `TournamentEngine` call sites. Returns structured `{ gameId, iscoredStatus: 'created' | 'failed' | 'skipped' }`.

Migrations 068–076 (9 total). 119 tests pass (was 89 + 30 new).

---

## [2.3.3] — 2026-04-19

**Patch.** Discord read commands (`/list-active`, `/list-tournaments`, etc.) now exclude `games` rows with `tournament_id IS NULL` (orphans). The legacy "pinned" attempt left 5 orphan rows on prod that surfaced through these commands as ghost active games. v2.4.0 deletes them; v2.3.3 prevents re-emergence in case future code paths leave orphans.

---

## [2.3.2] — 2026-04-19

**Patch.** Discord-disabled rooms (per-room `DISCORD_ENABLED=false`) now excluded from slash-command queries. Pre-fix, `/list-active` in a connected room would return data from disconnected rooms too.

---

## [2.3.1] — 2026-04-19

**Patch.** Discord slash commands and DM dispatch now gate on the per-room `DISCORD_ENABLED` flag. Demo room could disable Discord but still receive DMs from notification hooks.

---

## [2.3.0] — 2026-04-19

**Major.** Per-room iScored / Discord configuration + at-rest secret encryption.

- **Per-room moves.** Discord guild ID, admin role ID, announcement channel ID, and iScored credentials moved from global to per-room `game_room_settings`. Each room can independently connect to its own Discord guild and iScored account, or disable either integration.
- **At-rest encryption.** New `src/utils/secrets.ts` provides AES-GCM encryption keyed off `SECRETS_KEY` (32-byte hex from env). `ENCRYPTED_SETTING_KEYS` allowlist (currently `ISCORED_PASSWORD`) controls which keys are encrypted on write and decrypted on read. `SettingsService` and `GameRoomSettingsService` consult the registry transparently. Allowlist is intentional (no convention-based auto-encrypt) so a typo like `IS_CORED_PASSWORD` won't silently land in plaintext. `maskEncryptedValues` returns a `[ENCRYPTED]` placeholder on `GET /admin/settings` so the UI never round-trips ciphertext.
- **Pre-deploy DB snapshot pattern** captured for the migration that introduced encrypted columns.

---

## [2.2.15] — 2026-04-18

**Patch.** Room Settings reorganized + Identity moves.

- Room Settings sections reordered: Theme → Scoreboard Display → Scoreboard Branding → Kiosk → Game Room → Integrations → Discord → Users → iScored.
- "Refresh Schedules" button moved to bottom of Tournaments page (was under "System Actions" on Settings).
- Merge / Rename Player moved from Settings to the Identity admin page (`/:slug/admin/identity`).
- Platforms management removed from Settings — covered by the `+` button next to Platforms in the Game Library row editor.
- Discord admin "user not found" error now surfaces a distinct 400 with actionable text.
- Default scoreboard display picker shows the new card styles first (Banner/Showcase/Minimal) with a "Show legacy styles" expander revealing the older card system.

---

## [2.2.14] — 2026-04-21

**Patch.** Swapped Fire and Queue button positions on the Mystery Award cabinet — Queue now sits on the left, Fire on the right. Matches pinball cabinet convention where the "commit/hit" button is on the right. SW `CACHE_NAME` → `arcaid-v9`.

---

## [2.2.13] — 2026-04-21

**Patch.** Mystery Award cabinet redesign.

- **Tournament Pool is now a pinball cabinet topper.** New `TournamentPoolTopper` component renders directly above the backbox as a cabinet attachment — orange LED glow strip, chunky silhouette, "TOURNAMENT POOL — Daily Grind ▼" pill. Clicking opens a drop-down list that overlays the top of the backbox; selecting collapses it back. `MysteryAward` accepts an optional `topper` slot so the page composes it in.
- **Fire and Queue buttons are always visible as circles.** Replaced the branching Hit Mystery / Add to Queue / Log in to queue / Play Again / Close button stack with two persistent circular pinball-cabinet buttons. Fire is always live (triggers a new spin, disabled only while cycling); Queue is grayed out until a game is revealed and the viewer has a Discord login. Labels beneath ("SPIN" / "ADD") clarify action.
- **Queue color matches the cabinet.** Was green. Now an amber-orange sibling of Fire (slightly deeper tint) so both buttons read as part of the same cabinet.
- **"Hit Mystery" renamed to "Fire"** per user preference — matches the cabinet action-button vocabulary.
- **Close moved to a footer text button** (was a NeonButton in the control panel). Less visually competitive with the round action buttons.

SW `CACHE_NAME` bumped to `arcaid-v8` so the cabinet redesign propagates to installed PWAs on next reload.

---

## [2.2.12] — 2026-04-21

**Patch.** Mystery Award: Tournament Pool selector was at `top-[14%]` which overlapped the backbox graphic on mobile. Collapsed it into the top nav row alongside the back link + login CTA — single fixed header at `top-0`, selector centered between the two, so it sits directly above the backbox with no overlap at any viewport width. Label shows "Tournament Pool:" on sm+ and "Pool:" on xs.

SW `CACHE_NAME` bumped to `arcaid-v7` so clients pick up the new bundle on next reload.

---

## [2.2.11] — 2026-04-21

**Patch.** Service-worker cache-bust. `sw.js` uses cache-first for JS/CSS assets and its `CACHE_NAME` had been pinned at `arcaid-v5` since v2.0.x, so installed service workers were serving stale bundles even after browser hard-refreshes. Bumped to `arcaid-v6`. The SW's `activate` handler deletes all caches not matching the current name, so on the user's next page load the old cache is purged and everything reloads fresh.

This is why v2.2.10's username-Link / expand-contrast / Picks-URL changes weren't visible to the tester even though the bundle was correctly deployed.

---

## [2.2.10] — 2026-04-21

**Patch.** Five follow-ups from v2.2.9 testing.

- **Username → player stats everywhere.** BannerCard, MinimalCard, ShowcasePodium (all 3 slots), and ScoreList now render each leaderboard username as a `<Link>` to `/:slug/players/:name` with `stopPropagation` so row-click expand still works. Previously only Room Game Detail's leaderboard had the Link.
- **Expanded history contrast bumped.** The inline mini-history panel under an expanded player was rendering scores at 50% opacity and dates at 25% — nearly invisible against the card background (image #12). Now scores at ~95%, dates at ~65%, panel background opacity bumped from 30% → 55%. Font size up 1px.
- **Mystery Award: pool selector moved under the back link → centered above the modal.** Was tucked in the top-right corner disconnected from the object it controls. Now sits at `top-[14%]` centered horizontally so the Tournament → Mystery Award relationship is visually obvious. Label changed from `Pool:` → `Tournament Pool:`.
- **Pinball-backbox-style action button.** `Hit Mystery` / `Add to Queue` buttons now render as chunky pinball-cabinet buttons — chrome bezel, neon gradient face, pressed-in `:active` state, color-coded (orange for spin, green for queue). Full CSS lives in `index.css` as the `.pinball-action-btn` family.
- **Picks URL is human-readable.** `/:slug/picks?t=<uuid>` became `/:slug/picks?t=daily_grind` (tournament name slugified — lowercased + non-alphanumerics collapsed to underscores). Resolved back to tournament id once the list loads. Back-compat: UUID still works if an old link is clicked.

---

## [2.2.9] — 2026-04-21

**Patch.** Apply the v2.2.8 Link-overlay removal to the places that actually render scorecards.

v2.2.8 removed the Link overlay + passed `titleLinkTo` through CardRouter — but only via `GameCard`. **The public Scoreboard (`Scoreboard.tsx`) and `GamesTabView.tsx` render `CardRouter` directly**, with their *own* overlay Link wrapping. v2.2.8's fix never applied to the room scoreboard the user actually sees. This patch:

- Drops the overlay Links from `Scoreboard.tsx` (all three layouts: grid / vertical / horizontal) and `GamesTabView.tsx`.
- Passes `titleLinkTo={linkForTournamentCard(lb)}` to each `CardRouter` call.
- Drops the now-unused `Link` imports from both files to satisfy TypeScript `noUnusedLocals`.

Same behavior goal as v2.2.8, this time applied to the actual render paths.

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
