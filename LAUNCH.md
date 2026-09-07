# Arcaid — Prioritized Tracker

> **Purpose:** the single ordered view of everything queued for Arcaid, across ROADMAP.md, SPRINT_STATUS.md, the plan docs and the ADRs.
> This is an INDEX with a one-paragraph tl;dr per item — details live in ROADMAP.md (referenced by entry name), `docs/`, and CLAUDE.md.
> Created 2026-08-08 as the launch-gate list; **rebuilt 2026-09-07** as the general priority tracker after a full sweep (the old Tier 0/1 lists are collapsed into "Done" at the bottom).
> Check items off here; keep ROADMAP as the deep backlog. When an item ships, move it to "Done" with its version.

**How the order was chosen:** owner rulings with dates first, then pain in the two live rooms, then prerequisite chains, then design readiness, then collision with the Witness session, then cost. **The Witness thread (cabinet app rc kits, rounds, ADR 0022 addendum, scorability table, desktop agent) is deliberately NOT listed here** — it runs in its own session and is tracked in SPRINT_STATUS + ROADMAP "VPX score ingestion".

**One decision this file cannot make for you:** the launch closeout (tier 6) has been "owner calls the timing" since 2026-08-09, and the 2026-09-05 competitive-gap sequence commits work into October. That is a de facto "launch waits for competitiveness" decision written nowhere. Sealed-bid and Share-to-Arcaid are ranked as post-launch below; **if you decide they are launch gates, they move to the top of tier 3.**

---

## Now — this week

- [ ] **Dependabot #328 + #321** — the routine minor/patch groups (7 backend, 12 admin-ui). Review and merge; #164 (jsdom 30) and #165 (TypeScript 7) stay held per ROADMAP.
- [x] **v2.155.5 mobile Game Detail rows** — shipped + prod-verified 2026-09-07.
- [x] **"My Tables" written into ROADMAP** — done 2026-09-07 (was only in Discord).
- [x] **This tracker rebuilt** — 2026-09-07.

---

## Tier 1 — Owner-committed for September (competitive-gap sequence, item 1)

1. [ ] **Manifest adoption** — ROADMAP "Competitive-gap sequence" item 1. **tl;dr:** Legends Unchained ships a `manifest.json` with every VPXS table's slug, VPS id, checksum, designers, players, manufacturer and year. Replace the VPXS Wizard README scrape in `WizardImportService` with a structured pull of it, linking `global_games.vps_id`; then let the cabinet score ingest match on the SLUG instead of the squashed-name fallback and record `tableChecksum` as "which build of the table produced this score". **When built:** the Wizard importer stops breaking on README formatting, every VPXS table is joined to its VPS identity, the rom fallback (`t2_l8` → slug → catalogue) becomes placeable, and the scorability table has a seed. Catalogue-side only, no collision with the Witness session. ~1–2 days.
2. [ ] **v2.156.0 "Also count this score in…" (ADR 0024)** — design in SPRINT_STATUS #137. **tl;dr:** one play of a table may legitimately count in EVERY tournament currently running that table. After a submit, offer checkboxes for the other tournaments running the same game; accepting clones the `score_history` row linked by `same_play_of` (no side effects: no toast, no feed event, no announcement); history/stats/feed group on that link; a ten-minute server-side auto-link catches hand double-submits; migration links the 3 rows already backfilled. **Caution:** touches `ScoreHistoryService` and the submit routes the Witness session is editing — handshake before starting. ~1 day.
3. [ ] **Cheap parity riders** — same ROADMAP item, each its own small release. **tl;dr:** (a) *Herb-format overall ranking* — iScored's standard cross-table ranking formula, so RTX-style rooms can show the number their players already know; (b) *broadcast popup* — an admin message pushed to every open leaderboard/kiosk (iScored 4/2026); (c) *streak/variety achievements* — relay the launcher's `achievements.json` unlocks (streaks, unique tables, decades, manufacturers, designers, time of day) rather than recomputing them. ~0.5 day each.

---

## Tier 2 — Live-room correctness, small, fill the gaps between big work

All from the RTX room, all a month or more old, all fully specified in ROADMAP "RTX demo feedback" / "Open Followups".

