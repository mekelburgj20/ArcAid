# Arcaid — Launch Tracking List

> **Purpose:** the single prioritized view of everything left before (and right after) public launch.
> This is an INDEX — details live in ROADMAP.md (referenced by entry name) and SPRINT_STATUS.md.
> Created 2026-08-08 from a full sweep of ROADMAP.md, SPRINT_STATUS.md, and the repo-root working docs.
> Check items off here; keep ROADMAP as the deep backlog.

---

## Tier 0 — Launch gate

### A. Owner actions — no code, clicks + config (~half a day total)

- [ ] **Configure + field-test the Global Arcaid Discord server** (shipped inert v2.72.0). Steps in ROADMAP "Global Arcaid Discord server": convert the test server, set `GLOBAL_DISCORD_GUILD_ID` (+ optional invite URL) in Global Settings, grant the bot Create Invite, test the connect flow from a Discord-less room.
- [ ] **Run the Dedup Audit on prod** (pending since v2.21.0). `/admin/catalogue` → Dedup Audit. Reports whether re-syncs re-planted stripped IPDB links; Strip All remediates in-app.
- [ ] **Hand-delete the two pre-v2.10 iScored orphans** — Paranormal (95735) and Attack from Mars (95586), visible on iScored under mekelburgj@gmail.com with no local rows. iScored admin UI, two deletes.
- [ ] **Backup restore drill** — actually restore a backup once, off-hours, before real users depend on the data. (From TEST_KNOWN_ROUGH_EDGES.md — the first restore should not be during an incident.)
- [ ] **Prod server ops** (post-S3 backlog): add `init: true` to docker-compose (zombie reaper) and run the pending Ubuntu update on the Hetzner box.
- [ ] **Eyeball v2.85 on prod** — glance at `/rtx_pinball` public scoreboard + admin Leaderboard (v2.85.0 re-routed the public scoreboard through the extracted surface; tests say identical, eyes should confirm).
- [ ] **Decide: pre-launch data wipe.** The UAT script's premise was "room data is disposable, wiped before launch." Decide what (if anything) gets wiped/kept in prod before GA — deliberate, backed-up pass if so.
- [ ] **Decide: RetroAchievements config** (shipped inert v2.68.0). Configure `RA_USERNAME`/`RA_API_KEY` + one master-list sync if console games are part of the launch story; otherwise leave inert (it degrades gracefully).

### B. Launch-gating code (~3–4 focused days total)

- [ ] **Public version reset** — root `package.json` v2.85.x → **v0.90.0 Beta**, → v1.0.0 at GA (versioning plan). Surfaces via `/api/version`, Help footer, Dashboard health card. Small but it IS the launch version.
- [ ] **Comments/ratings login-gating** (~0.5d, tracked follow-up since v2.79.0). Closes the last guest write paths: anon comment spam and the `x-user-id` rating ballot-stuffing surface — also closes the known "banned users can still write anonymously" gap. ROADMAP "Player Self-Service §B" has the spec.
- [ ] **Admin comment moderation that works from the UI** (S11 follow-up item 1). Today password/local admins can't delete comments at all and the FE sends no token, so even Discord admins can't moderate from the UI. Public launch needs working comment moderation. Pairs naturally with the item above (~0.5d together with it).
- [ ] **`RatingService` room-scoping** (S11 follow-up item 3). Ratings key on `gameName` alone → cross-tenant rating blend. Verify what remains after login-gating ratings; fix the scoping either way.
- [ ] **Photo backup quick win** — include `data/score-photos/` in the backup volume (ROADMAP "Score Photo Persistence" quick win; DB is backed up, photos are not — proof photos are user data).
- [ ] **Room-admin nav escape** (small, owner-asked 2026-07-31). No way out of `/:slug/admin/*`; make `BrandWordmark` link to `/` by default + "back to room" in RoomAdminLayout. Every new room admin at launch hits this in minute one.
- [ ] **`videogame` tournament-mode normalization** (~0.5d). Video-game tournaments match zero catalogue games at every pick surface — a silently broken advertised capability if any launch room runs one. Shared mode-normalization helper at the 4 sites + pinning test.
- [ ] **Brand casing sweep** — "Arcaid" not "ArcAid" in UI strings/prose (decision 2026-07-25). Cheap, and it's the brand on launch day.

---

## Tier 1 — Fast-follow (launch week / first small slots)

Owner-asked polish and small correctness items, in rough priority order:

- [ ] **Scores page header compression** (owner-asked 2026-08-08; screenshot-loop; small/medium) — ROADMAP entry has the spec + suggestions.
- [ ] **Ranking-card backgrounds** (owner-asked 2026-08-08; needs mini-design session) — ROADMAP entry.
- [ ] **Public legacy `GameCard` title wrap** (no-ellipsis rule violation; small player-facing fix).
- [ ] **Global Scoreboard `score:new:global` per-card bump** — optimistic bump hits every category card; widen the socket payload with the engine.
- [ ] **Kiosk → `ScoreboardSurface` migration** (medium) — kills the last scoreboard render copy.
- [ ] **Unlinked-player affordances** (~0.5d) — disabled Follow + honest copy + room_members fallback in the name-typed stat resolvers.
- [ ] **Stale-PWA "new version available — tap to refresh" nudge** off `/api/version` (field report 2026-08-06; build if it recurs, or proactively for launch traffic).
- [ ] **Encrypt `DISCORD_CLIENT_SECRET` at rest** — do path (b): one-time migration that re-writes through `encryptSecret()` BEFORE adding to the allowlist (ROADMAP entry has the trap).
- [ ] **Settings.tsx FE test gap** — the newer toggles (ROOM_LISTED, AUTO_APPROVE_GUILD_MEMBERS, iScored posture) have no FE test file.
- [ ] **`SetupWizard.tsx` decision** — orphaned/unrouted; re-route or delete.
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

- [ ] **Delete `CATALOGUE_DUP_REVIEW.md`** — executed against prod 2026-07-04 (67 ops, 0 failures, all 60 decided). It's a completed working doc; archive to `tmp/` if you want the record.
- [ ] **Decide `UAT_SCRIPT.md` + `TEST_KNOWN_ROUGH_EDGES.md`** — written for v2.20.x. Recommendation: refresh the UAT script against the current build and run it as the launch rehearsal (it's a ready-made 2-hour playtest), then archive both.
- [ ] **Untracked `.vscode/` + `data/` subdirs** — gitignore or commit deliberately.
