# ArcAid — Roadmap

> See SPRINT_STATUS.md for live progress; CHANGELOG.md for shipped versions.

---

## Open Followups

- **Web push follow-ups (S15, 2026-07-15)** — v2.23.0 shipped the smallest-shippable channel (rankDethroned + tournamentWin, opt-in, inert until VAPID keys are set). Deferred: (a) **push-service host allowlist** — subscription endpoints are user-suppliable https URLs (protocol-standard for Web Push, SSRF-shaped; mitigated today by Discord auth + writeLimiter + encrypted opaque payloads). An allowlist of the real-browser push hosts (FCM / Mozilla autopush / WNS / Apple) would close it at the cost of exotic-browser support. (b) **Expand `WEB_PUSH_TYPES`** once field-validated — `turnToPick` is the natural third (time-sensitive, exactly what push is for). (c) **"Disable everywhere" affordance** — the AccountSettings toggle is per-device and the `webPush` prefs flag deliberately survives device unsubscribe; a one-click channel kill (clear flag + delete all rows) would help users with many stale devices. (d) Consider a push-subscription count on the S10 admin health card. (e) VAPID key **rotation** invalidates all subscriptions silently — dead rows now self-prune on 403 at next send, but users get no "re-enable push" prompt; a `pushsubscriptionchange` SW handler + re-subscribe nudge would close the loop.
- **Flaky test: community-scores-attribution case (b) — nested-transaction race (first seen 2026-07-15)** — the S15 deploy run failed once with `SQLITE_ERROR: cannot start a transaction within a transaction` in `community-scores-attribution.test.ts` "(b) authed POST attributes to the TOKEN identity…"; the identical tree was green on two PR CI runs and two local container runs minutes earlier (CI runner was sharing quota with 3 concurrent Dependabot runs — slow machine widens async windows). Hypothesis: a fire-and-forget post-submit chain from case (a) (global fan-out / lobby feed) still holds a transaction on the file's shared in-memory connection when case (b)'s request opens its own. Not S15-related (S15 adds no BEGIN and no async on that path). If it recurs: add a test-mode drain hook for the post-submit chains, or serialize the two cases. Single occurrence → watch, don't invest yet.
- **Unlinked-player affordances (S14 field-testing follow-up, 2026-07-14)** — players whose scores exist only under an unmapped iScored alias are silently unfollowable: the Follow button just doesn't render, and `/friends` returns a bare "Could not find user" — no explanation that the player simply hasn't linked Discord. Confused the operator during S14 verification (own alt account `._arcaid_.` — fixed the moment that account logged in, which runs auth.ts's `user_mappings` upsert). Polish: (a) disabled Follow button with tooltip/caption "This player hasn't linked Discord yet"; (b) `/friends` add-error copy distinguishing "no such player" from "player exists but has no Discord identity" (the enhanced-stats lookup can tell); (c) maybe a hint on the player page pointing admins at `/map-user` / the identity merge tool. Small (~half day).
- **Batched score-counts endpoint (deferred from the v2.18.x scores-page redesign)** — every rendered scoreboard card's `useScoreExpand` fires `GET /:roomId/score-counts/:gameId` on mount (pre-existing per-card behavior). With Room Scores now a primary tab paging 48 cards, one page load = 1 + 48 requests, so two quick reloads within a minute can brush the 100/min per-IP rate-limit backstop and 429 the tab. Fix: a batched `GET /:roomId/score-counts?gameIds=...` (or fold counts into the `room-scores`/leaderboard responses) and update `useScoreExpand` to accept pre-fetched counts. Context: the v2.18.1 hotfix fixed the *infinite-loop* multiplier (unstable `usePlayerHeaders()` object in a dep array — never dep on a `use*Headers()` result; dep on the token string), but the per-card burst remains.
- **S12 privacy residuals (deferred from v2.17.0, both LOW/documented)** — the completeness verify pass surfaced two acceptable residuals in the anonymize-and-keep account deletion: (1) **`submission_drafts` staged proof-photo** — an in-flight OAuth submission draft can write a proof photo to disk, but the table is keyed on `state_param` with NO user column, so `AccountDeletionService` can't find/unlink it; drafts are short-TTL so it self-cleans, but a purge-by-age sweep of `data/score-photos` orphans would close it. (2) **`lobby_feed_events.metadata` JSON** — the purge deletes the user's own feed rows (via `player_id`/`target_user_id`), but a THIRD party's event (e.g. rankDethroned/friendScore) can embed the deleted user's Discord id inside the opaque `metadata` JSON with no dedicated column, so that id can linger until the 90-day feed retention ages it out; a best-effort JSON scrub (or shorter feed TTL) would close it.
- **S11 trust & safety follow-ups (deferred from v2.16.0)** — three items the S11 authz sweep found but left out of scope: (1) **non-Discord admin comment moderation** — the room comment-delete authz tiers only fire for Discord-authed tokens (`conditionalRequireDiscordUser` populates `req.user` only when the token carries a `discordId`), so password/local super/room admins can't delete comments; and the FE (`admin-ui/src/pages/GameDetail.tsx`) sends no Bearer token on comment POST/DELETE, so even Discord admins can't moderate via the UI yet. Needs token-bearing FE wiring (+ possibly a `requireAuth`-based path) — a natural fit for **S22 moderation**. (2) **`community-scores` attribution trust** — `POST /:roomId/community-scores/:gameName` forwards a client-supplied `body.discord_user_id` straight into attribution, so a guest could attribute a score to any Discord user (leaderboard / global-fanout spoofing); fix = drop the body field and derive from `req.user` like submit-score/freeplay. (3) **`RatingService` room-scoping** — room ratings key only on the spoofable `x-user-id` and `RatingService` ignores `roomId` (keyed by `gameName` alone) → cross-tenant rating blend + ballot-stuffing beyond the new per-IP rate limiter.
- **iScored per-score delete (true cascade)** — when admins/players delete a score in ArcAid, the iScored side keeps the entry; today we suppress re-import via `deleted_score_suppressions`, but iScored's public page still shows the deleted score. No documented REST endpoint for per-score delete in `IScoredApiClient`; `IScoredClient` (Playwright) only supports whole-game delete. Investigation needed: (a) does iScored's admin UI expose a "remove this player's score" action, and (b) what's the DOM/flow to script it via Playwright. Once known, add `IScoredClient.deletePlayerScore(gameId, username)` and call from both delete endpoints. Also worth: an admin UI to clear a row from `deleted_score_suppressions` in case a deletion needs to be undone.
- **Reconcile pre-v2.10 iScored orphans** — Paranormal (95735, was on WGV) and Attack from Mars (95586, was on MG) are currently visible on iScored under `mekelburgj@gmail.com` with no matching local DB rows, residue from the parallel-Playwright bug fixed in v2.10.0. Need manual delete via iScored admin UI. A self-service "find iScored entities not present in local DB and offer to delete each" admin tool would handle this case + future drift, but for the immediate two orphans hand-delete is fine.
- **Style overlay re-keying** — `game_room_game_library` survived the v2.6.0 step-2 cleanup because it still carries the per-room style overlay (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`). Re-key onto a new `room_game_style_overlay (game_room_id, global_game_id, …)` table, migrate data, then drop the bridge table. Update callers in `gameCreation.ts`, `TournamentEngine`, `StyleCatalogueService`, `GameLibraryService.{set,get}RoomGameStyle`, and the StylePicker FE.
- **Ratings re-keying** — `game_ratings` is keyed on `(game_name, user_id)`. Should re-key on `(global_game_id, user_id)` for consistency post-step-2. Plan §2h.
- **ScoreSyncPoller adaptive backoff** — v2.7.0 added per-account error suppression so logs aren't spammed during iScored outages, but the poller still hits iScored every 5s during an outage. Add a "bump interval to 60s after 5 consecutive failures, restore on first success" mode to cut wasted requests by ~12x during sustained outages.
- **Force-recreate fetch agent on N consecutive ScoreSyncPoller failures** — the 14-min outage on 2026-04-27 was cleared by a container restart, suggesting an undici keep-alive connection got stuck. Adding a one-line agent reset on Nth consecutive failure could self-heal without restart.
- **Studio attribution from AtGames sheet** — column A fill color (Green=AtGames, Red=FarSight, Yellow=Magic Pixel, Blue=Zen Studios) tells which studio ported each game to AtGames. Skipped in v2.7.0 per user direction; revisit if a "filter by porter studio" use case emerges. HTML export path is feasible (~50 lines, no new deps).
- **Tunable iScored API timeout** — currently hardcoded 15s in `IScoredApiClient.getAllScores`. Promote to a Global Settings field if 15s turns out too aggressive.
- **Notification coalescing** — batch 3+ same-type Discord push notifications within 5 minutes into a summary DM. Deferred from Lobby & Social Phase 5 polish.
- **`/unmap-user` Discord admin command** — companion to the now-additive `/map-user` (v2.8.0). Removes a single iScored alias from a Discord user without touching their other aliases. Today the only way to remove an alias is direct DB edit. Small command, ~30 lines.
- **One-shot DM at merge** — when a room admin merges an anonymous nickname into a Discord user, DM the user: "An admin in {room} has linked the iScored name '{nick}' to your account. Future scores under this name will count for you. Set your display name at /account/settings." Opt-out via `/arcaid-notifications`. Deferred from v2.8.0 — single helper call from `MergeService.recordMerge` post-commit.
- **Pure-iScored-name claim flow** — the `/admin/identity` merge UI requires an `anonymous_identities` row, so a name that's only ever submitted directly on iScored (never seen by ArcAid) cannot be claimed via the merge tool. Add an admin form: "Claim an iScored name for a Discord user" — pre-checks `user_mappings` collisions, INSERTs the alias row, kicks off a `fetchAvatarHash` for the target, no merge transaction needed.
- **Admin display-name override** — super-admin-only ability to set/clear another user's `user_profiles.display_name` (e.g. for moderation). Audit-logged via existing `auditMiddleware`.
- **Drop `user_mappings.avatar_hash` column** — kept for one release after the v2.8.0 split (avatar moved to `user_profiles.avatar_hash`). Verify no readers, then drop in a future migration.
- **`MergeService` mapping race-condition pre-check** — the `MAPPING_CONFLICT` check inside `recordMerge` runs outside the transaction so the admin gets a clean error. A different admin merging the same name into a different user between the check and the INSERT could still hit the UNIQUE constraint; the txn rollback is correct but the error message would be cryptic. Tighten by re-checking inside the txn (small UPSERT pattern adjustment).
- **In-app version display** — ✅ **DELIVERED in S10 (v2.15.0):** `GET /api/version` → `{ version, commit, builtAt }` (version from root `package.json` via `npm_package_version`; git SHA + build timestamp baked as Docker build-args `GIT_SHA`/`BUILT_AT` in `deploy.yml` → `APP_GIT_SHA`/`APP_BUILT_AT` env in `Dockerfile`), surfaced on the Help footer + the Dashboard health card, and folded into `/api/status`. Original ask, kept for context: surface the running app version (ideally + the deployed git SHA) in the admin UI so support can answer "what version are you on?" and a deploy can be visually confirmed. Display home: the existing `admin-ui/src/pages/Help.tsx` (user's suggestion); an admin-layout footer is an alternative. Source of truth = **root `package.json` version** (internal dev line, e.g. v2.13.16 today → becomes v0.90.0 Beta at the public-version reset; keep the displayed string aligned with the public line — see the versioning plan). Two build approaches: (a) Vite `define` / `import.meta.env` to bake `package.json` version into the FE bundle at build time (simplest, FE-only — but shows the *bundle's* version, not necessarily the backend's); (b) a `GET /api/version` → `{ version, commit, builtAt }` endpoint the FE fetches (single source of truth, reflects the actually-running backend, and doubles as a health field — natural to fold into S10's `/admin/health`). For the git SHA, pass it as a Docker build-arg / env in `deploy.yml` and read it server-side. **Do NOT conflate with the SW `CACHE_NAME`** (`arcaid-v75`) — that's a separate cache-bust counter, not the app version. Tiny (~1-2h); pairs with S10.
- **Decouple Playwright browser version from the base image** — the prod Dockerfile has no `npx playwright install`, so npm `playwright` is hard-coupled to the `mcr.microsoft.com/playwright:v<X>-jammy` base tag and every bump needs a manual same-PR Dockerfile edit (see the CLAUDE.md gotcha). Add `RUN npx playwright install --with-deps chromium` to the prod stage so the installed package version drives the browser download and the base tag only supplies system libs. Trades a slightly larger/slower image build for removing the silent-breakage coupling. Surfaced by the 2026-07-05 safe-wave playwright 1.58.2→1.61.1 bump (which required a coordinating base-image bump to `v1.61.1-jammy`).
- **Enforce lint in CI + clear the admin-ui lint backlog** — the CI `test` gate runs `tsc -b && vite build && vitest` but NOT `eslint`, so `admin-ui` `npm run lint` has drifted red: **~197 pre-existing errors** (`@typescript-eslint/no-explicit-any`, `no-empty`, `react-hooks/set-state-in-effect`, `exhaustive-deps`) surfaced during the 2026-07-05 eslint 9→10 bump (eslint 10 itself is fine — the errors predate it and fire identically under eslint 9). Two parts: (a) add an `eslint .` step to the `test` job so lint regressions block merge; (b) burn down the backlog — mostly real typing work to kill the `any`s, plus a genuine `setState`-synchronously-in-effect in `Tournaments.tsx:337`. Do (b) **before** (a) or the gate immediately goes red. Sizable — schedule as its own cleanup pass, not a drive-by.
- **sqlite3 5→6 upgrade — blocked on prod base-OS glibc** (Dependabot #7, pre-validated 2026-07-05, left open/unmerged). sqlite3 6.0.1's linux-x64 glibc prebuild requires **`GLIBC_2.38` / `GLIBCXX_3.4.31`**; the production image (`mcr.microsoft.com/playwright:v1.61.1-jammy`) is glibc **2.35**, so the prebuild installs but fails to `dlopen` at runtime → app crash on DB init at boot. (musl/alpine backend-build stage is fine — that prebuild loads.) No CI gate catches it (gate runs on ubuntu-latest). Two enable paths: **(a)** bump the prod base to `v1.61.1-noble` (Ubuntu 24.04, glibc 2.39 — verified available) *in the same PR* as the sqlite3 bump — a whole-OS migration that needs its own validation (Playwright browsers, system libs, app runtime all on noble), arguably worth doing on its own merits since jammy is aging and Playwright now defaults to noble; **(b)** force sqlite3 to compile from source in the prod stage (`apt-get install -y python3 make g++` + `npm rebuild sqlite3 --build-from-source`), keeping jammy but adding ~200MB + build time. Until then, **stay on sqlite3 5** (works, jammy-compatible prebuild) — not urgent. **UPDATE 2026-07-05 — path (a) was ATTEMPTED (PR #45: noble + Node 24 + sqlite3 6) and REVERTED.** It passed exhaustive pre-merge container validation (sqlite3 6 + Node 24 on the real noble base; full multi-stage build; **full app boot** with `/api/status` ok + all migrations run) — but **crashed on prod boot (502 ~4 min)**, because that boot test used a **FRESH EMPTY DB** and never exercised the prod-only boot path: decrypting real `SECRETS_KEY`-encrypted Discord/iScored settings (runs *before* the API starts), the real populated DB, and the bind-mounted `/app/data` volume + `arcaid` UID (noble may assign a different UID than jammy). Rolled back via `git revert -m 1` (`0355509ca`); prod stable on jammy/sqlite3-5. **The re-attempt MUST boot-test the noble image against a COPY of the prod DB — with real encrypted settings, `SECRETS_KEY`, and the volume/UID setup — before any deploy; a fresh-DB boot is insufficient.** Root-cause diagnosis pending the crashed container's `docker logs arcaid`. Leading suspects: encrypted-settings decrypt on Node 24, or mounted-volume UID perms. **RESOLVED + SHIPPED 2026-07-05 (PR #46): it was the UID perms.** noble's `useradd` gives `arcaid` uid 997, but prod's `/app/data` + `arcaid.db` are owned by jammy's `arcaid` = uid 999, and the CMD's `/app/data` chown is non-recursive → 997 can't write the 999-owned DB → `SQLITE_READONLY` at bootstrap. Reproduced against a copy of the prod DB (uid 997 → crash; uid 999 → clean boot), fixed by pinning `arcaid` to uid 999 (`useradd -u 999`), and shipped in #46 — **prod now runs noble / Node 24 / sqlite3 6**. This item is DONE; kept here as the record of the incident + the "validate a base-image/UID change against a COPY of the prod DB, not a fresh one" lesson (now also a CLAUDE.md gotcha).

- **Catalogue "report a problem" with game info** — user-facing feedback mechanism to dispute/correct displayed game metadata (name / manufacturer / year / platforms / artwork). Flow: a "Report a problem" affordance on Game Detail (room + global) → user submits the field + suggested correction + note → lands in an **admin review queue** → admin either (a) **updates the catalogue entry directly**, or (b) responds **"this field is sourced from IPDB/OPDB/VPS — please report it upstream at `<link>`"** (externally-sourced fields we shouldn't unilaterally diverge on). Needs: a `game_feedback` table (`global_game_id`, reporter, field, current_value, suggested_value, note, status, resolution), an admin queue UI, and a per-field **source indicator** so both sides know whether it's ours to fix or upstream. Ties directly into the dedup work below — many reports will be "these are two different games" / "wrong year/manufacturer".
- **Catalogue dedup hardening — ✅ SHIPPED v2.21.0 (PR #67, 2026-07-13; see ADR 0014).** Guard on the IPDB dedup step (`isVirtualOnlyManufacturer` — refuses shared-IPDB identity matches when either side is Zen Studios/Original/missing), `based_on_ipdb_url` reference column (migration 109) with `upsert`-chokepoint routing (also closes the COALESCE re-plant hole — VPS re-syncs restoring links stripped 2026-07-04), and the super-admin **Dedup Audit** tool on `/admin/catalogue` (suspects + shared-IPDB groups, in-app Strip/Strip All). **⚠️ PENDING (user): run the Dedup Audit on prod** — it reports whether re-syncs re-planted stripped links; Strip All remediates in-app. Per-field source STORAGE deferred to report-a-problem (policy documented in ADR 0014). Original item kept below for the audit query + provenance:
  - *(original)* core insight: **manufacturer is the dedup discriminator.** Same *real* manufacturer + shared IPDB = the same machine (merge; real/vpx/fx are just platforms of one catalogue entry). A *virtual-only* manufacturer (`Zen Studios`), a generic `Original`/`JP's` fan table, or a tribute = a **different game** that only shares a theme/era — its IPDB link is spurious → keep separate. Fixes: (a) **manufacturer-compatibility guard** on the IPDB-cross-reference step in `GlobalGameService.upsert` — refuse a shared-IPDB match when one side's manufacturer is virtual-only (curated set), mirroring the existing cross-type guard; (b) **importer fix** — VPS/FX imports must not copy a realpin's IPDB onto a virtual-only-manufacturer row (its "based on" belongs in a reference field, not the identity IPDB); (c) **audit the 67 groups auto-merged in v2.13.0** for any virtual-original merged INTO a realpin (already-corrupted, needs un-merge). Find the full spurious population: `SELECT id,name,manufacturer,year,ipdb_url FROM global_games WHERE ipdb_url IS NOT NULL AND (manufacturer IN ('Zen Studios','Original') OR manufacturer IS NULL)`. **Source-precedence policy (conflicting fields):** real-machine manufacturer/year → **IPDB > VPS > OPDB** (IPDB is the curated historical authority; VPS tracks it; OPDB drifts more on year/mfr though it's our ID/breadth backbone); external IDs → OPDB; virtual/digital tables → VPS. Store the source per field so "report a problem" can tell a reporter "this year is from IPDB — dispute it there" vs. "this is ours to fix."

---

## Architecture Decisions

Load-bearing technical and product decisions are tracked in [`docs/decisions/`](docs/decisions/README.md). Each ADR captures the context, the choice, and the alternatives considered. Write a new ADR when a decision locks in a data shape, auth pattern, or external integration that future code will assume.

---

## Deferred

- **Discord Bot Multi-Room (Phase 5)** — single bot serving multiple guilds with per-room command scoping. Resolve `interaction.guildId` → game room in all commands; filter queries by room in all command handlers; deploy commands to all guilds with game rooms. Not blocking — current setup serves one room per Discord guild adequately.

---

## Future

### Score comments + comment voting/flagging (idea captured 2026-07-11)

Comment on a specific person's score from the room score surfaces, with optional Discord cross-post, upvotes, and a report/flag → mod-review loop. Natural companion to S22 moderation (which already owes the comment-moderation FE wiring S11 deferred) or Phase C social. Rough sizing: ~2–2.5 days total.

**A. Per-score comments (anchor, don't fragment)**

- **Do NOT add a third comment store.** `game_comments` + `global_game_comments` are already flagged as fragmented (see "Comments & Tips — bidirectional view" below). Instead add an optional **score anchor** to `game_comments`: a `score_history_id` column plus denormalized context (`iscored_username`, `score`) so a score comment is just a game comment pointing at a score row.
- **Anchor durability:** scores are deletable (per-row delete, admin wipe, S12 account-delete anonymize). The denormalized context lets a comment survive its score's deletion and render "on a removed score" instead of dangling — ADR 0005 unlink-don't-cascade philosophy. Bonus: S12's account-deletion purge already covers `game_comments`, so the privacy floor needs no reopening.
- **Who can comment: Discord-authed only** (this is the ROADMAP's planned direction for comments anyway — §B below; cross-post needs a real identity; and commenting on a *person's score* is a harassment vector in a way game tips aren't). Guests read-only + "log in to comment" CTA. Reuse the S11 delete-authz tiers (author / room_admin-in-room / super_admin), rate limiters, and auto-audit verbatim.
- **Routing nuance:** "is this a tournament score" is a property of the score EVENT (`score_history.submitted_during_tournament_id`), not the game — the new Room Scores tab shows all-time rows with no tournament of their own. Route by the score's tournament.
- **UX home:** the per-player history expand rows in `GameDetail.tsx` (already exist — lowest-friction surface) + the card quick-view. Historical view = the existing comment list, filterable to a score/player.

**B. Discord cross-post (opt-in per comment)**

- **The channel cascade already exists:** `resolveAnnouncementChannelId(gameRoomId, tournamentChannelId)` in `src/utils/discord.ts` — tournament `discord_channel_id` → per-room `DISCORD_ANNOUNCEMENT_CHANNEL_ID` → env fallback → `null`. The feature calls it; on `null` show "No linked Discord channel — ask your room admin to set one."
- **Explicit opt-in checkbox per comment, default OFF** — posting to Discord publishes to the whole guild; never by surprise.
- Gate on the room's `DISCORD_ENABLED` + bot-in-guild (S10 `getDiscordClient()` health accessor) + a per-room admin toggle (e.g. `SCORE_COMMENT_DISCORD_ENABLED`) so admins can kill the firehose without disabling comments.
- Embed: commenter display name/avatar, the comment, score + game context, deep link to `/:slug/games/:name`.
- Optional adjacency: "someone commented on your score" DM to the score owner — a sixth `NotificationService` type, default-off, managed via `/arcaid-notifications`.

**C. Upvotes on tips/comments + Top sort**

- New `comment_votes (comment_id, voter_discord_id, created_at, UNIQUE(comment_id, voter_discord_id))` — one vote per Discord user, toggle to un-vote. **Discord-authed only** — deliberately NOT keyed on the spoofable `x-user-id` (that keying is exactly the ballot-stuffing weakness already logged against `RatingService` in Open Followups).
- Applies to BOTH score-anchored comments and existing game tips (same table — another payoff of not fragmenting stores).
- Sort control on comment lists: **Top** (vote count desc, tie-break newest) | **Newest**. Default Top for game tips (surfaces the best pro tip), Newest for a score's thread. Vote counts ship in the list response (single LEFT JOIN + GROUP BY, no N+1); FE shows count + the viewer's own-vote state.

**D. Report/flag → mod review**

- New `comment_reports` mirroring the existing `score_reports` shape exactly (`id, comment_id, reporter_discord_id, reason, created_at, resolved_at, resolved_by, resolution`) + UNIQUE(comment_id, reporter_discord_id) so one user can't spam-report one comment. Reporting = Discord-authed; one tap + optional reason.
- **Mod queue** on the room admin side (natural sibling of the planned "report a problem" game-info queue — consider one shared "Reports" admin page with type tabs): list open reports with comment + context, actions = **dismiss** (resolve, comment stays) / **remove** (delete via the existing S11-tier delete path, auto-audited). Super-admin sees cross-room.
- Optional threshold: auto-HIDE (not delete) a comment at N open reports pending review — ship OFF by default; manual review is the floor.
- Report volume is admin-visible; consider folding an "open reports" count into the S10 admin health card later.

**Open questions to settle at build time:** (1) do existing anon-authored tips get grandfathered read-only (recommended — matches §B below)? (2) does the Top sort need time-decay (recommend no — keep it simple, tips are evergreen)? (3) auto-hide threshold value if enabled (suggest 3).

### Player Self-Service + Moderation

Three related features that together tighten up score/comment integrity and give admins a proper moderation surface. All gated behind Discord-authenticated identity — anonymous users don't get self-service edit/delete (they have no durable identity to verify), don't get to leave comments/tips, and don't need to be "banned" because the claim system auto-suffixes them anyway.

**A. Self-edit / self-delete scores**

Logged-in players can correct or remove their own submissions across every surface where their score appears.

- [ ] **Delete own score** — button/icon on each score row where `submitted_by_user_id === viewer's Discord ID`. Applies to `submissions`, `community_scores`, `score_history`, AND the fanned-out `global_scores` row for the same event. Soft-delete (set `deleted_at` / `orphaned_at`) rather than hard-delete so audit trail survives.
- [ ] **Edit own score value** — modal with new score input + photo upload. Gated on ownership. Writes a new `score_history` row for the revision, updates the canonical `submissions` / `community_scores` row to the new value, re-fans to `global_scores` (delete old global row + insert new). Photo required if the game's room requires photos on new submits.
- [ ] **Scope consistency** — deleting/editing a room score automatically mirrors to the global row (via `submitted_from_room_id` + `submitted_during_tournament_id` linkage). Deleting a pure global submission only affects `global_scores`.
- [ ] **Self-actions logged to `audit_log`** with actor, target row id, old/new values. Room admin + super-admin can see via the activity log.
- [ ] **Rate limit** — e.g., 10 self-edits per user per hour to prevent leaderboard thrashing.
- [ ] **UX** — edit/delete controls on: Tournament card rows (expanded view), Game Detail leaderboard rows, Community tab rows, Global Scoreboard rows, Global Game Detail rows. Hidden for non-owners.

Open design question: **should edit be allowed to raise a score or only lower it?** Raising is abusable without photo-proof verification. Safe default: edits require a new photo if photos are required for submission in that room; otherwise any value is allowed but all edits are logged.

**B. Comments/tips require Discord login**

Currently `POST /:roomId/comments/:gameName` and the global `/global/games/:id/comments` both accept anonymous posts. Change the gate.

- [ ] **Server** — add `requireDiscordUser` middleware to comment POST endpoints (room + global). Reject 401 without a valid player token. Existing anon comments stay visible but read-only.
- [ ] **Client** — comment compose UI hides or replaces with "Log in to leave a tip" CTA when viewer isn't Discord-authenticated. Same for rating.
- [ ] **Self-edit / self-delete comments** — same ownership rule as scores. Logged-in users see edit + delete controls on their own comments on Room Game Detail and Global Game Detail. Soft-delete (set `deleted_at`), audit-logged.
- [ ] **Legacy anon comments** — kept as-is, visible but no owner controls. Admin can still delete them from the mod surface.

**C. Admin ban — logged-in users**

`user_bans` table already exists (used by `GlobalScoreService.isBanned` to short-circuit global submissions). Build out the full moderation workflow around it.

- [ ] **Admin ban UI** — new page (or section in existing admin activity log): `/admin/bans` (super-admin, global) and `/:slug/admin/bans` (room-admin, room-scoped). List current bans, add a ban (Discord user ID + reason + optional expiry), lift a ban.
- [ ] **Ban scope** — two tiers: (1) **room ban** — user can't submit/comment in that room, existing content orphaned; (2) **global ban** — user can't submit anywhere, all their content hidden from Global Scoreboard. Super-admins can set either; room admins can only set room-level.
- [ ] **Enforcement points** — extend the existing `isBanned()` check from global submissions only to room submissions, comment POSTs, rating POSTs, friend POSTs. Consistent 403 response with ban reason (if admin chose to surface it).
- [ ] **Ban → content cascade** — decide per ban whether the user's existing scores + comments are: (a) hidden from public views (soft), (b) deleted (hard), or (c) left visible. Default to (a) soft-hide for reversibility. `orphaned_at` column already exists on `submissions` / `community_scores` / `score_history` for this pattern.
- [ ] **Ban → Discord notification** — optional DM to the banned user with reason, scope, and expiry. Opt-out respected if they've turned off Discord notifications, but bans should probably override that since it's a moderation action.
- [ ] **Audit** — every ban / unban logged to `audit_log` with actor, target, reason, scope.

**Shared plumbing across A/B/C:**
- Need a new `/api/me/scores` endpoint returning the viewer's own recent submissions across all score tables (paginated) so the UI can show a "My scores" management view.
- Need a new `/api/me/comments` endpoint, same pattern.
- Ownership check helper: `requireOwnsScore(scoreId)` / `requireOwnsComment(commentId)` middleware that reads the row's `submitted_by_user_id` / `user_id` and compares to `req.user.discordId`. Super-admins bypass.

**Rough sizing:** A is ~2 days (lots of surface area — scores live in 4 tables and 6+ UI components). B is ~0.5 days (middleware flip + compose-UI gate). C is ~1-1.5 days depending on whether the ban→cascade hide logic is implemented or deferred. All three should probably ship behind a `FEATURE_PLAYER_SELF_SERVICE=true` settings flag initially so it can be rolled back without data loss.

### Score Photo Persistence

Score proof photos are stored locally on disk (`data/score-photos/`). As the Global Scoreboard becomes the primary submission path (no iScored dependency), reliable photo storage is critical. Many rooms will not use iScored integration at all.

Current gaps:
- Direct global submissions store photos locally — works, but no redundancy or CDN
- Legacy iScored-synced scores reference external CDN URLs that may expire
- Room-originated photos referenced by global scores may 404 if the file wasn't persisted during fan-out
- No backup/replication strategy for photo files (DB is backed up, photos are not)

Options to evaluate:
- [ ] S3/object storage for all score photos (persistent, CDN-backed, scales independently)
- [ ] Serve missing photos gracefully (placeholder image instead of 404)
- [ ] Include `data/score-photos/` in backup volume (quick win)
- [ ] Download and persist iScored CDN photos during sync (for rooms still using iScored)
- [ ] Copy room photos to global photo dir during fan-out

### Phantom anon-claim cleanup — manual runbook (not automation)

First-claim-wins is the policy: whoever uses a name first in a room owns it. **We don't automate "Discord trumps anon" name transfers** — that's the fraud surface we explicitly rejected when the design was agreed. If a Discord user and a legit-different-human anon share a display name, the anon (who got there first) keeps it, the Discord user gets `Name_2`.

The one exception is a phantom claim — an anon row that *is actually the same human* as the Discord user who later tries to claim the name, typically from the pre-v2.2.5 window when `conditionalRequireDiscordUser` was dropping Bearer tokens in guest-allowed rooms. Those should be cleaned up case-by-case, never automated.

**Procedure:**

1. Verify the claim is a phantom. Needs at least two of:
   - The anon claim's `claimed_at` falls inside a known middleware-bug window (pre-v2.2.5 deploy, or after any future auth-middleware regression).
   - The user confirms it was their browser session.
   - The `anon_token` matches a localStorage UUID the user can produce.
2. Identify the row precisely:
   ```sql
   SELECT anon_token, room_id, display_name, claimed_at
     FROM anon_room_claims
    WHERE LOWER(display_name) = LOWER('<name>')
      AND room_id = '<room-uuid>';
   ```
3. Delete narrow, keyed on `anon_token` + `room_id` + `display_name`:
   ```sql
   DELETE FROM anon_room_claims
    WHERE anon_token = '<token>'
      AND room_id = '<room-uuid>'
      AND LOWER(display_name) = LOWER('<name>');
   ```
4. Log the deletion in `audit_log` with a reason so there's a trail (or document in ops notes if the table doesn't accept ad-hoc reasons).

**Do not:**
- Run the broad `DELETE ... WHERE name IN (SELECT iscored_username FROM user_mappings)` form. It can't distinguish phantom from legit and violates first-claim-wins.
- Surface a self-serve "claim this name" button in the UI — same fraud surface.
- Build a background job that auto-cleans phantoms. Needs a human to verify the claim is actually the same user.

The existing admin merge tool at `/:slug/admin/identity` is the right place for real cross-identity reconciliation when it turns out two claims should collapse into one.

### Game Library filters — Platform / Manufacturer / Type / etc.

> **Status (v2.7.0):** smart-search bar shipped covers many of the cases this section originally addressed (substring match across name/manufacturer/year/designers/themes/table_authors/aliases/platforms/room_tags + inline year-range syntax `2001-2020`). The dedicated multi-select filter panel below was deferred when the manufacturer chip-row was reverted in favor of search-first UX. Items below remain on the table if a structured filter-panel UI is later wanted.

The game library and global catalogue are already searchable by name across four surfaces: room admin (`/:slug/admin/library`), global catalogue (`/catalogue`), freeplay picker (`/:slug/freeplay`), and super-admin master library. Add a filter panel so users can narrow by metadata fields without typing.

- [ ] **Filter fields (MVP):**
  - **Platform** — the canonical platform IDs from `src/utils/platformMapping.ts` (VPX, VPXS, VPX-VR, IRL, AtGames, Scorbit, etc.). Multi-select. Already stored as JSON array on `game_library.platforms` / `global_games.platforms`.
  - **Manufacturer** — Stern, Bally, Williams, Gottlieb, Data East, Sega, etc. Stored on `global_games.manufacturer`; usually missing on pure room entries (falls back to catalogue lookup via `global_game_id`).
  - **Type** — Real pinball (EM / SS / modern), Virtual pinball, Video game, Arcade cabinet. Derivable from platform + year + catalogue category; may need a dedicated column if the derivation gets ambiguous.
  - **Year** — range slider or decade dropdown.
  - **Theme / Tags** — adventure, sci-fi, supernatural, licensed (IP tags from VPS/OPDB imports). Multi-select.
  - **Player count** — 1P / 2P / 4P (already surfaced on Global Game Detail).
- [ ] **Filter UI:** collapsible sidebar on desktop, bottom-sheet on mobile. Filter chips above the grid show active filters with `×` to remove. Clears-all link when any filter is active.
- [ ] **URL state** — filters serialize to query params (`?platform=vpx,vpxs&manufacturer=stern&year=1990-2000`) so shares and deep-links work.
- [ ] **Combined with search** — existing name-search input stays; filters narrow the result set server-side, search is applied on top.
- [ ] **API surface** — extend the existing list endpoints (`GET /:roomId/game_library`, `GET /global/catalogue`, `GET /admin/master-library`) to accept the filter params. Single query with `WHERE` clauses + JSON array intersection for `platforms`.
- [ ] **Performance** — all filter columns need indexes on `global_games` (platforms is JSON so an index helps but doesn't fully accelerate). Consider a materialized `global_games_facets` view or extracting filter keys into indexed columns if the catalogue grows past ~10k entries.
- [ ] **Filter facet counts** — next to each filter option show the number of matching games (e.g. "Stern (47)", "Bally (23)"). Requires a separate aggregation query. Can ship without initially; add once the UI is validated.

Open questions:
- **Type derivation**: is "Real pinball" vs "Virtual pinball" vs "Video game" stored anywhere already, or do we need a new column? If new, seed from a platform→type mapping table.
- **Room-local vs global**: should room-admin library filters be restricted to what the room has (reflecting its curated list) or show the full global catalogue with availability indicators? MVP: restricted to room's actual library; add "browse global" as a secondary pivot later.

Rough sizing: 1-2 days depending on whether Type needs a new column + migration. Facet counts add another half-day.

### Comments & Tips — bidirectional view (Option 2)

Comments/tips and ratings currently live in two parallel stores: `game_comments`/`game_ratings` (room-scoped, keyed on `(room_id, game_name)`, anon allowed) and `global_game_comments`/`global_game_ratings` (keyed on `global_game_id`, Discord required). A tip written on the Room Game Detail never reaches the Global Game Detail for the same game, and vice versa.

Ship a union-view model that keeps both stores but surfaces cross-room content where appropriate:

- [ ] Comment compose UI gains a "Share globally" checkbox. Defaults on for Discord-authed users (writes to both tables); anon comments stay room-only.
- [ ] Room Game Detail renders local + global comments together, tagged by origin (e.g., small "Globally" badge on shared comments, room logo on room-only). Add a `?scope=room|global|both` filter or tab.
- [ ] Global Game Detail adds a "From rooms" section or similar so room-shared tips are discoverable cross-community.
- [ ] **Ratings:** probably fully unify for any game with a `global_game_id` — a star is a star. Room-only games (no global mapping) keep their ratings local.
- [ ] Migration / backfill decision: do we one-shot promote existing room comments with Discord-authored authors into `global_game_comments`, or leave history as-is?

Rough scope: half a day of focused work. Needs a design pass on the compose UX (where exactly the checkbox lives, default state per auth state, how to handle room games without a global mapping).

### iScored Sync Hardening

Cooldown enforcement gaps identified in v2.2.0 review. Evaluate and address in a future sprint.

- [ ] **Cooldown bypass via `/sync-state`** — when an admin manually creates a game on iScored tagged `DG` / `WG-VPXS` / `WG-VR` / `MG`, the next `/sync-state` creates a local `games` row set to ACTIVE with no `GAME_ELIGIBILITY_DAYS` / `last_played` check (`src/discord/commands/syncstate.ts:45-65`). The game goes live in ArcAid even if `game_library` says it's still in cooldown. Cooldown is only enforced by `runMaintenance()`, `autoPickAndActivate()`, and the web `/pick-game` path — not by sync. Decide: (a) treat sync as admin-override and document, (b) refuse to create the local row when cooldown applies, or (c) create it as LOCKED so it's recorded but doesn't surface on scoreboards. Option (c) preserves iScored-is-source-of-truth while respecting cooldown.
- [ ] **Duplicate active games when sync runs with an active DG game present** — related to above. Sync doesn't check `max_active_games` before marking a discovered game ACTIVE, so two DG games can be ACTIVE simultaneously until the next maintenance run rotates one out.

### Ops / Infrastructure

- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
- [ ] Super-admin dashboard server metrics (CPU, memory, I/O, container stats)
- [ ] High availability / multi-container — see notes below

#### High Availability Notes

Current constraints: SQLite (single-writer), singleton engine classes (in-memory state), Playwright persistent sessions (local disk).

| Approach | Effort | Notes |
|----------|--------|-------|
| Active-passive failover | Low | 2 containers, 1 active. Docker restart policy + health checks. Shared volume for SQLite. |
| Read replicas (Litestream) | Medium | SQLite WAL mode + Litestream replication. One writer, N readers. Public scoreboard benefits most. |
| Separate concerns | Medium | Stateless API container (scales horizontally) + singleton engine/scheduler container. Requires DB change. |
| Migrate to PostgreSQL | High | True multi-container with connection pooling. Rewrite all raw SQL + migrations. Biggest payoff, largest effort. |

**Quick wins:** Docker `restart: always` + health check, Litestream for continuous S3 backups, reverse proxy (nginx/Caddy) for SSL/rate limiting, CDN for static assets. **Recommendation:** Start with active-passive + Litestream, migrate to PostgreSQL when scale demands it.

### Platform Integrations

- [ ] IFPA (International Flipper Pinball Association) — submit tournament results to official world rankings via API
- [ ] Matchplay.events — interoperability with the most-used competitive pinball tournament platform
- [ ] Scorbit — automated score capture from connected physical pinball machines (eliminates manual submission for IRL)
- [ ] Stern Insider Connected — pull scores from Stern connected machines
- [ ] Guilded / Revolt — alternative community platform support beyond Discord
