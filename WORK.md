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
- Next by LAUNCH tier — tier 1: C1 manifest adoption, B1 "Also count this score in…", B2 cheap parity riders · tier 2: B3 Room Scores card art bug, E1 Discord `/submit-score` through the shared resolver.
- Newest owner ask: B7 Room Stats page (2026-10-20).
- Witness/Castcade: W5 live device view and W6 script baseline + preflight are the next ArcAid-side items; Castcade is on F4/F5 (companion 0.2.10).
- Blocked: X9 admin-ui TypeScript 7 (upstream typescript-eslint peer range).
- Last wrap: 2026-10-21 (tracker introduced; ROADMAP.md, LAUNCH.md and SPRINT_STATUS.md are frozen as archives).

## A. Tournaments, rotation, seasons, picks, queue

Lane: `src/engine/**`, `src/services/{Tournament,PickQueue,PickDisposition,PickAward,PickAlert,SeasonPoll,RotationAudit,RotationNudge,QueueLowNudge,Event,EventResult,EventSubmissionGate,Throwdown,ThrowdownScore}Service.ts`, `src/utils/{cooldown,pickWindow,queueOrder,cronUtils,tournamentMode}.ts`, `admin-ui/src/pages/{Tournaments,TournamentDetail,Picks,GameStates,EventDetail,ThrowdownDetail,MysteryAwardPage}.tsx`, `admin-ui/src/components/{TournamentForm,SeasonPanel,SeasonPollCard,RotationLogPanel,ScheduleBuilder,Event*,Throwdowns*,AdminPickOnBehalf,PickGameModal}.tsx`.

