# Arcaid — Launch Tracking List

> **Purpose:** the single prioritized view of everything left before (and right after) public launch.
> This is an INDEX — details live in ROADMAP.md (referenced by entry name) and SPRINT_STATUS.md.
> Created 2026-08-08 from a full sweep of ROADMAP.md, SPRINT_STATUS.md, and the repo-root working docs.
> Check items off here; keep ROADMAP as the deep backlog.

---

## Tier 0 — Launch gate

### A. Owner actions — no code, clicks + config (~half a day total)

- [x] **Configure + field-test the Global Arcaid Discord server** — ✅ DONE 2026-08-08. New "Arcaid" server created (community-enabled: announcements + support forum + showcase + general), bot invited with Create Invite, `GLOBAL_DISCORD_GUILD_ID` + permanent `GLOBAL_DISCORD_INVITE_URL` set via Global Settings. Field test passed: amber → one-click connect → green "Enabled (Arcaid community server)". Demo server retained as dev/staging. (shipped inert v2.72.0). Steps in ROADMAP "Global Arcaid Discord server": convert the test server, set `GLOBAL_DISCORD_GUILD_ID` (+ optional invite URL) in Global Settings, grant the bot Create Invite, test the connect flow from a Discord-less room.
- [x] **Run the Dedup Audit on prod** — ✅ DONE 2026-08-08. 0 suspects (the v2.21 guard held — re-syncs did NOT re-plant stripped links). 12 shared-IPDB groups had accumulated from VPS re-syncs since 2026-07-13; remediated to 0/0: 9 merged via the real `merge-ipdb-duplicates` endpoint (7 JP's recreations + Big Indian/Big Injun + Strip Joker Poker→Joker Poker (SS), owner-adjudicated), Mario Andretti's wrong link fixed (VPS shipped Waterworld's 3793; corrected to 3794 — the mfr+year-only merge guard would have wrongly fused two different Gottlieb 1995 games), Radical! (prototype) + Firepower vs. A.I. kept separate (links moved to `based_on_ipdb_url`, owner-adjudicated). DB backed up first to `/app/backups/pre-dedup-remediation-2026-08-08.db`.
- [x] **Hand-delete the two pre-v2.10 iScored orphans** — ✅ RESOLVED 2026-08-09: owner checked the iScored Lineup — Paranormal (95735) and Attack from Mars (95586) are no longer there (cleaned up at some point since the item was logged). Nothing to delete.
- [ ] **Backup restore drill** — actually restore a backup once, off-hours, before real users depend on the data. (From TEST_KNOWN_ROUGH_EDGES.md — the first restore should not be during an incident.)
- [x] **Prod server ops** — ✅ DONE 2026-08-09. `init: true` verified already live (0 zombies). Ubuntu fully updated by owner: killed the 36-day-stuck apt-daily job (wedged since Jul 3 — auto-updates had been silently dead), unattended-upgrades caught up 49 security pkgs (glibc/openssl/openssh/kernel), then manual upgrade landed docker-ce 29.7.2 + kernel 6.8.0-137, rebooted. Site back in ~20s, containers auto-started healthy, 0 pkgs pending, apt-daily + unattended-upgrades timers active again.
- [x] **Eyeball v2.85 on prod** — ✅ DONE 2026-08-09: owner reviewed prod (by then covering v2.85→v2.88 incl. the header compression + nav escape): "Prod looks great."
- [ ] **Pre-launch data wipe — DECIDED YES (owner, 2026-08-09); scope + execute near GA.** Owner confirmed a wipe happens before GA. Still to scope (owner input needed): whether `rtx_pinball`'s real league history (players, scores, tournaments) survives or everything resets to zero. Execution plan when scheduled: full DB + assets backup first (BackupManager + manual copy off-box), then a deliberate, scripted pass — never ad-hoc deletes. Should run as the LAST pre-GA step, right before the v1.0.0 version bump.
- [ ] **Decide: RetroAchievements config** (shipped inert v2.68.0). Configure `RA_USERNAME`/`RA_API_KEY` + one master-list sync if console games are part of the launch story; otherwise leave inert (it degrades gracefully).

### B. Launch-gating code (~3–4 focused days total)

- [ ] **Public version reset** — root `package.json` v2.85.x → **v0.90.0 Beta**, → v1.0.0 at GA (versioning plan). Surfaces via `/api/version`, Help footer, Dashboard health card. Small but it IS the launch version.
- [x] **Comments/ratings login-gating** — ✅ SHIPPED v2.86.0 (PR #176, 2026-08-08). Room comment POST + rating POST now `requireDiscordUser` + `requireNotBanned`; rating votes key on discordId (ballot-stuffing closed); legacy anon comments stay visible with author delete rights intact. FE: login CTAs on the room game page (comment form + read-only stars).
- [x] **Admin comment moderation that works from the UI** — ✅ SHIPPED v2.86.0 (PR #176). Public game page shows delete on all comments/tips for super/room admins; new `optionalUser` middleware lets password/local-admin tokens hit the DELETE authz tiers; global comment DELETE gained super_admin tier + game-scope check. (Note: the item's "FE sends no token" premise was stale — GameDetail already sent the player token; the gap was the author-only FE button + the middleware dropping non-Discord tokens.)
- [x] **`RatingService` room-scoping** — ✅ SHIPPED v2.86.0 (PR #176). Migration 139 rebuilds `game_ratings` with `game_room_id` (backfilled onto the default room, which is where the legacy alias wrote everything); service fully room-parameterized; room page star widget no longer routes through the default-room alias.
- [x] **Photo backup quick win** — ✅ ALREADY SHIPPED (stale item): `BackupManager.ASSET_SUBDIRS` mirrors `score-photos` + `styles` + `catalogue-images` + `iscored-styles` into `backups/assets-mirror/`. Verified on prod 2026-08-08: 81MB score-photos mirror, current daily backups present.
- [x] **Room-admin nav escape** — ✅ SHIPPED v2.87.0 (PR #177, 2026-08-08). `BrandWordmark` links to `/` by default (`noLink` opt-out on LandingPage); SuperAdminLayout wordmarks wrapped; RoomAdminLayout gained "View Public Room" nav item.
- [x] **`videogame` tournament-mode normalization** — ✅ SHIPPED v2.87.0 (PR #177). `src/utils/tournamentMode.ts` bridges 'videogame' ↔ 'video_game'/'arcade' at FIVE sites (the 4 known + `TournamentEngine.autoPickAndActivate`, found in the sweep); pinning tests added; fixed the availability test that had been masking the bug by seeding a literal 'video_game' mode.
- [x] **Brand casing sweep** — ✅ VERIFIED ALREADY DONE (stale item, 2026-08-08): case-sensitive grep across admin-ui/src, manifest.json, index.html, src/discord/, ogMeta.ts found zero user-visible "ArcAid" strings — swept in a prior release. Only hit was internal test-harness text.

---

## Tier 1 — Fast-follow (launch week / first small slots)

Owner-asked polish and small correctness items, in rough priority order:

- [x] **Scores page header compression** — ✅ SHIPPED v2.88.0 (PR #178, 2026-08-08; owner approved shots incl. one alignment revision: chips true-centered, extras right-aligned). One control row on all three tabs; cards start 199px from top vs 270px. Cards/room-header untouched.
- [ ] **Ranking-card backgrounds** (owner-asked 2026-08-08; needs mini-design session) — ROADMAP entry.
- [x] **Public legacy `GameCard` title wrap** — ✅ SHIPPED v2.88.0 (PR #178). 2-line clamp on all four header-style variants; also fixed truncated titles bleeding across the card border into the neighbor card.
- [ ] **Global Scoreboard `score:new:global` per-card bump** — optimistic bump hits every category card; widen the socket payload with the engine.
- [ ] **Kiosk → `ScoreboardSurface` migration** (medium) — kills the last scoreboard render copy.
- [ ] **Unlinked-player affordances** (~0.5d) — disabled Follow + honest copy + room_members fallback in the name-typed stat resolvers.
- [ ] **Stale-PWA "new version available — tap to refresh" nudge** off `/api/version` (field report 2026-08-06; build if it recurs, or proactively for launch traffic).
- [ ] **Encrypt `DISCORD_CLIENT_SECRET` at rest** — do path (b): one-time migration that re-writes through `encryptSecret()` BEFORE adding to the allowlist (ROADMAP entry has the trap).
- [ ] **Settings.tsx FE test gap** — the newer toggles (ROOM_LISTED, AUTO_APPROVE_GUILD_MEMBERS, iScored posture) have no FE test file.
- [x] **`SetupWizard.tsx` decision** — ✅ DELETED v2.88.0 (PR #178). Zero importers; legacy-era flow (password-via-login hack, mandatory upfront iScored creds against doctrine). A future self-host onboarding gets rebuilt OAuth-first.
- [ ] **Member-picker admin add** — replaces ID-pasting for adding room admins (Google users can't know their ID); deferred rider from v2.80.0.
- [ ] **Ban follow-throughs** — ban → content cascade (soft-hide) and ban → Discord DM (both "not started" in ROADMAP §C).
- [ ] **Explicit `AuditService.log` sweep** — the blanket auditMiddleware audits nothing on router routes (documented v2.49.0); admin writes that claim auto-audit mostly aren't. Moderation accountability wants this early.

---

## Tier 2 — Post-launch backlog (stays in ROADMAP — pointers only)

**Arcs awaiting design/go:**
- Private tournaments (owner spec captured 2026-08-07; needs design session — hidden-unlisted-room reuse is the candidate approach)
- Room scoreboard revamp, 3 phases (awaiting owner go; phase 1 = mock screenshots)
- Score comments + voting/flagging (§A–D spec in ROADMAP)
- Player self-service: self-edit/delete scores (§A)
- First-login player tutorial (tabled)
- Player-selectable Global Scoreboard card style
- Comments & Tips bidirectional view
- Game Library filter panel
- Catalogue → engines + device availability migration (ADR 0016 gap; fixes AtGames unknown-engine scores)
- Catalogue "report a problem" + per-field source indicators
- Automated content screening (LLM flag-to-queue; explicitly not launch-critical)

**iScored (legacy bridge — don't promote, don't break):**
- Per-score delete true cascade (iScored CAN do it per the reference memory — ADR 0011 premise outdated)
- Cleanup orphan bug (in-page fetch endpoint + archive-only-on-success)
- Sync hardening (cooldown bypass via /sync-state; duplicate actives)
- ScoreSyncPoller adaptive backoff; agent reset on N failures; tunable API timeout
- `/unmap-user` command (build if a spoofing incident lands); pure-iScored-name claim flow; one-shot DM at merge

**Cleanups / tech debt:**
- Style overlay re-keying (`game_room_game_library` retirement); ratings re-keying
- Portal endpoint triplication; drop `user_mappings.avatar_hash`; `@types/sqlite3`+`@types/uuid` removal (Linux-container lockfile regen)
- Lint in CI + ~197-error admin-ui backlog (backlog first, gate second)
- MergeService in-txn conflict re-check; admin display-name override
- S20 a11y deferred items (a–e); S12 privacy residuals (draft photo orphans, feed metadata JSON)
- Guild-implies-membership refinement for Discord read commands; KIOSK_KEY for approval-room kiosks
- Web push follow-ups (a–e); notification coalescing
- Playwright browser decouple from base image; Steam Pinball refresh path
- Dependabot holds: #164 jsdom 30 (undici bump in Linux container), #165 admin-ui TS7 (upstream peer-pin)

**Infra (when scale demands):**
- Automated backup schedule + monitoring/alerting + server metrics; HA path (active-passive + Litestream → PostgreSQL)
- Score photo persistence beyond backups (S3/CDN, graceful 404s, fan-out copy)
- Platform integrations: IFPA, Matchplay, Scorbit, Stern Insider, Guilded/Revolt

---

## Housekeeping (repo hygiene, minutes)

- [x] **Delete `CATALOGUE_DUP_REVIEW.md`** — ✅ DONE 2026-08-08: archived to `tmp/CATALOGUE_DUP_REVIEW.md` (gitignored, record kept).
- [ ] **Decide `UAT_SCRIPT.md` + `TEST_KNOWN_ROUGH_EDGES.md`** — written for v2.20.x. Recommendation: refresh the UAT script against the current build and run it as the launch rehearsal (it's a ready-made 2-hour playtest), then archive both.
- [x] **Untracked `.vscode/` + `data/` subdirs** — ✅ DONE 2026-08-08: gitignored `data/catalogue-images|iscored-styles|score-photos|styles/` (runtime assets, ~6GB) + `.vscode/`; deleted empty `data/a.txt`. `data/callouts.json` stays tracked.
