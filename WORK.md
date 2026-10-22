# ArcAid — Work

Board: https://claude.ai/artifact/SXbKCEJL1jnzWRa2w7CcsU  ·  Rules: `.claude/commands/work.md`  ·  Check: `npm run work:check`

One line per item, IDs never reused. History: `CHANGELOG.md` and `git log -- WORK.md`. Detail lives where `spec:` points:
`ROADMAP.md`, `LAUNCH.md` and `SPRINT_STATUS.md` are frozen archives (read-only since 2026-10-21), `docs/decisions/` holds the
rulings, castcade `docs/arcaid-side-changes.md` holds the Witness/Castcade hand-off. `tier: N` is the owner's 2026-09-07
priority tier from `LAUNCH.md`. Pick an item with `/work <ID>`; end a session with `/wrap`.

## Now

- ArcAid 2.166.1 on prod (2026-10-21). Integrity mode is live: #370 backend (2.165.0, ADR 0027) + #371 admin UI and VR-headset provenance (2.166.0); #354 put the tournament selector first on Picks (2.166.1); Dependabot groups #355/#356 merged.
- In flight: nothing claimed by an agent.
- Owner steps: A3 configure GamerDad89's real Season in mox_s_vpx_tournaments (room zone America/New_York first, then the cron) · re-pair the owner's rig from Castcade Settings so its device row reads desktop, not cabinet (tracked in castcade `WORK.md`).
- Next by LAUNCH tier — tier 1: C1 manifest adoption (cabinet half; the desktop half shipped with ADR 0027), B1 "Also count this score in…", B2 cheap parity riders · tier 2: B5 submit-moment rank on pinned games, E1 Discord `/submit-score` through the shared resolver, A8 one cooldown rule.
- Newest owner ask: B7 Room Stats page (2026-10-20).
- Witness/Castcade: W5 live device view and W6 script baseline + preflight are the next ArcAid-side items; Castcade is on F4/F5 (companion 0.2.10).
- Blocked upstream: X9 TypeScript 7 (typescript-eslint peer range) and X10 jsdom 30 (fails the admin-ui suite); Dependabot #164/#165 were closed 2026-10-21 and will be re-proposed.
- Owner calls from the 2026-10-21 audit: A11 Duels — keep as the non-Castcade 1v1 variant or fold into W8? D3 and D5 were dropped as contradicting ADR 0023 (sync bar kept; photo never decides publication) — confirm or reopen with a ruling.
- Last wrap: 2026-10-21 — every item audited against code, CHANGELOG and ADRs: 15 flipped to done (A7, A7.1, A7.2, A7.4, A13, B3, B6, B9.3, B13, B14, B16, D10, E6, W9 + B17 dropped), D3/D5 dropped, 20 lines re-scoped, W12/H5 added.

## A. Tournaments, rotation, seasons, picks, queue

Lane: `src/engine/**`, `src/services/{Tournament,PickQueue,PickDisposition,PickAward,PickAlert,SeasonPoll,RotationAudit,RotationNudge,QueueLowNudge,Event,EventResult,EventSubmissionGate,Throwdown,ThrowdownScore}Service.ts`, `src/utils/{cooldown,pickWindow,queueOrder,cronUtils,tournamentMode}.ts`, `admin-ui/src/pages/{Tournaments,TournamentDetail,Picks,GameStates,EventDetail,ThrowdownDetail,MysteryAwardPage}.tsx`, `admin-ui/src/components/{TournamentForm,SeasonPanel,SeasonPollCard,RotationLogPanel,ScheduleBuilder,Event*,Throwdowns*,AdminPickOnBehalf,PickGameModal}.tsx`.