- **A1** `done 2.162.0` Season format (ADR 0025, 2.161.0) + Pick by poll as a rotation method (ADR 0026); demo checklist items 1–11 prod-verified 2026-10-20
- **A2** `done 2.164.0` SeasonScheduler cosmetic follow-ups from #161 (empty-draft WARN once per draft; "chose X over (none)" copy) rode with the room timezone
- **A3** `claimed` Configure GamerDad89's real Season in mox_s_vpx_tournaments — set the room zone to America/New_York FIRST, then cron `0 0 * * 5`, 12 tables, Pick by poll on, Countdown points_top 50, own announce channel, bot re-invite `permissions=562949953506304` (check the guild perms first) · owner: owner · since: 2026-10-20 · spec: SPRINT_STATUS.md #162–#163
- **A4** `idea` Season polish — Cooldown Days default when Pick by poll is switched off; "posts immediately" instead of a past Opens time on the Season panel; a repost-keeping-Arcaid-votes variant if Mox ever needs to extend an open poll · spec: SPRINT_STATUS.md #156–#159
- **A5** `done 2.146.0` Rotation audit trail — "Rotation log" panel on Game States (ids resolved to names 2.157.1)
- **A6** `ready` One-time cooldown override — queue an in-cooldown table as HELD, **Queue and wait** / **Queue + request override**, admin Approve/Deny in the announce channel + an admin queue, grant consumed on activation; `pickHeld` + `overrideRequest` notifications, per-tournament `COOLDOWN_OVERRIDES_ENABLED` · tier: 3 · spec: ROADMAP.md §"One-time cooldown override"
- **A7** `ready` Queue UX overhaul, remainder — newest-first shipped 2.143.0; owner wants mockups before build · tier: 3 · spec: ROADMAP.md §"Queue UX overhaul"
  - **A7.1** `ready` Group "Your Picks" by tournament with filter tabs (cross-tournament arrows are meaningless today)
  - **A7.2** `ready` Drag-and-drop reorder within a group + per-row "send to top"; arrows stay as fallback
  - **A7.3** `done 2.166.1` Tournament selector first on the Picks page (#354)
  - **A7.4** `ready` Echo the tournament name in the queue-confirmation toast
- **A8** `ready` Cooldown "variant" rule — the bare name-prefix match is applied three ways at four sites (engine, availability list, `cooldownDaysRemaining`, autopick); pick one rule (exact + curated suffix list likely), one helper, one test · tier: 2 · spec: ROADMAP.md §"[DESIGN] Cooldown"
- **A9** `ready` Archive-time photo purge is keyed on (game name, room), not the archived game — scope the SELECT/UPDATEs to `submitted_during_tournament_id` / `game_id`; test with the same table ACTIVE in a sibling tournament · spec: ROADMAP.md §"[HARDENING] Archive-time photo purge"
- **A10** `ready` Sealed-bid tournaments — scores hidden until a fixed offset before `end_date` (default 1 h) or admin "Reveal now"; one read-time `SealedTournamentGate` at ~15 leak sites, never baked into a cache; requires an end date; owner call open on iScored rooms (recommend: honest on native rooms + admin warning) · tier: 3 · spec: ROADMAP.md §"Sealed-bid tournaments"
- **A11** `ready` Duels — challenge/accept 1v1 with a clock, matchmaking on VPS id; Throwdown is the seed (~80% of the plumbing); clean-run integrity tier lives INSIDE duels (desktop: NVRAM game-count deltas; ALP: window-only, labelled); room boards stay badge-never-gate · tier: 4 · spec: ROADMAP.md §"Competitive-gap sequence" item 3 · touches: W8.3 (the roster is shared)
- **A12** `ready` Strikes knockout — a new `EventSubmissionGate` caller + a new "the score counts" definition + freeze/reverify/standings/correction surfaces; run A11 once with a real room first · tier: 4 · needs: A11 · spec: ROADMAP.md §"Competitive-gap sequence" item 4
- **A13** `idea` Private room-scoped tournaments — owner spec 2026-08-07, largely absorbed by Throwdowns; confirm what remains for the hosted case before designing · tier: 5 · spec: LAUNCH.md tier 5
- **A14** `idea` Picks page richer available-games list — image/logo, mfg·year, availability, last-played + cooldown, pick frequency, rating; the whole entry opens `GameQuickView` with "View full game page"; natural home for the My Tables filter (C2); screenshot loop · tier: 5 · spec: ROADMAP.md §"[UI ARC] Picks page redesign"
- **A15** `done 2.141.0` Tournament Events & Throwdowns arc (2.135.0 → 2.141.0, ADRs 0017/0018); P8 became the Arcaid Witness (W1)

## B. Scores, submission, leaderboards, Global Scoreboard, cards, styles, stats

Lane: `src/services/{ScoreHistory,ScoreRank,ScoreProvenance,ScoreReport,CommunityScore,RoomScores,TournamentScores,Leaderboard,GlobalLeaderboard,GlobalScore,GlobalPin,Ranking,Stats,Milestone,Achievement,SubmissionContext,SubmissionDraft,SubmissionGameResolver,StyleCatalogue,StyleProfile,CardOrder,AutoScoreSuppression}Service.ts`, `src/utils/{bgFraming,scoreProvenance,submissionAttribution,scorePhotoCleanup}.ts`, `admin-ui/src/components/scoreboard/**`, `admin-ui/src/pages/{Scoreboard,KioskScoreboard,Leaderboard,GlobalScoreboard,GlobalGameDetail,GameDetail,ScoreSubmit,Rankings,RankingsFullStandings,PublicStats,Stats,MyStats,History,PublicHistory,StyleCatalogue,ComparePlayers,PlayerDetail}.tsx`, `admin-ui/src/components/{SubmissionSheet,ScoreCardGrid,ScoreHistoryChart,ScoreboardTicker,StyleProfiles,StyleUploadForm,ScorePhotoModal,CorrectScoreModal,ProvenanceTags,SourceChip,Global*}.tsx`.

- **B1** `ready` "Also count this score in…" — one play counts in every tournament running that table: post-submit checkboxes, cloned `score_history` rows linked by `same_play_of` with no side effects, a ten-minute server-side auto-link, migration links the 3 backfilled rows; needs its own ADR (0024 went to auto-posted deletes) · tier: 1 · spec: SPRINT_STATUS.md #137 · touches: src/services/VpxScoreIngestService.ts (W lane, same submit routes)
- **B2** `ready` Cheap parity riders, each its own small release · tier: 1 · spec: ROADMAP.md §"Competitive-gap sequence" item 1
  - **B2.1** `ready` Herb-format overall ranking (iScored's standard cross-table formula)
  - **B2.2** `ready` Broadcast popup — an admin message pushed to every open leaderboard/kiosk
  - **B2.3** `ready` Streak/variety achievements relayed from the launcher's `achievements.json` unlocks, not recomputed
- **B3** `ready` [BUG] Room Scores tab cards miss their style-catalogue background art — the name-keyed card path skips the overlay resolution the Tournaments view does · tier: 2 · spec: ROADMAP.md §"RTX demo feedback"
- **B4** `done 2.95.2` Lock indicator visible from across the room (RTX demo [QUICK])
- **B5** `ready` Submit-moment rank on PINNED iScored-bridged games ignores synced rivals — rank against the rows `LeaderboardService` renders for pinned games; regression test beside the Jaws fixture in `scoreRank.test.ts` · tier: 2 · spec: ROADMAP.md §"[QUICK] Submit-moment rank"
- **B6** `ready` Global Scoreboard sort/density strip overflows phones (479 px on a 390 px viewport) — scroll the strip inside its own container or collapse to a dropdown · tier: 2 · spec: ROADMAP.md §"Global Scoreboard sort/density strip"
- **B7** `ready` Room Stats — a third tab on `PublicStats`: most selected tables (picker-attributed), highest rated room vs global, tables played lifetime + activations, per-tournament breakdown; one cached `GET /:roomId/stats/room`; names via `resolveUserLabels` (owner-asked 2026-10-20) · spec: ROADMAP.md §"Room Stats"
- **B8** `done 2.124.0` Leaderboard settings consolidation C1–C3 (2.116.0 / 2.119.0 / 2.124.0; `StylePicker.tsx` deleted)
- **B9** `idea` Room scoreboard revamp, phases 2–3 — direction not picked · tier: 5 · spec: ROADMAP.md §"Room scoreboard revamp"
  - **B9.1** `done 2.106.0` Arcade card style (phase 1): the Global card language as a fourth `SCOREBOARD_STYLE`
  - **B9.2** `idea` Room page layout modernization — 3-col grid, hero board, "My Score" density mode
  - **B9.3** `idea` Proof photos: clicking the score cell opens the proof photo (deferred until the row layout settles)
- **B10** `idea` Player-selectable Global Scoreboard card style — prefs plumbing fits; the work is an adapter from `TopGame` into the card system · spec: ROADMAP.md §"Player-selectable Global Scoreboard"
- **B11** `idea` Power-user custom cards ("go to town") — token editor first, slot/layout editor second, never freeform CSS; after style profiles decide where a look lives · tier: 5 · spec: ROADMAP.md §"Power-user card + leaderboard customization"
- **B12** `idea` Score comments + voting + flagging — anchor via `score_history_id` on `game_comments` (no third store), opt-in Discord cross-post, upvotes + Top sort, report → mod queue; Discord-authed only · tier: 5 · spec: ROADMAP.md §"Score comments" · touches: src/services/{Comment,CommentReport}Service.ts
- **B13** `idea` Mobile scoreboard polish batch — larger score-row defaults, avatar + name grouped, QR never on phone viewports; screenshot loop · spec: ROADMAP.md §"[UI] Mobile scoreboard polish"
- **B14** `idea` Admin ScoreboardPreview can't simulate mobile — move the `@media` rules to a class + a "Phone (375px)" toggle; `GlobalScoreboard`'s local card never inherited S20/S21 · spec: ROADMAP.md §"Admin ScoreboardPreview"
- **B15** `idea` Score photo persistence — S3/CDN, placeholder instead of 404, photos in the backup volume, persist iScored CDN photos at sync, copy room photos at fan-out · tier: 7 · spec: ROADMAP.md §"Score Photo Persistence"
- **B16** `idea` Submission-draft commit honours the guest-typed name past the username lock — needs a design decision (resolve-and-still-sweep-by-typed-name) · spec: ROADMAP.md §"Submission-draft commit"
- **B17** `idea` Guest multi-name collapse on the community leaderboard — nothing to collapse on; admin merge stays the remedy · spec: ROADMAP.md §"Guest multi-name collapse"
- **B18** `ready` AW badge contrast on light themes (site-wide, pre-existing; found in the 2.157.0 review) · spec: SPRINT_STATUS.md #148–#149
- **B19** `ready` Share-to-Arcaid — ONE core: a `/share` orphan-photo landing with room + game chooser feeding `SubmissionSheet` through `normalizePhotoFile`; doorways in order: Paste button → Android `share_target` + SW POST intercept → iOS Shortcut only if still wanted · tier: 3 · spec: ROADMAP.md §"Share-to-Arcaid" · touches: admin-ui/public/{manifest.json,sw.js}

## C. Catalogue, importers, library, My Tables, availability facts

Lane: `src/services/{Vps,Wizard,AtGames,SteamPinball,FxVr,OPDB,IGDB,RA}*.ts`, `src/services/{GlobalGame,GameLibrary,GameFeedback,SyncLog,Rating,GlobalRating,Comment,GlobalComment,RoomGameTags,RAMasterList}Service.ts`, `src/utils/{catalogueUtils,platformMapping,platformRules,searchRank}.ts`, `src/api/raCatalogueHandlers.ts`, `scripts/{reimport-catalogue,backfill-*,analyze-catalogue,ipdb-check}.ts`, `src/scripts/merge-zaccaria-atgames-dupes.ts`, `admin-ui/src/pages/{GameLibrary,GlobalCatalogue,CatalogueApproval}.tsx`, `admin-ui/src/components/{PlatformChips,GameQuickView,GameInfoModal,RAGameSearch,StarRating}.tsx`.

- **C1** `ready` Manifest adoption — replace `WizardImportService`'s README scrape with a structured pull of Legends Unchained's `manifest.json` (slug, VPS id, checksum, designers, players, mfg, year) linking `global_games.vps_id`; then the cabinet ingest matches on slug and records `tableChecksum`; seeds the scorability table (W8.1) · tier: 1 · spec: ROADMAP.md §"Competitive-gap sequence" item 1 · touches: src/services/VpxScoreIngestService.ts
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
- **D3** `idea` P3 photo-verified promotion of synced scores to Global — amends ADR 0016 P2 §3c; open: retroactive or forward-only, what counts as verified, missing engine/device · tier: 7 · spec: ROADMAP.md §"Identity" P3
- **D4** `idea` "Pull all my AtGames personal bests onto Global" — no stored AtGames credential and Global excludes non-witnessed scores; first cut = public top-5 scan gated by `share_to_global` once AtGames-native scores are admitted · spec: ROADMAP.md §"Identity" [FEATURE, owner-asked 2026-08-27]
- **D5** `idea` Rooms without `REQUIRE_SCORE_PHOTO` may not fan out to Global (owner 2026-08-17; inert today) — grandfather existing rows · spec: ROADMAP.md §"Identity"
- **D6** `ready` Self-edit / self-delete own comments (soft-delete via `deleted_at`, audited); legacy anon comments stay read-only · spec: ROADMAP.md §"Player Self-Service" B
- **D7** `idea` "My scores" / "My comments" management views (`/api/me/scores`, `/api/me/comments`) + a rate limit on self-corrections · spec: ROADMAP.md §"Player Self-Service" A
- **D8** `done 2.95.0` Bans arc — UI 2.44.0, room-tier 2.49.0, content cascade + DM 2.94.0, explicit `AuditService.log` sweep 2.95.0
- **D9** `idea` Automated content screening — async cheap-LLM pass that FLAGS new room names/descriptions to the queue (moderation layer 4; not launch-critical) · spec: ROADMAP.md §"Content moderation"
- **D10** `idea` Admin display-name override (super-admin, audited) · tier: 7 · spec: ROADMAP.md §"Admin display-name override"
- **D11** `idea` S12 privacy residuals — purge-by-age sweep of orphan staged proof photos; best-effort scrub of a deleted user's id inside third-party `lobby_feed_events.metadata` · tier: 7 · spec: ROADMAP.md §"S12 privacy residuals"
- **D12** `idea` Web push follow-ups — push-host allowlist, `turnToPick` type, "disable everywhere", subscription count on the health card, `pushsubscriptionchange` re-subscribe after VAPID rotation · tier: 7 · spec: ROADMAP.md §"Web push follow-ups"
- **D13** `idea` Notification coalescing — 3+ same-type DMs within 5 min → one summary · tier: 7 · spec: ROADMAP.md §"Notification coalescing"
- **D14** `idea` Discord link nudge, contextual placements — Picks page note ("no DM when it's your turn"); Discord toggles shown unavailable without a reachable Discord · spec: ROADMAP.md §"[QUICK] Discord link nudge"
- **D15** `done 2.48.0` First-login player tutorial (spotlight tour, `tutorial_seen_at`)

## E. Discord bot

Lane: `src/discord/**`, `src/services/{Announcement,Callout,ChatResponseSettings,DiscordNicknameResolver}Service.ts`, `src/utils/{discord,discordPolls,discordRoomFilter,discordWriteTarget,callouts,calloutBuiltins}.ts`, `admin-ui/src/components/{CalloutsCard,ChatResponsesSettings}.tsx`.

- **E1** `ready` `/submit-score` through the one resolver — game by `SubmissionGameResolver` (the two-active-same-name bug is alive here) and the auto-map through `IdentityClaimService.claim` (alias cap + audit) instead of writing `user_mappings` directly · tier: 2 · spec: ROADMAP.md §"Identity" + SPRINT_STATUS.md #137 item 5 · touches: src/services/IdentityClaimService.ts
- **E2** `ready` Autocomplete deadline + `/list-scores` embed cap — per-room 60 s snapshot cache of the candidate rows for `/view-stats` and `/pick-game`, 40060 downgraded to WARN, `/list-scores` chunked past 10 active games · tier: 2 · spec: ROADMAP.md §"[HARDENING] `/list-scores`" and §"[HARDENING] `/view-stats`"
- **E3** `idea` Guild-implies-membership for cross-room read commands — per-command membership check instead of the blanket approval-room exclusion · tier: 7 · spec: ROADMAP.md §"Guild-implies-membership"
- **E4** `idea` Shared-board (c) `/reorder-lineup` scope unified with `resolveGuildReadScope`; (d) `/my-stats` in a DM wants an explicit "all my rooms" mode · spec: ROADMAP.md §"[SHARED-BOARD FOLLOW-UPS" (c)(d)
- **E5** `done 2.120.1` Discord bot multi-room (Phase 5) via guild-scoped slash commands
- **E6** `idea` Multi-room residue — `StatsService.getGameStats` / `getPlayerStats` and the five tournament/game autocompletes are still cross-room · spec: ROADMAP.md §"Deferred"

## F. iScored bridge (tolerated legacy; don't promote, don't break)

Lane: `src/engine/{IScoredApiClient,IScoredClient,IScoredNotificationGate,IScoredSessionRegistry,ScoreSyncPoller}.ts`, `src/services/{IScoredReconcile,IScoredSnapshot,IScoredSubmitSync}Service.ts`, `src/utils/{iscoredCreds,iscoredGameNames,iscoredScores}.ts`, `src/discord/commands/{syncstate,mapuser,reorderlineup}.ts`, `admin-ui/src/components/IScoredSnapshotRestoreModal.tsx`.

- **F1** `ready` Shared-board follow-ups — (a) cleanup mode `never` as a first-class rule, (b) per-room `ISCORED_LOCK_ON_COMPLETE` toggle, (c) `createGame` "already on the board" guard (adopt the existing id) + an idempotent retry wrapper (Clown Deluxe duplicate) · tier: 2 · spec: ROADMAP.md §"[SHARED-BOARD FOLLOW-UPS" (a)(b) + §"[HARDENING] `createGame`"
- **F2** `idea` Delete-on-iScored per-score cascade — ADR 0011's "no per-score API" premise is wrong (`deleteScore` on `data-topscoreid`): `IScoredClient.deletePlayerScore` from both delete endpoints + an admin UI to clear a `deleted_score_suppressions` row · tier: 7 · spec: ROADMAP.md §"Delete-on-iScored" + §"iScored per-score delete"
- **F3** `idea` Sync hardening — `/sync-state` creates ACTIVE rows past cooldown (create LOCKED, option c) and past `max_active_games` · tier: 7 · spec: ROADMAP.md §"iScored Sync Hardening"
- **F4** `idea` Poller — adaptive backoff after 5 consecutive failures, fetch-agent reset on the Nth failure, tunable API timeout in Global Settings · tier: 7 · spec: ROADMAP.md §"ScoreSyncPoller adaptive backoff" and the two entries after it
- **F5** `idea` Alias tooling — `/unmap-user`, pure-iScored-name claim form for admins, one-shot DM at merge · tier: 7 · spec: ROADMAP.md §"`/unmap-user`" and the two entries after it · touches: src/services/MergeService.ts
- **F6** `done 2.155.6` Cleanup archives games that were never on iScored (the weekly-cleanup orphan)

## G. Room settings, admin UI structure, a11y, PWA

Lane: `src/services/{GameRoom,GameRoomSettings,Settings,RoomEvent,Dashboard,LobbyFeed,LobbyFeedGenerator,CommunityShelf}Service.ts`, `src/utils/{roomTimezone,themeIds,terminology,publicLinks}.ts`, the settings handlers in `src/api/routes/{rooms,admin}.ts`, `admin-ui/src/pages/{Settings,GlobalSettings,Dashboard,SuperAdminDashboard,Lobby,LobbyAdmin,Help,GameRoomManager,CreateRoom,MyRooms,LandingPage,Terms}.tsx`, `admin-ui/src/components/{RoomAdminLayout,PublicLayout,SuperAdminLayout,ThemeProvider,ThemePicker,AppearanceControl,UpdateNudgeBanner,DevicePreviewFrame,DisplaySettingsHost}.tsx`, `admin-ui/public/**`.

- **G1** `done 2.164.0` Room default timezone (`ROOM_TIMEZONE` seeds and labels every admin time control; one precedence chain in `src/utils/roomTimezone.ts`)
- **G2** `ready` [QUICK] Room Settings "Admin Role ID" has had no reader since f904986b3 — drop it from `Settings.tsx`'s Discord group, the per-room key list in `database.ts` and Help, or actually read it; copy should say "server Administrator permission" · spec: ROADMAP.md §"[QUICK] Room Settings still shows"
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
  - **W8.7** `ready` Item 7: ArcAid ADR "Castcade matches are Throwdowns" (next free number; 0025–0028 are taken) · needs: W8.2
- **W9** `ready` Cabinet ingest follow-ups from the 1.0.x field runs — `reason=exit_sample` → unwitnessed before a no-ROM table goes on an event card; `recordGlobal` prefers the exact journal display name before giving up (Halloween / Scooby `no_match`); ADR 0022 addendum (0-point flush marker, exit samples, strict resolver, record = sitting or game, replay floor) · spec: SPRINT_STATUS.md #147–#153
- **W10** `ready` Cabinet Witness 1.0.4 kit — Defect F (any token VALUE change runs the catch-up; failed sends retried after 60 s), heartbeat every 120 s, the four exit-sample files as a harness target; source edited, not built (needs the SDK Docker image rebuilt) · spec: SPRINT_STATUS.md #152–#153 · touches: tmp/witness-build/** (gitignored)
- **W11** `idea` Quiet-cabinet nudge (a designated cabinet that has not checked in as the round opens) · spec: SPRINT_STATUS.md #149

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
- **X9** `blocked upstream` Dependabot admin-ui TypeScript 7 (#165) — `typescript-eslint` peer-pins `typescript <6.1.0`; never `--legacy-peer-deps`; budget a TS7 compile hurdle after it clears · spec: ROADMAP.md §"Dependabot #165"
- **X10** `blocked X9` Dependabot admin-ui jsdom 30 (#164) — held with #165 per LAUNCH 2026-09-07; the hold's own reason is not recorded, re-check whether the PR is still open before releasing · spec: LAUNCH.md "Now — this week"
- **X11** `idea` Tech-debt cleanups, each its own small PR · tier: 7
  - **X11.1** `idea` Style overlay re-keying onto `room_game_style_overlay`, then retire `game_room_game_library` · spec: ROADMAP.md §"Style overlay re-keying"
  - **X11.2** `idea` Ratings re-keying `game_ratings` onto `(global_game_id, user_id)` · spec: ROADMAP.md §"Ratings re-keying"
  - **X11.3** `idea` Retire `game_rooms.discord_guild_id` (delete `getByGuildId`, drop the anon branch, migration) · spec: ROADMAP.md §"[CLEANUP] Retire"
  - **X11.4** `idea` Portal endpoint triplication — delete the dead `server.ts` handler, align the rooms.ts shape additively · spec: ROADMAP.md §"Portal endpoint triplication"
  - **X11.5** `idea` Drop `user_mappings.avatar_hash` once no readers remain · spec: ROADMAP.md §"Drop `user_mappings.avatar_hash`"
  - **X11.6** `idea` Remove `@types/sqlite3` + `@types/uuid`; regenerate lockfiles inside a Linux container · spec: ROADMAP.md §"Remove redundant `@types/sqlite3`"
  - **X11.7** `idea` `MergeService` re-checks `MAPPING_CONFLICT` inside the transaction · spec: ROADMAP.md §"`MergeService` mapping race-condition"
  - **X11.8** `idea` Decouple the Playwright browser from the base image (`npx playwright install --with-deps chromium` in the prod stage) · spec: ROADMAP.md §"Decouple Playwright browser version"
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
- **P6** `parked` Streaming integrations, Discord + Twitch — not scoped; cheapest first step is a browser-source overlay `/:slug/events/:id/overlay`; ask RTX what they run on stream nights first; the runner stage (W7) is the live-feed half · spec: ROADMAP.md §"Streaming integrations"

## H. Docs and process

Lane: `docs/**`, `.claude/**`, `WORK.md`, `CHANGELOG.md`, `CLAUDE.md`, `README.md`, `ROADMAP.md`, `LAUNCH.md`, `SPRINT_STATUS.md` (archives).

- **H1** `done` Single work tracker + board + `/work` and `/wrap` (ADR 0028), 2026-10-21
- **H2** `done` Archive banners on `ROADMAP.md`, `LAUNCH.md`, `SPRINT_STATUS.md` pointing here; `CLAUDE.md` session-start order and `C:\code\repos\CLAUDE.md` update cadence rewritten for `WORK.md`, 2026-10-21 · needs: H1
- **H4** `idea` Mark the remaining archive references as historical — `docs/FEATURES.md` intro (compiled from SPRINT_STATUS/ROADMAP) and the SPRINT_STATUS numbers cited in `docs/contracts/*`; low value, do it when touching those files
- **H3** `idea` ADR 0022 addendum rides with W9; `docs/decisions/README.md` row for the Castcade ADR rides with W8.7