- [ ] **Room Scores tab cards missing their background art** — [BUG] since 2026-08-09. **tl;dr:** the Scoreboard's Room Scores view renders cards without the style-catalogue background the Tournaments view shows; the name-keyed card path skips the style-overlay resolution. Fix = resolve the overlay the same way for both views.
- [ ] **Lock indicator too subtle** — [QUICK]. **tl;dr:** the locked-game marker on cards is easy to miss at default styling; make it visible without a setting.
- [ ] **Discord `/submit-score` through the one resolver** — SPRINT_STATUS #137 item 5 + ROADMAP "Identity" bullet. **tl;dr:** the web submit paths all use `SubmissionGameResolver` (v2.155.1/.2) but the Discord command still resolves the game by name (the two-active-same-name bug is alive there), and its auto-map writes `user_mappings` directly, bypassing the alias cap + audit of `IdentityClaimService`. Route both through the shared code.
- [ ] **Discord autocomplete deadline + `/list-scores` embed cap** — two [HARDENING] bullets. **tl;dr:** `/view-stats` and `/pick-game` autocomplete re-query the ~4.2k-row catalogue per keystroke and miss Discord's 3s deadline (`40060` on prod); `/list-scores` breaks past 10 active games (one embed per game). Fix = a snapshot cache for the candidate list, chunked replies, and 40060 downgraded to WARN.
- [ ] **iScored shared-board follow-ups** — [SHARED-BOARD FOLLOW-UPS] + [HARDENING] `createGame`. **tl;dr:** rooms bridged to a board they don't own (rtx_pinball) need (a) a first-class cleanup mode `never`, (b) a lock-at-rotation toggle, and (c) a "already on the board" guard in `createGame` so a retried create adopts the existing entry instead of duplicating it (Clown Deluxe incident).
- [ ] **Submit-moment rank on pinned iScored games** — [QUICK]. **tl;dr:** the "You are #N of M" card ignores synced rivals on a PINNED board (v2.125.1 fixed only the tournament case). Rank against the same rows the leaderboard renders.
- [ ] **Cooldown variant rule** — [DESIGN]. **tl;dr:** "Clown" is blocked by "Clown Deluxe" via a bare name-prefix match, applied three different ways at four sites. Pick one rule (exact + curated suffix list is the likely answer), put it in one helper, test it.
- [ ] **Global Scoreboard control strip overflows phones** — Open Followups. **tl;dr:** the sort/density/filter strip is 479px wide on a 390px phone, causing whole-page horizontal scroll; make the strip scroll inside its own container.
- [ ] **Deploy flake: vendor the sqlite3 prebuilt** — [OPS HARDENING]. **tl;dr:** main-branch deploys failed twice on GitHub's CDN hanging while fetching the sqlite3 binary; cache the prebuilt in the Docker build so a deploy never depends on that fetch.
- [ ] **Two flaky tests** — `PinnedCarousel` tabindex timing, community-scores-attribution nested transaction. Both have a fix shape in ROADMAP.

---

## Tier 3 — Designed and owner-approved features, in build order