- **A1** `done 2.162.0` Season format (ADR 0025, 2.161.0) + Pick by poll as a rotation method (ADR 0026); demo checklist items 1–11 prod-verified 2026-10-20
- **A2** `done 2.164.0` SeasonScheduler cosmetic follow-ups from #161 (empty-draft WARN once per draft; "chose X over (none)" copy) rode with the room timezone
- **A3** `claimed` Configure GamerDad89's real Season in mox_s_vpx_tournaments — set the room zone to America/New_York FIRST, then cron `0 0 * * 5`, 12 tables, Pick by poll on, Countdown points_top 50, own announce channel, bot re-invite `permissions=562949953506304` (check the guild perms first) · owner: owner · since: 2026-10-20 · spec: SPRINT_STATUS.md #162–#163
- **A4** `idea` Season polish — Cooldown Days default when Pick by poll is switched off; "posts immediately" instead of a past Opens time on the Season panel; a repost-keeping-Arcaid-votes variant if Mox ever needs to extend an open poll · spec: SPRINT_STATUS.md #156–#159
- **A5** `done 2.146.0` Rotation audit trail — "Rotation log" panel on Game States (ids resolved to names 2.157.1)
- **A6** `ready` One-time cooldown override — queue an in-cooldown table as HELD, **Queue and wait** / **Queue + request override**, admin Approve/Deny in the announce channel + an admin queue, grant consumed on activation; `pickHeld` + `overrideRequest` notifications, per-tournament `COOLDOWN_OVERRIDES_ENABLED` · tier: 3 · spec: ROADMAP.md §"One-time cooldown override"
- **A7** `done 2.166.1` Queue UX overhaul — per-tournament tabs, drag reorder, Top, newest-first and the tournament-named toast (2.143.0, mockups approved 2026-08-27); tournament selector first (2.166.1)
  - **A7.1** `done 2.143.0` Group "Your Picks" by tournament with filter tabs
  - **A7.2** `done 2.143.0` Drag-and-drop reorder within a group + per-row "send to top"; arrows stay as fallback
  - **A7.3** `done 2.166.1` Tournament selector first on the Picks page (#354)
  - **A7.4** `done 2.143.0` Echo the tournament name in the queue-confirmation toast
- **A8** `ready` Cooldown "variant" rule — the bare name-prefix match is applied three ways at four sites (engine, availability list, `cooldownDaysRemaining`, autopick); pick one rule (exact + curated suffix list likely), one helper, one test · tier: 2 · spec: ROADMAP.md §"[DESIGN] Cooldown"
- **A9** `ready` Archive-time photo purge is keyed on (game name, room), not the archived game — scope the SELECT/UPDATEs to `submitted_during_tournament_id` / `game_id`; test with the same table ACTIVE in a sibling tournament · spec: ROADMAP.md §"[HARDENING] Archive-time photo purge"
- **A10** `ready` Sealed-bid tournaments — scores hidden until a fixed offset before `end_date` (default 1 h) or admin "Reveal now"; one read-time `SealedTournamentGate` at ~15 leak sites, never baked into a cache; requires an end date; owner call open on iScored rooms (recommend: honest on native rooms + admin warning) · tier: 3 · spec: ROADMAP.md §"Sealed-bid tournaments"
- **A11** `ready` Duels — challenge/accept 1v1 with a clock, matchmaking on VPS id (ADR 0027 already matches `vps_game`); Throwdown is the seed, roster = W8.3, the live-turn variant is W8 (Castcade); integrity is the tournament's `integrity_mode` (ADR 0027), not a duel-internal tier — a Sanctioned duel may add a `max_restarts` rule over the `restarts` tally stored since 2.160.0; room boards stay badge-never-gate · tier: 4 · needs: W8.3 · spec: ROADMAP.md §"Competitive-gap sequence" item 3 (its integrity paragraph is superseded by ADR 0027)
- **A12** `ready` Strikes knockout — a new `EventSubmissionGate` caller + a new "the score counts" definition composed with the ADR 0027 gate + freeze/reverify/standings/correction surfaces; run A11 once with a real room first · tier: 4 · needs: A11 · spec: ROADMAP.md §"Competitive-gap sequence" item 4
- **A13** `done 2.141.0` Private room-scoped tournaments — satisfied by the Events/Throwdowns arc (ADR 0018 Consequences); nothing remains for the hosted case
- **A14** `idea` Picks page richer available-games list, remainder — image/logo in the row, whole entry clickable (title-only today), pick frequency / last picker, catalogue rating, "View full game page" on `GameQuickView`; mfg·year, last-played and cooldown chips already render; natural home for the My Tables filter (C2); screenshot loop · tier: 5 · spec: ROADMAP.md §"[UI ARC] Picks page redesign"
- **A15** `done 2.141.0` Tournament Events & Throwdowns arc (2.135.0 → 2.141.0, ADRs 0017/0018); P8 became the Arcaid Witness (W1)

## B. Scores, submission, leaderboards, Global Scoreboard, cards, styles, stats

Lane: `src/services/{ScoreHistory,ScoreRank,ScoreProvenance,ScoreReport,CommunityScore,RoomScores,TournamentScores,Leaderboard,GlobalLeaderboard,GlobalScore,GlobalPin,Ranking,Stats,Milestone,Achievement,SubmissionContext,SubmissionDraft,SubmissionGameResolver,StyleCatalogue,StyleProfile,CardOrder,AutoScoreSuppression}Service.ts`, `src/utils/{bgFraming,scoreProvenance,submissionAttribution,scorePhotoCleanup}.ts`, `admin-ui/src/components/scoreboard/**`, `admin-ui/src/pages/{Scoreboard,KioskScoreboard,Leaderboard,GlobalScoreboard,GlobalGameDetail,GameDetail,ScoreSubmit,Rankings,RankingsFullStandings,PublicStats,Stats,MyStats,History,PublicHistory,StyleCatalogue,ComparePlayers,PlayerDetail}.tsx`, `admin-ui/src/components/{SubmissionSheet,ScoreCardGrid,ScoreHistoryChart,ScoreboardTicker,StyleProfiles,StyleUploadForm,ScorePhotoModal,CorrectScoreModal,ProvenanceTags,SourceChip,Global*}.tsx`.

- **B1** `ready` "Also count this score in…" — one play counts in every tournament running that table: post-submit checkboxes, cloned `score_history` rows linked by `same_play_of` with no side effects (no second Global fan-out per ADR 0023; a delete tombstones the whole family per ADR 0024), a ten-minute server-side auto-link; also the honest destination for a witness score that matches two open games (today it goes to Global, `VpxScoreIngestService`); needs its own ADR (0024 went to auto-posted deletes); re-check whether any backfilled rows still need linking after migration 175 · tier: 1 · spec: SPRINT_STATUS.md #137 item 3 · touches: src/services/VpxScoreIngestService.ts
- **B2** `ready` Cheap parity riders, each its own small release · tier: 1 · spec: ROADMAP.md §"Competitive-gap sequence" item 1
  - **B2.1** `ready` Herb-format overall ranking (iScored's standard cross-table formula)
  - **B2.2** `ready` Broadcast popup — an admin message pushed to every open leaderboard/kiosk
  - **B2.3** `ready` Streak/variety achievements relayed from the launcher's `achievements.json` unlocks — new `AchievementType` values on `player_achievements`, not recomputed; the reader is device-side (cabinet Witness / castcade) · touches: src/services/VpxScoreIngestService.ts
- **B3** `done 2.95.2` [BUG] Room Scores tab cards missed their style-catalogue background art (`resolveCardChrome` now reads the games-row overlay)
- **B4** `done 2.95.2` Lock indicator visible from across the room (RTX demo [QUICK])
- **B5** `ready` Submit-moment rank on PINNED iScored-bridged games ignores synced rivals — rank against the rows `LeaderboardService` renders for pinned games; regression test beside the Jaws fixture in `scoreRank.test.ts` · tier: 2 · spec: ROADMAP.md §"[QUICK] Submit-moment rank"
- **B6** `done 2.78.0` Global Scoreboard sort/density strip overflowed phones (strip contained in its own `overflow-x-auto`)
- **B7** `ready` Room Stats — a third tab on `PublicStats`: most selected tables (picker-attributed), highest rated room vs global, tables played lifetime + activations, per-tournament breakdown; one cached `GET /:roomId/stats/room`; names via `resolveUserLabels` (owner-asked 2026-10-20) · spec: ROADMAP.md §"Room Stats"
- **B8** `done 2.124.0` Leaderboard settings consolidation C1–C3 (2.116.0 / 2.119.0 / 2.124.0; `StylePicker.tsx` deleted)
- **B9** `idea` Room scoreboard revamp, phases 2–3 — direction not picked · tier: 5 · spec: ROADMAP.md §"Room scoreboard revamp"
  - **B9.1** `done 2.106.0` Arcade card style (phase 1): the Global card language as a fourth `SCOREBOARD_STYLE`
  - **B9.2** `idea` Room page layout modernization — 3-col grid, hero board, "My Score" density mode
  - **B9.3** `done 2.109.0` Proof photos reachable from the score row (two-step gesture: row → quick popup → score opens the photo)
- **B10** `idea` Player-selectable Global Scoreboard card style — prefs plumbing fits; the work is an adapter from `TopGame` into the card system · spec: ROADMAP.md §"Player-selectable Global Scoreboard"
- **B11** `idea` Power-user custom cards ("go to town") — token editor first, slot/layout editor second, never freeform CSS; style profiles (2.111.0) already answer where a look lives · tier: 5 · spec: ROADMAP.md §"Power-user card + leaderboard customization"
- **B12** `idea` Score comments + voting — anchor via `score_history_id` on `game_comments` (no third store), opt-in Discord cross-post, upvotes + Top sort (`comment_votes`); report → mod queue already shipped 2.47.0 (`CommentReportService`, Reports "Comments" tab); Discord-authed only · tier: 5 · spec: ROADMAP.md §"Score comments" §A–C · touches: src/services/CommentService.ts
- **B13** `done 2.104.0` Mobile scoreboard polish batch — larger row defaults, avatar + name grouped, QR never on phone viewports
- **B14** `done 2.110.0` Admin scoreboard preview simulates mobile (390 px iframe `DevicePreviewFrame`; the preview is the real `ScoreboardSurface`)
- **B15** `idea` Score photo persistence — S3/CDN, placeholder instead of 404 (`server.ts` serves `express.static` only), persist iScored CDN photos at sync, copy room photos at fan-out (one shared url today); the backup already mirrors `data/score-photos` · tier: 7 · spec: ROADMAP.md §"Score Photo Persistence"
- **B16** `done 2.79.0` Submission-draft commit resolves the canonical name server-side (the sweep still keys on the typed name)
- **B17** `dropped 2.79.0 login mandate` Guest multi-name collapse — guests cannot submit since the login mandate, so no new rows partition on `iscored:<typed name>`; legacy rows stay admin-merge territory
- **B18** `ready` AW badge contrast on light themes (site-wide, pre-existing; found in the 2.157.0 review) · spec: SPRINT_STATUS.md #148–#149
- **B19** `ready` Share-to-Arcaid — ONE core: a `/share` orphan-photo landing with room + game chooser feeding `SubmissionSheet` through `normalizePhotoFile`; doorways in order: Paste button → Android `share_target` + SW POST intercept → iOS Shortcut only if still wanted · tier: 3 · spec: ROADMAP.md §"Share-to-Arcaid" · touches: admin-ui/public/{manifest.json,sw.js}

## C. Catalogue, importers, library, My Tables, availability facts

Lane: `src/services/{Vps,Wizard,AtGames,SteamPinball,FxVr,OPDB,IGDB,RA}*.ts`, `src/services/{GlobalGame,GameLibrary,GameFeedback,SyncLog,Rating,GlobalRating,Comment,GlobalComment,RoomGameTags,RAMasterList}Service.ts`, `src/utils/{catalogueUtils,platformMapping,platformRules,searchRank}.ts`, `src/api/raCatalogueHandlers.ts`, `scripts/{reimport-catalogue,backfill-*,analyze-catalogue,ipdb-check}.ts`, `src/scripts/merge-zaccaria-atgames-dupes.ts`, `admin-ui/src/pages/{GameLibrary,GlobalCatalogue,CatalogueApproval}.tsx`, `admin-ui/src/components/{PlatformChips,GameQuickView,GameInfoModal,RAGameSearch,StarRating}.tsx`.

- **C1** `ready` Manifest adoption — replace `WizardImportService`'s README scrape with a structured pull of Legends Unchained's `manifest.json` (slug, VPS id, checksum, designers, players, mfg, year) linking `global_games.vps_id`; then the CABINET ingest joins slug → VPS id and records `tableChecksum` (the desktop path already matches on `vps_game` and stores `table_sha256`, ADR 0027 / 2.165.0); seeds the scorability table (W8.1) · tier: 1 · spec: ROADMAP.md §"Competitive-gap sequence" item 1 · touches: src/services/VpxScoreIngestService.ts
- **C2** `ready` My Tables + availability facts — owner told the requester "going in soon" 2026-08-24; short design pass first · tier: 3 · spec: ROADMAP.md §"My Tables"
  - **C2.1** `ready` Inventory: `player_tables(user_id, global_game_id, platform)`, "I own it" filter on Picks, optional public "N players own this"
  - **C2.2** `ready` Ratings attributable per rater and per platform, public by rule ("stamp your name on it or don't rate") · needs: C3
  - **C2.3** `ready` Availability facts: `features` filter on `/api/global/games` + feature chips (vpxs / atgames + cabinet variants / vr / bam) on Library and catalogue rows — absorbs the [QUICK] Game Library chips item · spec: ROADMAP.md §"[FEATURE] Availability facts"
- **C3** `idea` Comments & Tips bidirectional view + unified ratings — "share globally" checkbox, both stores rendered tagged by origin, ratings unified on `global_game_id` · tier: 5 · spec: ROADMAP.md §"Comments & Tips — bidirectional view"
- **C4** `ready` Scheduled catalogue syncs — weekly overnight cron on the Scheduler for the live-source importers only (VPS, Wizard/manifest, AtGames); Steam/FX excluded; `CATALOGUE_AUTOSYNC_ENABLED` ships inert; failures on the health card · tier: 3 · spec: ROADMAP.md §"[FEATURE] Scheduled catalogue syncs"
- **C5** `idea` Zaccaria remake/retro naming unification — matching pass, owner adjudication over the pairs, naming convention, importer guard (four distinct designs per base name; plain name folds into the real machine per ADR 0014) · tier: 7 · spec: ROADMAP.md §"[CURATION ARC] Zaccaria"
- **C6** `idea` Game Library filter panel — platform / manufacturer / type / year / theme / players, URL state, facet counts; smart search (2.7.0) covers most cases today · tier: 7 · spec: ROADMAP.md §"Game Library filters"
- **C7** `done 2.25.0` Catalogue "report a problem" queue (`GameFeedbackService`)
- **C8** `idea` Steam pack hand-curation of the two unparseable packs · tier: 7 · spec: LAUNCH.md tier 7

## D. Identity, members, claims, moderation, privacy, notifications

Lane: `src/services/{Identity*,Merge,UserProfile,PlayerProfileResolver,AnonymousIdentity,AccountDeletion,Ban,BanNotification,ContentReport,CommentReport,RoomMembership,RoomRoster,RoomAccess,RoomNameClaim,JoinRequest,Friends,Preferences,WebPush,Notification,DmNudge,DiscordLinkNudge,DiscordReachability,LinkNonceStore}*.ts`, `src/api/auth.ts`, `src/api/routes/{auth,users}.ts`, `src/utils/{identityProvider,contentBlocklist,blocklistTerms}.ts`, `admin-ui/src/pages/{AccountSettings,Identity,IdentityClaims,RoomMembers,RoomAdminMembers,JoinRequests,Reports,Friends,Privacy,Login,RoomLogin,InviteAccept}.tsx`, `admin-ui/src/components/{MemberAdminPicker,NotificationNudgeBanner,ReportContentModal,RoomJoinGate,Tour*}.tsx`.

- **D1** `done 2.127.1` Identity claims P1 + P4 (2.112.0), P2 duplicate-name prompt at submit (2.113.0), tidy-up (0) + (a) + profile hydration (2.127.0 / 2.127.1)
- **D2** `idea` Identity tidy-up remainder — (b) invited admins with no profile row labelled "(invited, not yet logged in)"; (c) fuzzy-suggest ("looks like @user") in the Identity Claims queue · spec: ROADMAP.md §"[IDENTITY TIDY-UP"
- **D3** `dropped ADR 0023` P3 photo-verified promotion of synced scores to Global — ADR 0023 (2026-09-01) kept the sync bar explicitly and `fanOutFromRoomSubmission` still rejects `source='sync'`; reopen only with a ruling · spec: ROADMAP.md §"Identity" P3
- **D4** `idea` "Pull all my AtGames personal bests onto Global" — no per-player AtGames credential is stored (rooms hold only the owner's `ATGAMES_EMAIL/PASSWORD`); AtGames-native scores ARE admitted to Global since ADR 0023, so the first cut = public all-time top-5 scan (`AtGamesPrivateClient` public feed) gated by `share_to_global` · spec: ROADMAP.md §"Identity" [FEATURE, owner-asked 2026-08-27]
- **D5** `dropped ADR 0023` Rooms without `REQUIRE_SCORE_PHOTO` may not fan out to Global — superseded by ADR 0023 (2026-09-01: format and photo never decide publication; Witness and Throwdown scores carry no photo by design); the 2026-08-17 remark predates the ruling · spec: ROADMAP.md §"Identity"
- **D6** `ready` Self-EDIT own comments + convert the existing author-tier hard delete (the comment DELETE routes in `rooms.ts` / `global.ts`) to soft-delete via `deleted_at`, audited; legacy anon comments stay read-only · spec: ROADMAP.md §"Player Self-Service" B
- **D7** `idea` "My scores" / "My comments" management views (`/api/me/scores`, `/api/me/comments`) + a rate limit on self-corrections · spec: ROADMAP.md §"Player Self-Service" A
- **D8** `done 2.95.0` Bans arc — UI 2.44.0, room-tier 2.49.0, content cascade + DM 2.94.0, explicit `AuditService.log` sweep 2.95.0
- **D9** `idea` Automated content screening — async cheap-LLM pass that FLAGS new room names/descriptions to the queue (moderation layer 4; not launch-critical) · spec: ROADMAP.md §"Content moderation"
- **D10** `done 2.44.0` Admin display-name override (`PATCH /api/admin/users/:userId/display-name`, audited; the UI exposes clear-only, free-text rename deferred)
- **D11** `idea` S12 privacy residuals — purge-by-age sweep of orphan staged proof photos; best-effort scrub of a deleted user's id inside third-party `lobby_feed_events.metadata` · tier: 7 · spec: ROADMAP.md §"S12 privacy residuals"
- **D12** `idea` Web push follow-ups — push-host allowlist, "disable everywhere", subscription count on the health card, `pushsubscriptionchange` re-subscribe after VAPID rotation (`turnToPick` already pushes, 2.70.0) · tier: 7 · spec: ROADMAP.md §"Web push follow-ups"
- **D13** `idea` Notification coalescing — 3+ same-type DMs within 5 min → one summary · tier: 7 · spec: ROADMAP.md §"Notification coalescing"
- **D14** `idea` Discord link nudge — Picks page note ("no DM when it's your turn") for players with no reachable Discord; the notification-settings half already shows reachability honestly (2.72.0) · spec: ROADMAP.md §"[QUICK] Discord link nudge"
- **D15** `done 2.48.0` First-login player tutorial (spotlight tour, `tutorial_seen_at`)

## E. Discord bot

Lane: `src/discord/**`, `src/services/{Announcement,Callout,ChatResponseSettings,DiscordNicknameResolver}Service.ts`, `src/utils/{discord,discordPolls,discordRoomFilter,discordWriteTarget,callouts,calloutBuiltins}.ts`, `admin-ui/src/components/{CalloutsCard,ChatResponsesSettings}.tsx`.

- **E1** `ready` `/submit-score` through the one resolver — game by `SubmissionGameResolver` (the two-active-same-name bug is alive here) and the auto-map through `IdentityClaimService.claim` (alias cap + audit) instead of writing `user_mappings` directly · tier: 2 · spec: ROADMAP.md §"Identity" + SPRINT_STATUS.md #137 item 5 · touches: src/services/IdentityClaimService.ts
- **E2** `ready` Autocomplete deadline + `/list-scores` embed cap — per-room 60 s snapshot cache of the candidate rows for `/view-stats`, `/pick-game` and the other autocompletes, 40060 downgraded to WARN, `/list-scores` chunked past 10 active games · tier: 2 · spec: ROADMAP.md §"[HARDENING] `/list-scores`", §"[HARDENING] `/view-stats`" and §"[HARDENING, unproven-diagnosis] `/pick-game` autocomplete snapshot cache"
- **E3** `idea` Guild-implies-membership for cross-room read commands — per-command membership check instead of the blanket approval-room exclusion · tier: 7 · spec: ROADMAP.md §"Guild-implies-membership"
- **E4** `idea` Shared-board (c) `/reorder-lineup` scope unified with `resolveGuildReadScope`; (d) `/my-stats` in a DM wants an explicit "all my rooms" mode · spec: ROADMAP.md §"[SHARED-BOARD FOLLOW-UPS" (c)(d)
- **E5** `done 2.120.1` Discord bot multi-room (Phase 5) via guild-scoped slash commands
- **E6** `done 2.120.2` Multi-room residue — `StatsService` stats and the five tournament/game autocompletes are guild-scoped

## F. iScored bridge (tolerated legacy; don't promote, don't break)

Lane: `src/engine/{IScoredApiClient,IScoredClient,IScoredNotificationGate,IScoredSessionRegistry,ScoreSyncPoller}.ts`, `src/services/{IScoredReconcile,IScoredSnapshot,IScoredSubmitSync}Service.ts`, `src/utils/{iscoredCreds,iscoredGameNames,iscoredScores}.ts`, `src/discord/commands/{syncstate,mapuser,reorderlineup}.ts`, `admin-ui/src/components/IScoredSnapshotRestoreModal.tsx`.

- **F1** `ready` Shared-board follow-ups — (a) cleanup mode `never` as a first-class rule, (b) per-room `ISCORED_LOCK_ON_COMPLETE` toggle, (c) `createGame` "already on the board" guard (adopt the existing id) + an idempotent retry wrapper (Clown Deluxe duplicate) · tier: 2 · spec: ROADMAP.md §"[SHARED-BOARD FOLLOW-UPS" (a)(b) + §"[HARDENING] `createGame`"
- **F2** `idea` Delete-on-iScored per-score cascade — amends ADR 0011 (its "no per-score API" premise is wrong: `deleteScore` on `data-topscoreid`): `IScoredClient.deletePlayerScore` from both delete endpoints; the suppression-clear admin route and UI already exist (`rooms.ts` `/admin/games/:gameId/suppressions`) · tier: 7 · spec: ROADMAP.md §"Delete-on-iScored" + §"iScored per-score delete"
- **F3** `idea` Sync hardening — `/sync-state` creates ACTIVE rows past cooldown (create LOCKED, option c) and past `max_active_games` · tier: 7 · spec: ROADMAP.md §"iScored Sync Hardening"
- **F4** `idea` Poller — adaptive backoff after 5 consecutive failures, fetch-agent reset on the Nth failure, tunable API timeout in Global Settings · tier: 7 · spec: ROADMAP.md §"ScoreSyncPoller adaptive backoff" and the two entries after it
- **F5** `idea` Alias tooling — `/unmap-user`, pure-iScored-name claim form for admins, one-shot DM at merge · tier: 7 · spec: ROADMAP.md §"`/unmap-user`" and the two entries after it · touches: src/services/MergeService.ts
- **F6** `done 2.155.6` Cleanup archives games that were never on iScored (the weekly-cleanup orphan)

## G. Room settings, admin UI structure, a11y, PWA

Lane: `src/services/{GameRoom,GameRoomSettings,Settings,RoomEvent,Dashboard,LobbyFeed,LobbyFeedGenerator,CommunityShelf}Service.ts`, `src/utils/{roomTimezone,themeIds,terminology,publicLinks}.ts`, the settings handlers in `src/api/routes/{rooms,admin}.ts`, `admin-ui/src/pages/{Settings,GlobalSettings,Dashboard,SuperAdminDashboard,Lobby,LobbyAdmin,Help,GameRoomManager,CreateRoom,MyRooms,LandingPage,Terms}.tsx`, `admin-ui/src/components/{RoomAdminLayout,PublicLayout,SuperAdminLayout,ThemeProvider,ThemePicker,AppearanceControl,UpdateNudgeBanner,DevicePreviewFrame,DisplaySettingsHost}.tsx`, `admin-ui/public/**`.

- **G1** `done 2.164.0` Room default timezone (`ROOM_TIMEZONE` seeds and labels every admin time control; one precedence chain in `src/utils/roomTimezone.ts`)
- **G2** `ready` [QUICK] Room Settings "Admin Role ID" has had no reader since f904986b3 — drop it from `Settings.tsx`'s Discord group, the per-room key list in `database.ts`, Help (two mentions) and the `GameRoomManager.tsx` setup copy, or actually read it; copy should say "server Administrator permission" · spec: ROADMAP.md §"[QUICK] Room Settings still shows"
- **G3** `idea` Room Settings page reorganisation — tabs/sections (Appearance / Access & Privacy / Integrations / Advanced) vs a settings search vs sibling pages; decide which cards leave Settings (Users duplicates Members; Platforms is library config) · tier: 5 · spec: ROADMAP.md §"Room Settings page reorganisation"
- **G4** `idea` `KIOSK_KEY` pairing so a physically-secured kiosk can show an approval room; no ad-hoc bypasses meanwhile · tier: 7 · spec: ROADMAP.md §"Kiosk mode on approval rooms"
- **G5** `idea` S20 a11y deferred items — `confirm()`/`alert()` → ConfirmModal/toast in four pages, dialog semantics + focus traps on ~15 modal shells, the `window.prompt` report reason, 320 px nav fallback · tier: 7 · spec: ROADMAP.md §"S20 a11y deferred items"

## W. Witness and Castcade integration

Lane: `src/services/{Witness,WitnessVerify,WitnessEvidence,VpxScoreIngest,EventLobby,AtGamesEventSync}Service.ts`, `src/api/routes/integrity.ts`, the `/api/witness/*` routes in `src/api/routes/global.ts`, `src/utils/sanctionedRules.ts`, `scripts/witness-agent.ts`, `admin-ui/src/components/{IntegrityPanel,IntegrityChip,EventLobbyRoster}.tsx`, `admin-ui/src/components/lobby/**`, `admin-ui/src/lib/{lobbyStatus,provenanceDisplay}.ts`, `docs/vpx-desktop-witness-plan.md`. The desktop producer lives in castcade (ADR 0003); castcade `WORK.md` section F mirrors this section. Item numbers are castcade `docs/arcaid-side-changes.md`.

- **W1** `done 2.160.0` VPXS-on-ALP score ingestion arc 1 (2.151.0, ADR 0022, field-proven round 5), check-in lobby (2.159.0), heartbeat + restarts/partial (2.160.0)
- **W2** `done 2.163.0` Item 1: desktop device type on `witness_devices`; provenance follows the type (#363)
- **W3** `done 2.163.0` Item 9: desktop-witness plan amended — producer lives in Castcade, import-a-table primary (#364)
- **W4** `done 2.166.0` Item 11: integrity mode Open / Sanctioned (ADR 0027; #370 = 2.165.0 backend + migration 185 flushing the stale `leaderboard_cache`; #371 = admin UI, evidence review, board badges, `play_device` VR badge)
- **W5** `ready` Item 10: room admin's live device view — every reporting device of a room member: player, type, online, last check-in, table open now, where its scores route; the event lobby from the runner's side; polled or pushed on `room:<roomId>` · spec: arcaid-side-changes.md §10
- **W6** `ready` Item 12: script baseline upload per Sanctioned game, `GET /api/witness/preflight` verdict before ball one, `script_diff` on the score, runner review of classified hunks, `diff_reports_visible_to` · needs: W4 · spec: arcaid-side-changes.md §12 (companion half = castcade B5)
- **W7** `ready` Item 13: runner stage — `live` state on the heartbeat, "Feature this player", `featured` in the check-in reply, `/stage/:tournamentId` for the runner's OBS · spec: arcaid-side-changes.md §13 (feed relay = castcade D3)
- **W8** `ready` Items 2–8: the Castcade Phase 3/5 server side · spec: arcaid-side-changes.md §2–§8
  - **W8.1** `ready` Item 8: table-readiness registry = the GLOBAL scorability table (manifest `romVersion` × maps corpus, corrected by witness scores and per-slug blank-record signals; `witness_live_ready` / `castcade_ready` / `unsupported`) · needs: C1 · spec: ROADMAP.md §"VPX score ingestion" + §8
  - **W8.2** `ready` Item 2: `tournaments.play_mode` (`score` | `castcade`), one round, catalogue game, roster required
  - **W8.3** `ready` Item 3: roster invite/accept on `tournament_participants` (`source='invite'`); gate on membership when `play_mode='castcade'` — this IS the Duels roster (A11)
  - **W8.4** `ready` Item 4: `join:match` + `match:relay` opaque relay in `websocket.ts`, rate-limited, roster-checked
  - **W8.5** `ready` Item 5: `source='castcade'` via `rebuildScoreHistorySource`, `castcade_matches` table, `witness_devices.public_key`
  - **W8.6** `ready` Item 6: `RESULT` ingest with N signatures — mismatch is stored and badged `flagged`, never rejected · needs: W8.5
  - **W8.7** `ready` Item 7: ArcAid ADR "Castcade matches are Throwdowns" (next free number 0029; castcade `arcaid-side-changes.md` §7 updated 2026-10-21) · needs: W8.2
- **W9** `done 2.158.0` Cabinet ingest follow-ups from the 1.0.x field runs — exit samples verify or stay neutral, never flag (migration 179); `recordGlobal` prefers the exact journal display name; the ADR 0022 addendum moved to H3
- **W10** `done 1.0.4` Cabinet Witness 1.0.4 kit — Defect F (any token VALUE change runs the catch-up; failed sends retried after 60 s), heartbeat every 120 s, the four exit-sample files as a harness target; SDK image rebuilt, built + harness-passed 2026-10-21 (`tmp/witness-build/arcaid-witness-kit-v1.0.4.zip`, buildlogs/v1.0.4-*.log); owner step: bench on the Micro, send to ChalataLove · spec: SPRINT_STATUS.md #152–#153 · touches: tmp/witness-build/** (gitignored)
- **W11** `idea` Quiet-cabinet nudge (a designated cabinet that has not checked in as the round opens) · spec: SPRINT_STATUS.md #149
- **W12** `idea` Item 11, the part left out of 2.166.0: ROM→VPS game map `GET /api/witness/roms` seeded from VPS so the companion can stop shipping the seed (castcade B8/F8) · spec: castcade docs/arcaid-side-changes.md §11
- **W13** `review #373` No integrity badge for a witness score that carried no evidence (2.166.2) — a cabinet score in Open play was stored `flagged: no evidence` and drawn as a red Flagged chip; `badgeVerdict` withholds the stored verdict for a cabinet (any evidence it sends is stored, not judged by the desktop rules) and for a desktop with no evidence; Sanctioned gate and refusal trail unchanged · needs: W4 · gate: cabinet + desktop scores on one Open-play board, cabinet rows chip-less

## X. Ops, infra, deploy, dependencies, tests, tech debt

Lane: `Dockerfile`, `docker-compose*.yml`, `.github/**`, `package*.json`, `admin-ui/package*.json`, `admin-ui/{vite,vitest,eslint}.config.*`, `src/database/**`, `src/engine/BackupManager.ts`, `src/services/{Backup,OpsAlert,Log,MaintenanceRun,Audit}Service.ts`, `src/utils/{backgroundTasks,secrets,secretsMigration,startup,config,logger,version}.ts`, `src/__tests__/**`, `admin-ui/src/__tests__/**`, `admin-ui/src/test/**`, `scripts/{provision-server.sh,generate-*,reset-password}.ts`, `docs/runbooks/**`, `docs/infrastructure-improvement-plan.md`.

- **X1** `ready` [T0, ~1 h] Deploy safety net — `ARCAID_TAG` parameterised in `/opt/arcaid/docker-compose.yml`, `arcaid.db` snapshot between `compose stop` and `compose up` (keep 20), `docs/runbooks/rollback.md` · spec: docs/infrastructure-improvement-plan.md
- **X2** `idea` [T1] UAT box `uat.arcaid.app` — sanitised nightly clone of the `VACUUM INTO` backup, separate Discord Application and secrets, force-pushable `uat` branch; trap: branch the image tag + SSH target on `github.ref` first or WIP deploys to prod · needs: X1 · spec: docs/infrastructure-improvement-plan.md
- **X3** `ready` [T2] Local loop with a dedicated Discord Application — the only way the Scheduler (crons, `EventScheduler.tick`) runs locally at all · spec: docs/infrastructure-improvement-plan.md F1
- **X4** `ready` [T3] `ARCAID_ENV` outbound guards at the six edges (announce / DM / push / iScored submit / iScored session / AtGames) + a visible non-prod banner · spec: docs/infrastructure-improvement-plan.md
- **X5** `ready` [T4] Reconcile or delete the drifted `docker-compose.prod.yml` (server copy has `init: true` + healthcheck) · spec: docs/infrastructure-improvement-plan.md
- **X6** `ready` Vendor the sqlite3 prebuilt into the Docker build cache so a deploy never depends on GitHub's CDN (failed twice 2026-08-12); test with egress to github.com blocked · tier: 2 · spec: ROADMAP.md §"[OPS HARDENING]"
- **X7** `ready` Flaky tests — `PinnedCarousel` tabindex assertions inside the `waitFor`; the community-scores-attribution nested-transaction family (a recurrence means a NEW untracked fire-and-forget chain); `PicksQueueTabs` 1 s wait if it flakes again · tier: 2 · spec: ROADMAP.md §"Flaky test"
- **X8** `ready` Lint in CI + the admin-ui backlog — 303 errors on main since the react-hooks plugin bump in #266 (CI does not lint); burn down first (real typing work + the `setState`-in-effect in `Tournaments.tsx`), then add `eslint .` to the test job · tier: 7 · spec: ROADMAP.md §"Enforce lint in CI"
- **X9** `blocked upstream` admin-ui TypeScript 7 — Dependabot #165 closed 2026-10-21 (re-proposed on the next release); `typescript-eslint` peer-pins `typescript <6.1.0`; never `--legacy-peer-deps`; budget a TS7 compile hurdle after it clears · spec: ROADMAP.md §"Dependabot #165"
- **X10** `blocked upstream` admin-ui jsdom 30 — Dependabot #164 closed 2026-10-21: jsdom 30 fails the admin-ui suite on a fresh rebase; take the next jsdom release only with the suite green · spec: LAUNCH.md "Now — this week"
- **X11** `idea` Tech-debt cleanups, each its own small PR · tier: 7
  - **X11.1** `idea` Style overlay re-keying onto `room_game_style_overlay`, then retire `game_room_game_library` · spec: ROADMAP.md §"Style overlay re-keying"
  - **X11.2** `idea` Ratings re-keying `game_ratings` onto `(global_game_id, user_id)` (still name-keyed after migration 139) · spec: ROADMAP.md §"Ratings re-keying" · touches: C3
  - **X11.3** `idea` Retire `game_rooms.discord_guild_id` (delete `getByGuildId`, drop the anon branch, migration) · spec: ROADMAP.md §"[CLEANUP] Retire"
  - **X11.4** `idea` Portal endpoint triplication — delete the dead `server.ts` handler, align the rooms.ts shape additively · spec: ROADMAP.md §"Portal endpoint triplication"
  - **X11.5** `idea` Drop `user_mappings.avatar_hash` — first move the two remaining readers (`rooms.ts` portal query, `GlobalCommentService`) onto `user_profiles.avatar_hash` · spec: ROADMAP.md §"Drop `user_mappings.avatar_hash`"
  - **X11.6** `idea` Remove `@types/sqlite3` + `@types/uuid`; regenerate lockfiles inside a Linux container · spec: ROADMAP.md §"Remove redundant `@types/sqlite3`"
  - **X11.7** `idea` `MergeService` re-checks `MAPPING_CONFLICT` inside the transaction · spec: ROADMAP.md §"`MergeService` mapping race-condition"
  - **X11.8** `idea` Decouple the Playwright browser from the base image (`npx playwright install --with-deps chromium` in the prod stage) — the skew is live today: base `playwright:v1.62.1-noble`, npm `playwright` 1.64.1 · spec: ROADMAP.md §"Decouple Playwright browser version"
- **X12** `idea` Infra when scale demands — automated backup schedule, monitoring/alerting, server metrics on the super-admin dashboard, HA path (active-passive + Litestream → PostgreSQL) · tier: 7 · spec: ROADMAP.md §"Ops / Infrastructure"
- **X13** `done 2.24.1` `trackBackground()` registry drains fire-and-forget chains before each test DB reset (closed the nested-transaction flake family)

## L. Launch closeout (owner-timed)

Lane: `src/scripts/wipe-test-scores.ts`, `docs/runbooks/restore.md`, root `package.json` version. Order agreed 2026-08-09: restore drill → score wipe → version reset → go. The LAUNCH preamble's unmade decision: sealed-bid (A10) and Share-to-Arcaid (B19) are ranked post-launch; if the owner rules them gates they move to the top of tier 3.

- **L1** `ready` Backup restore drill — restore a backup off-hours and rehearse the wipe script against the restored copy in the same session · tier: 6 · spec: docs/runbooks/restore.md
- **L2** `ready` Pre-launch data wipe — keep ALL rooms, games, settings, styles, members; zero `submissions`, `score_history`, `community_scores`, `global_scores`, leaderboard + ranking caches, lobby feed score events; full DB + assets backup first; verify caches rebuild; the very last step before go · tier: 6 · needs: L1 · spec: LAUNCH.md tier 6
- **L3** `ready` Public version reset — root `package.json` → 0.90.0 Beta, → 1.0.0 at GA (`/api/version`, Help footer, Dashboard health card) · tier: 6 · needs: L2
- **L4** `idea` Owner call: do A10 and B19 gate launch, or ship post-launch as ranked · spec: LAUNCH.md preamble

## P. Platform integrations and parked ideas

Lane: none yet (nothing in code). Parked by owner ruling or for want of a counterpart; do not promote without a ruling.

- **P1** `parked` IFPA sanctioning — REAL PINS ONLY (owner 2026-09-05); results are a manual web form, league rules exclude the rotation-window model · tier: 7 · spec: ROADMAP.md §"Competitive-gap sequence" (tabled paragraph)
- **P2** `parked` Matchplay.events interoperability · tier: 7 · spec: ROADMAP.md §"Platform Integrations"
- **P3** `parked` Scorbit capture from connected real machines · tier: 7 · spec: ROADMAP.md §"Platform Integrations"
- **P4** `parked` Stern Insider Connected sync — nothing to build until Stern says yes · tier: 4 · spec: ROADMAP.md §"Competitive-gap sequence" item 5
- **P5** `parked` Guilded / Revolt community platforms · tier: 7 · spec: ROADMAP.md §"Platform Integrations"
- **P6** `parked` Streaming — lives in Castcade: Phase 4a solo streaming + OBS browser-source overlay (castcade D1), runner stage = W7 + castcade D4; nothing ArcAid-side beyond W7 unless a room without companions asks for a board overlay · spec: castcade docs/design/arcaid-integration-gap-analysis.md §6 "4a"

## H. Docs and process

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`, `LAUNCH.md`, `SPRINT_STATUS.md` (archives).

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0028), 2026-10-21
- **H2** `done` Archive banners on `ROADMAP.md`, `LAUNCH.md`, `SPRINT_STATUS.md` pointing here; `CLAUDE.md` session-start order and `C:\code\repos\CLAUDE.md` update cadence rewritten for `WORK.md`, 2026-10-21 · needs: H1
- **H4** `idea` Mark the remaining archive references as historical — `docs/FEATURES.md` intro (v2.30.2, "compiled from SPRINT_STATUS/ROADMAP") and the "do not touch SPRINT_STATUS/ROADMAP" instructions in `docs/contracts/*`; low value, do it when touching those files
- **H3** `ready` ADR 0022 addendum — 0-point flush marker, exit samples never flag, strict resolver, record = sitting or game, replay floor, check-in lobby + heartbeat (code shipped 2.155.4–2.160.0, W9/W1) · spec: SPRINT_STATUS.md #147–#153
- **H5** `idea` CHANGELOG gaps found 2026-10-21 — 2.112.0 lists only the AtGames importer (identity claims P1/P4 #243/#244 and the link-nudge banner #242 are missing); 2.160.0 claims the cabinet 1.0.4 kit was built (it was not, W10); 211 version headings still read "— unreleased" (the suffix was never replaced at release)