1. [ ] **One-time cooldown override** — ROADMAP "One-time cooldown override" (owner-designed 2026-08-23). **tl;dr:** today `queueGame` refuses a table in cooldown. Instead: let it be queued as HELD (top of queue, "N days"), with **Queue and wait** / **Queue + request override**; the request posts to the announce channel with admin-role mention + Approve/Deny buttons and lands in an admin queue like Identity Claims; approval stamps the queued row so the walker treats it as eligible ONCE, consumed on activation, taking effect at the player's next turn. Two new opt-in notifications (`pickHeld`, `overrideRequest`), per-tournament `COOLDOWN_OVERRIDES_ENABLED`. Direct player ask from a live room. ~1.5–2 days.
2. [ ] **Queue UX overhaul, remainder** — ROADMAP "Queue UX overhaul" (owner-approved 2026-08-27; newest-first already shipped v2.143.0). **tl;dr:** group "Your Picks" by tournament with filter tabs (cross-tournament arrows are meaningless today), drag-and-drop reorder within a group plus "send to top", and a prominent tournament selector next to the game search (players have nearly queued into the wrong tournament) echoed in the confirmation toast. **Owner wants mockups before build.** ~1–1.5 days after mockups.
3. [ ] **My Tables + availability facts** — ROADMAP "My Tables" (new) + Open Followups "[FEATURE] Availability facts are invisible to players". **tl;dr:** (a) players mark the tables they own, optionally per platform; the Picks list gets an "I own it" filter and an optional public "N players own this"; (b) ratings become attributable per rater and per platform, and public by rule ("stamp your name on it or don't rate"); (c) the shelved availability work — a `features` filter on `/api/global/games` and feature chips (vpxs / atgames / cabinet variants) on Library and catalogue rows — answers the sibling question "which tables can I play on my rig". Needs a short design pass; owner told the requester "going in soon" on 2026-08-24. ~2–3 days all-in.
4. [ ] **Rotation audit trail** — ROADMAP "Rotation audit trail" (owner-asked 2026-08-27). **tl;dr:** one structured event per rotation decision (winner resolved, disposition applied, pick window granted, every activation with its SOURCE and whose queue it consumed, placeholder deletions, cleanup), written as it happens, shown as a "Rotation log" panel on the room admin side, newest-first, filterable by tournament. **When built:** "who or what picked what, and why" is answerable from the admin UI instead of prod logs + DB archaeology (the 2026-08-27 incident). ~1–1.5 days.
5. [ ] **Scheduled catalogue syncs** — Open Followups "[FEATURE] Scheduled catalogue syncs". **tl;dr:** weekly overnight cron on the existing Scheduler for the LIVE-source importers only (VPS, VPXS Wizard/manifest, AtGames); Steam Pinball and FX VR excluded. Prevents the King Of The Hill class of miss (a table that joined the wizard months ago but never synced). ~0.5 day.
6. [ ] **Leaderboard settings consolidation C3** — ROADMAP "Leaderboard settings consolidation" (C1 + C2 shipped). **tl;dr:** GameLibrary and Tournaments still open the legacy StylePicker modal; swap it for a sheet hosting the same `CardStyleEditor` with a synthetic real-card preview, then delete `StylePicker.tsx`. Last step of a shipped arc. ~0.5–1 day.
7. [ ] **Sealed-bid tournaments** — ROADMAP "Sealed-bid tournaments" (all five decisions settled 2026-08-15). **tl;dr:** a per-tournament mode where posted scores stay hidden until a fixed offset before `end_date` (default 1h) or an admin "Reveal now". A sealed player sees their own score + "N players have submitted", never their rank; sealed tournaments contribute nothing to ranking groups and hold back the Global fan-out until reveal; requires an end date. ONE read-time gate (`SealedTournamentGate`) applied at ~15 leak sites (leaderboard reads, WS toasts, lobby feed, DMs, Discord commands, OG meta, photos); never bake redaction into a cache. **One owner call outstanding:** iScored-enabled rooms leak via iScored's public page — recommended answer is "honest on native rooms only, with an admin warning". ~2–3 days. Post-launch unless you rule it a gate.
8. [ ] **Share-to-Arcaid** — ROADMAP "Share-to-Arcaid" (owner-asked 2026-08-14; was sequenced after the style revamp, which is complete, so now unblocked). **tl;dr:** hand a score photo you already took to Arcaid in one gesture and land in the submission flow with it attached. ONE core feature — a `/share` route with a room + game chooser for an "orphan" photo — with three thin doorways: a **Paste** button (every platform, no install), an **Android share-sheet target** (manifest `share_target` + a service-worker POST intercept), and an **iOS Apple Shortcut** (WebKit has no share target). Build order: core → paste → Android → iOS only if still wanted. ~3–4 days. Post-launch unless you rule it a gate.

---

## Tier 4 — Strategic sequence (competitive-gap items 2–5; after the desktop Witness lands)

- [ ] **Arc 2: desktop VPX Witness** — `docs/vpx-desktop-witness-plan.md`. Belongs to the Witness session; listed only because items below wait on it. **tl;dr:** a Windows agent for VPX 10.8.0 that reads live NVRAM through the existing `core.vbs` callback so desktop cabinet owners get witnessed scores like ALP owners do. Rounds A + B gate everything.
- [ ] **Duels** — competitive-gap item 3. **tl;dr:** challenge/accept 1v1 with a clock, matchmaking on shared tables via the manifest's VPS id. Throwdown is the seed (~80% of the plumbing exists). A clean-run integrity tier (ball-1 restart detection from NVRAM game-count deltas) lives INSIDE duels/brackets on desktop only, window-only and clearly labelled on ALP; room boards stay badge-never-gate.
- [ ] **Strikes knockout** — competitive-gap item 4. **tl;dr:** the format virtual leagues actually run and the one that tolerates asynchronous play. Every format is a new `EventSubmissionGate` caller + a new definition of "the score counts" + freeze/reverify/standings/correction surfaces. **Run once with a real room before touching a third format.**
- [ ] **Stern Insider Connected sync** — item 5. Nothing to build until Stern says yes.

---

## Tier 5 — Needs a design session before anything is built

- [ ] **Room Settings page reorganisation** — ROADMAP entry. **tl;dr:** Settings is one endless scroll of ~10 sibling cards with no grouping and no way to jump. Pick between tabs/sections (Appearance · Access & Privacy · Integrations · Advanced), a settings search box, or sibling pages; decide which cards don't belong on Settings at all (Users duplicates Members; Platforms is library config).
- [ ] **Power-user custom cards ("go to town" mode)** — ROADMAP entry. **tl;dr:** a `Custom` card giving power users control over every aspect of the score card and the whole leaderboard area. Recommended shape is a **token editor** (typed controls over the card's design tokens rendered to room-scoped CSS variables), then optionally a slot/layout editor; NOT freeform CSS (unbreakable by us, no renderer contract, security surface, doesn't survive a redesign).
- [ ] **Picks page richer available-games list** — Open Followups "[UI ARC] Picks page redesign". **tl;dr:** each available-game entry shows image/logo, manufacturer·year, availability, last-played + cooldown, pick frequency, catalogue rating; the whole entry is clickable into `GameQuickView` with a "View full game page" action. Natural home for the My Tables filter. Screenshot loop.
- [ ] **Room scoreboard revamp** — ROADMAP entry (direction not picked). **tl;dr:** bring the Global Scoreboard's card language (neon category frames, podium top-3 + ranked list, 3-col grid, hero board, density modes) into rooms as a FOURTH `SCOREBOARD_STYLE` "Arcade", then page layout, then the "click a score to open its proof photo" affordance rides along. Sibling: **player-selectable Global Scoreboard card style** (the reverse adapter).
- [ ] **Score comments + voting + flagging** — ROADMAP entry (§A–D spec). **tl;dr:** comment on a specific person's score (anchored via `score_history_id` on the existing `game_comments`, no third store), optional Discord cross-post per comment, upvotes with a Top sort, report → mod queue. Discord-authed only. ~2–2.5 days once designed.
- [ ] **Comments & Tips bidirectional view + unified ratings** — ROADMAP entry. **tl;dr:** a tip written on a room game page never reaches the global game page and vice versa; add a "share globally" checkbox and render both stores together tagged by origin; unify ratings for any game with a `global_game_id`. Pulled forward by My Tables' ratings half.
- [ ] **First-login player tutorial** — tabled 2026-07-25; contract exists at `docs/contracts/first-login-tutorial-contract.md`.
- [ ] **Private room-scoped tournaments** — owner spec captured 2026-08-07. Largely absorbed by Throwdowns (room-less) — confirm what, if anything, remains for the hosted case before designing.

---

## Tier 6 — Launch closeout (owner-timed; no code blocked)

Order agreed 2026-08-09: **restore drill → score wipe → version reset → go.**

- [ ] **Backup restore drill** — restore a backup off-hours and rehearse the wipe script against the restored copy in the same session.
- [ ] **Pre-launch data wipe** — scoped 2026-08-09: **keep ALL rooms** (rooms, games, settings, styles, members), **zero the scores**. Full DB + assets backup first, then a scripted pass over `submissions`, `score_history`, `community_scores`, `global_scores`, leaderboard + ranking caches, lobby feed score events; verify caches rebuild clean. Deliberately the very last step before go-live.
- [ ] **Public version reset** — root `package.json` → v0.90.0 Beta, → v1.0.0 at GA. Surfaces via `/api/version`, Help footer, Dashboard health card.

---

## Tier 7 — Backlog (stays in ROADMAP; don't promote)

- **iScored (tolerated legacy bridge — don't promote, don't break):** delete-on-iScored per-score cascade (ADR 0011's "no per-score API" premise is wrong — this is what made the Blackbelt incident possible), weekly cleanup orphan bug, per-score delete true cascade, sync hardening (cooldown bypass via `/sync-state`, duplicate actives), poller adaptive backoff + agent reset, tunable API timeout, `/unmap-user`, pure-iScored-name claim form, one-shot DM at merge, identity P3 photo-verified promotion to Global.
- **Cleanups / tech debt:** style overlay re-keying (retire `game_room_game_library`), ratings re-keying, `game_rooms.discord_guild_id` retirement, portal endpoint triplication, drop `user_mappings.avatar_hash`, `@types/sqlite3` + `@types/uuid` removal, lint in CI + ~197-error admin-ui backlog, MergeService in-txn re-check, admin display-name override, S20 a11y deferred items, S12 privacy residuals, guild-implies-membership for Discord reads, `KIOSK_KEY` for approval-room kiosks, web push follow-ups, notification coalescing, Playwright browser decoupled from the base image, Steam pack hand-curation of the two unparseable packs, Zaccaria naming unification (curation arc), catalogue "report a problem" queue, Game Library filter panel, mobile scoreboard polish batch, score-photo persistence (S3/CDN, graceful 404s), submission-draft username-lock bypass, guest multi-name collapse.
- **Infra (when scale demands):** automated backup schedule + monitoring/alerting + server metrics; HA path (active-passive + Litestream → PostgreSQL).
- **Platform integrations:** IFPA (**real pins only** — owner 2026-09-05; virtual is unsanctionable), Matchplay, Scorbit, Guilded/Revolt. Streaming integrations (Discord + Twitch) PARKED, not scoped.
- **Decisions on record, not work:** hard "require linked Discord to submit" gate — NOT recommended (encouragement shipped v2.112.0; use approval rooms + `AUTO_APPROVE_GUILD_MEMBERS`). Personal rooms — REJECTED (ADR 0018).

---

## Done (from the original 2026-08-08 launch tracker; details in CHANGELOG)

**Owner actions:** Global Arcaid Discord server configured + field-tested · dedup audit on prod (0/0) · pre-v2.10 iScored orphans resolved · prod server ops (init:true, Ubuntu updates, reboot) · v2.85–v2.88 eyeballed ("Prod looks great") · RetroAchievements configured (8,628 games / 20 consoles).
**Launch-gating code:** comments/ratings login-gating + admin comment moderation + `RatingService` room-scoping (v2.86.0) · photo backup mirror (already shipped) · room-admin nav escape + `videogame` mode normalization (v2.87.0) · brand casing sweep (verified).
**Fast-follow:** Scores page header compression + `GameCard` title wrap + `SetupWizard` deletion (v2.88.0) · ranking-card backgrounds (v2.89.0) · `score:new:global` per-card bump (v2.89.1) · kiosk → `ScoreboardSurface` (v2.90.0) · unlinked-player affordances (v2.91.0) · stale-PWA nudge + `DISCORD_CLIENT_SECRET` at rest (v2.92.0) · Settings.tsx tests (PR #186) · member-picker admin add (v2.93.0) · ban follow-throughs (v2.94.0) · explicit `AuditService.log` sweep (v2.95.0).
**Housekeeping:** `CATALOGUE_DUP_REVIEW.md` archived · UAT/rough-edges docs archived (owner chose skip) · Discord slash-command drift audit, 9/9 fixed (v2.97.1) · untracked `data/` subdirs gitignored · `data/callouts.json` retired (callouts table is the source of truth).
**Shipped since, previously tracked in ROADMAP (pruned 2026-09-07):** iScored room snapshots (v2.117.0) · Steam pack auto-expansion + Discord link nudge + AtGames API importer (v2.112.0) · Zaccaria/AtGames catalogue dedup (PRs #230–#232) · identity & membership arc (v2.79–v2.82) · room membership & privacy (v2.38/v2.39) · content moderation layers 1–3 · Tournament Events + Throwdowns + AtGames sync (v2.135–v2.141) · admin Leaderboard controls/WYSIWYG + arrow fix + drag reposition (v2.85.0, v2.118.0) · Picks page filters (v2.84.0) · style-system revamp P0–P3 · theme cull (v2.133.0) · `/pick-game` consolidation (v2.103.0) · catalogue engines migration (v2.62.0) · Global Arcaid Discord + RA import (configured) · next-win disposition, ranking ticker, stats filters, scoreboard display controls (v2.96–v2.115).
