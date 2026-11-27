# Global Standings — Arcaid Points, friends, location and age boards (B32)

Status: design, 2026-11-27. Nothing is built. Owner rulings 2026-11-26/27 (section 2). Origin: LeonSpeegle's
"Additional Leaderboards" thread in the RTX Discord, 2026-11-24. Sister plan: `docs/run-recap-plan.md` (B31,
the run recaps); the two were planned together with the B31 session and share helpers (section 11).

Names marked **(new)** do not exist yet. Every other name was checked in the code on 2026-11-27. Each phase
gets its own implementation contract (in the style of `run-recap-plan.md`) when it is claimed; this file is
the design those contracts must follow, not the contract itself.

---

## 0. What Leon asked for, and what he needs

Leon listed five ideas:

| Leon's idea | What Arcaid has today | What is missing |
|---|---|---|
| Friends boards, like Steam / Zaccaria / Pinball FX | `friendships` (one-way follow), `FriendsService`, the Friends page | **No board filters to friends.** Follow is add-by-Discord-username only |
| Location / age / cat-vs-dog boards | Nothing (`user_profiles` holds a name and an avatar) | Optional profile fields and their privacy rules |
| Custom groups (an RTX-Men board, a Streamers board) | Rooms; the Global Scoreboard's room dropdown | The dropdown shows scores **posted in** a room (`origin_game_room_id`), not scores **by its members anywhere** |
| A "Global-Global" points ranking, IFPA-style, Witness only | Room Overall Rankings (`RankingService`: Max 10, PAPA, Countdown, best-N, competition ranks via `assignCompetitionRanks`) | No ranking across tables on the Global Scoreboard |
| All-time vs this year | Every board is all-time | A time window |

**The need under all five:** "I have no chance of ever topping the Global numbers, but I can go after my
friends' scores." Every slice Leon names shrinks the field until first place is reachable, and the time window
does the same over time (old freak scores stop blocking everyone). The design goal is therefore: **every player
has a board they can win, and a reason to come back to it.**

## 1. The model: one engine, four controls

```
board = WHAT is ranked     × WHO is in it          × WHEN          × WHICH scores
        one table (card)     everyone               all-time        All scores
        all tables (points)  friends                a year          Witness only
                             country / state        a month
                             birth decade
                             a group / a room's members
```

**The one rule: a filter narrows the list, it never re-scores it.** Arcaid Points are computed once per
(window × which scores × category); "Alabama, born in the 70s" is that global list cut to those players and
renumbered with competition ranks. A player's Alabama rank therefore always agrees with their global points,
and the cost is one cached computation plus cheap filters. The per-table boards work the same way: the
existing global per-card ranking, filtered, renumbered.

## 2. Owner rulings (2026-11-26/27)

| # | Ruling |
|---|---|
| R1 | Points formula: the recommendation in section 3. Players must be able to read how it works (explainer on the Standings page, the Help page, and the arithmetic on each player's own breakdown). |
| R2 | Flagged scores do not count in Witness only. The player is told the score was flagged and why, can fix their setup and replay, and can appeal to the global admin (the owner). **An appeal requires Arcaid Witness logs.** |
| R3 | AtGames scores count as machine-reported for standings (they are a player's best, which is what standings rank); they are not plays (B31's `machinePlay.ts`). |
| R4 | Location is country + state/province only. No zip code, no radius. |
| R5 | Age is stored as the **birth decade only**. No birthday or birth year is stored anywhere; the year a player types is converted on the way in and discarded. |
| R6 | Teams (cats vs dogs, maker rivalries) are dropped. |
| R7 | Two views: **All scores** and **Witness only** (that label). Photo and typed scores count in All scores only. |
| R8 | A flagged Witness score still counts in All scores, ranked like a typed score (flagged means "not verified", never "cheating"). |
| R9 | In Witness only, a desktop (Castcade) score needs evidence (Castcade ≥ 0.2.5) to count; an evidence-less desktop score counts in All scores only. |

## 3. Arcaid Points

### 3.1 The formula

For one scoreboard card (a `(global game, category)` pair, `cardId` in `GlobalLeaderboardService`), in the
chosen window and score set, each player's best score is ranked with competition ranks (ties share a place).
With `N` players on the card and the player at rank `r`:

> **points = round(100 × (N − r + 1) ÷ max(N, 10))**

`N − r + 1` is the number of players at or below you, yourself included (ties share `r`, so tied players get
the same points). A player's total is the sum of their **best 20 cards**. Overall places are competition ranks
(`assignCompetitionRanks`, the room rankings' rule since B30).

Why this and not Leon's two candidates:

| Leon's result | IFPA style (100 → 1) | Extinction (N → 1) | **Arcaid Points** |
|---|---|---|---|
| 3rd of 40 on Medieval Madness | 98 | 38 | **95** |
| 1st of 2 on an obscure table | 100 (farmed) | 2 | **20** |
| 12th of 12 | 89 | 1 | **8** |

- IFPA style can be farmed: be alone on an obscure table and take 100.
- Extinction weights popular tables so heavily that small ones are worthless (Leon's own worry).
- Arcaid Points: a card is worth up to 100; under 10 players it is worth proportionally less; past 10 the size
  stops mattering for first place but still grades the rest of the field.
- Best 20 caps the volume advantage: past 20 cards a player climbs by improving, not by posting more.

The formula, the cap (20) and the floor (10) are ADR 0044 (with the rulings in section 2). They are constants in one
place (new, beside the service), never literals at call sites.

### 3.2 Categories

Points are per card, so a VPX score never competes with a Pinball FX score, and one game can earn points on
two cards (its VPX card and its FX card). The category chips the Global Scoreboard already has filter the
Standings too ("Arcaid Points, VPX only").

### 3.3 Windows

**All-time, Year (calendar), Month (calendar).** The word "season" is never used here: it is a room tournament
format (ADR 0025) and B31's season recap.

- A window holds the scores **submitted** inside it (`global_scores.submitted_at`). For a Witness score that
  reached Global directly this is ingest time, seconds after the game; the backfilled rows from the admin
  backfill carry their original time. Good enough for month/year boundaries.
- Boundaries are **UTC**, stated on the page ("Months and years run on UTC"). Global has no room, so the room
  timezone chain (`resolveTimezone`) does not apply. Build-time check: confirm the owner is happy with UTC.

### 3.4 The player explainer (R1)

One copy of the text, in one shared file (new, FE), used by the Standings page panel ("How points work",
collapsed), the Help page section, and the Discord `/standings` help. Draft:

> **How Arcaid Points work**
> - Every table is worth up to 100 points. You earn the share of the field you finished level with or ahead
>   of, counting yourself.
> - Tables with fewer than 10 players count as if they had 10. First place on a table only 3 people have
>   played earns 30, not 100. Beating more people earns more.
> - Only your best score on each table counts. Tables are ranked separately by type, like the cards on the
>   Global Scoreboard, so a VPX score never competes with a Pinball FX score.
> - Your total is your best 20 tables. Playing more tables finds your best 20; better scores raise them.
> - Tied scores share the same points.
> - **Witness only** counts scores recorded by Arcaid Witness (Castcade on a PC, the Witness app on a cabinet)
>   and scores pulled from AtGames tournaments. **All scores** counts every score on the Global Scoreboard.

Each player's breakdown shows the arithmetic per card:

> Medieval Madness (VPX) · 3rd of 40 · 38 of 40 players at or below you · 100 × 38 ÷ 40 = **95**

## 4. Which scores count

### 4.1 The two views

| View | Counts |
|---|---|
| **All scores** | Every row the Global Scoreboard ranks today: not deleted, not orphaned, `exclude_from_global = 0`. Typed, photo, synced-free (sync never reaches Global, ADR 0016), machine. Flagged Witness scores included (R8). |
| **Witness only** | Rows whose `source` is machine-reported (`isMachineReportedScore` in `src/utils/scoreCorrectionPolicy.ts`: `'vpx'` and `'atgames'`), that pass the Arcaid standard (4.2), or whose appeal was upheld (5.3). |

- **Two helpers for two questions.** Standings rank best scores, so they ask "did a machine report this
  number?": `isMachineReportedScore`. Activity boards (games played, section 9) ask "is this row one game?":
  B31's `isMachinePlay` / `machinePlaySql` in `src/utils/machinePlay.ts`. Neither feature lists sources itself.
- **Photos never promote a score to Witness only** (R7): a photo can be old or edited, and the only reviewer of
  global photos would be the owner. No "photo-verified" middle tier.
- **Only linked accounts rank.** Anonymous name-only rows (`player_key` = `iscored:<name>`) appear on the
  per-table boards as today but earn no points: a ranking has to belong to someone who can see it, follow,
  appeal. Witness and AtGames-linked scores always have an account.
- **Players who opted out of Global (`user_preferences.share_to_global`) never appear** (their rows carry
  `exclude_from_global = 1` already).

### 4.2 The Arcaid standard (new)

Today a Witness score is judged only against a **tournament's** rules, inside `VpxScoreIngestService` (the
`evaluateSanctioned` call for each tournament match). A score that lands on the Global Scoreboard directly
(`recordGlobal`) is never judged, so nothing on Global can be flagged yet.

Witness only therefore needs one rule set of its own, **the Arcaid standard** (new): `normalizeSanctionedRules`
defaults (stock physics, factory adjustments with Free Play allowed, known build by version, minimum tilt), no
per-table requirements. It is evaluated by `evaluateSanctioned`, the ONE evaluation, never a second checker.

- **Judged when standings are computed, never stored as the standings' verdict.** The raw evidence is already
  kept in `witness_evidence` (every Witness score's trail row carries `global_score_id` for the Global row it
  landed on or fanned out to). So when the owner relaxes a rule, old scores count again on the next recompute,
  with no re-judge job. This also answers W128's need for standings (W128 itself stays a tournament item).
- **Who can be flagged.** Only desktop (Castcade) scores carry evidence. Cabinet Witness scores and AtGames
  scores carry none, and "no evidence is an absence of badge, never a badge of absence" (`witness.md`), so they
  always pass. PC players therefore face rules cabinet players do not; this is the existing doctrine until a
  cabinet evidence profile exists.
- **R9 closes the old-build loophole:** a desktop score with no evidence (Castcade < 0.2.5) is not in Witness
  only. Build-time check: how a desktop row is told apart from a cabinet row on Global (`witness_evidence` →
  `witness_devices.device_type`, or `global_scores.device`).
- **The tournament verdict is a different thing.** A tournament's stored verdict (its own required table, its
  own rules) is never read by the standings, and the standings' verdict never touches a tournament board.

### 4.3 Types with no machine path

AtGames native tables reach Arcaid as machine scores only through an AtGames private tournament linked to an
Arcaid event (`AtGamesEventSyncService`); a casual AtGames game never does. Zen / Pinball FX on PC have no
machine path at all. So Witness only is empty or near-empty for those categories. When a player picks one, the
page says so ("No machine recording for Pinball FX yet: switch to All scores") instead of an empty board.

## 5. Flags and appeals (R2)

### 5.1 What the player sees

- **An alert** when a score of theirs fails the Arcaid standard: "Your Medieval Madness score didn't earn Witness
  only points: table adjustments aren't factory." A new notification type (new, `standingsFlag`), which touches
  the five places the notifications invariant lists: `PREF_TYPE_KEYS`, the prefs interface,
  `getPrefsWithExplicit` defaults, Discord `PREF_LABELS`, `AccountSettings.tsx`'s `NOTIF_TYPES`. Since the
  verdict is computed at standings time, the alert fires from the recompute when a newly arrived score fails
  (once per score: a sent-marker table, new).
- **The same reason** on "Where your plays went" (Account Settings → Arcaid Witness devices,
  `WitnessEvidenceService.recentPlaysForUser` / `components/WitnessRecentPlays.tsx`) and as ⚠ + reason on the
  player's points breakdown. Public marks stay ✓ and ⚠ only (ADR 0038).

### 5.2 Correcting means replaying

A machine-reported score is never editable, by anyone (owner ruling 2026-10-25). "Correct the issue" means:
fix the setup (the reasons say what), play again. The flagged score stays on its table's board with ⚠, keeps
counting in All scores (R8), and earns nothing in Witness only; the next clean game does.

### 5.3 Appeals

1. Each flagged play shows **Appeal** (on the breakdown and in Where your plays went), open for **7 days** from
   the play: device logs only cover recent days, so a later appeal would have nothing to send.
2. Appealing **requires a Witness log bundle from the device that recorded the score.** It reuses the log pull
   (W99/W102, ADR 0040): the player requests logs from that device (`WitnessLogService.request`), and
   submitting the appeal shares the bundle with support through `sendToSupport` (the ONE share path; it audits
   and alerts the operator). No second share path, no upload of arbitrary files.
3. Owner queue (super admin, new page): the score, the reasons, the evidence, the shared log bundle, the
   player's note. **Uphold** (the score counts in Witness only) or **Deny**, with a reason the player sees.
4. Stored as a decision on the score (new table, keyed to `global_scores.id`), never by editing the score. A
   deleted score makes its appeal moot. A shared log bundle is kept 30 days (existing lifecycle), which covers
   the review.
5. Every appeal and decision writes an activity row (room-less, super admin: the activity-log invariant) and an
   `audit_log` row for the decision. The player gets an alert for the decision (a second new notification type,
   `appealDecision`, same five places).

## 6. Profile fields (R4, R5)

### 6.1 What is stored

| Field | Input | Stored | Shown |
|---|---|---|---|
| Country | list (ISO 3166-1) | country code | "United States" |
| State / province | list for the chosen country (ISO 3166-2), optional | subdivision code | "Alabama" |
| Birth decade | the player types a year, or picks a decade | the decade only (`1970`) | "Born in the 70s" |

- **The year is converted on the way in and never written anywhere**: not the database, not the request log,
  not an error report, not the activity log. A test posts a year and asserts it appears in no stored row and no
  log line. The route should accept the decade, and the FE converts the typed year before sending, so the year
  never reaches the server at all.
- **The youngest decades are combined on boards.** The true decade is stored, but any decade that could
  include someone under 18 is shown as one group, "Born 2000 or later" (today: the 2000s and 2010s). The rule
  is computed at read from the current year, so groups split apart as players age with no data change. No
  board is ever a minors' board.
- **Every field is optional and off by default**, each with its own "show me on these boards" switch.
  Unchecked = the field is stored for the player's own view only and they appear on no slice.
- **Country / state and decade can change once every 30 days**, so nobody hops states to lead somewhere.
- One table (new, `player_attributes`, keyed on the canonical user id), not columns on `user_profiles`: it is
  personal data with its own deletion and export rules.
- `AccountDeletionService` erases the row; the Privacy page lists the fields and why they exist.
- **Account linking merges the fields stricter-wins**, the rule B31 applied in `IdentityLinkService.createLink`
  for `recap_play_stats` / `share_to_global`: a visibility switch stays on only if both accounts had it on; a
  value set on only one account is kept; when both set one, the canonical account's wins. Without this a
  Google-only player's choice is lost when they link Discord (the bug B31 found).

## 7. Friends

- Reuses `friendships` (one-way follow: `user_id` follows `friend_user_id`). A Friends board = me + the
  players I follow. One-way is right for scores that are already public; no request friction.
- **Follow buttons** on every Global board row, the player page and the Standings rows (today the only way is
  typing a Discord username on the Friends page, so a Friends board would start empty). `FriendsService`
  already has `addFriendById`.
- Friend ids resolve to canonical ids (`IdentityLinkService.resolveCanonical`) before filtering, so a player
  followed under their Google id still matches their Discord-keyed scores. Build-time check: what
  `friendships.friend_user_id` holds for a Google-only player.

## 8. Groups and room members

- **First (no new entity): a "Members" slice on a room.** Everyone in `room_members` for that room, ranked on
  their scores from anywhere. Covers Leon's RTX-Men case. Respects the room's visibility: an `approval` room's
  member slice is shown only to its members (the `=== 'approval'` rule).
- **Then lightweight groups (new):** a name and a member list, no tournaments, no settings. Membership by invite
  code, by Discord role (the `discord_role` machinery: `parseJoinRoleIds`, `DiscordClient.getMemberRoleIds`,
  UNKNOWN never denies), or by mirroring a room's members.
- **Nobody is added without accepting.** Leon's "hurt feelings" point, and a group must not be a tool for
  singling someone out. Group names go through the content blocklist (`src/utils/contentBlocklist.ts`).

## 9. Engagement (beyond Leon's list)

In order of expected value:

1. **"You've been passed" alerts.** "PinballPete beat your Medieval Madness score by 1.2M." Only from people you
   follow; at most one digest a day. The Steam/Zaccaria loop Leon describes. New notification type
   (`friendPassed`, new; same five places).
2. **Next target** on every card the viewer has a score on: "1.4M to pass Leon (#2 among your friends)".
3. **Follow buttons everywhere** (section 7).
4. **The Month window**: a fresh start every month for new players.
5. **Year champions.** On 7 January (a week's grace for deletes and appeals) the year's standings are frozen
   into a table (new, `standings_champions`, ids only); each published slice's #1 gets a `player_achievements`
   row (new type, e.g. `standings_champion`) and a Hall of Fame by year. Pairs with B31's figures for a
   year-end "Wrapped".
6. **Titles on the player page**: "#1 Alabama · Born in the 70s · Witness only". Claimed only when the slice has
   at least 5 players; the board itself still shows small fields, labelled ("1 of 1: invite someone").
7. **Discord**: a `/standings` command (room-scoped reads like every command, `resolveGuildReadScope`; the
   command policy applies) and a monthly champions post a room switches on (off by default). Player names in
   any posted text go through B31's escaping in `src/utils/runRecapText.ts` (`@` + U+200B, `[`, `]`, `<`
   outside code blocks, so a name cannot ping or mask a link); export it from there rather than copy it.
8. **Suggested rival**: the player just above you in points who plays your tables.
9. **Activity boards** (later, optional): most Witness games played this month. Reads B31's figures through
   `machinePlaySql`, and honours B31's play-stats opt-out (`user_preferences.recap_play_stats = 0`, resolved
   through `PreferencesService.getRecapPrefsFor`): an opted-out player's games are removed from every total,
   not just their own row.

## 10. Architecture

**New:**

- `GlobalStandingsService` (new): points per (window × view × category); slices applied after; per-player
  breakdown; the Arcaid standard evaluation (4.2).
- `global_standings_cache` (new): rows of ids + points + per-card breakdown, never names (names and avatars
  resolve at read through `resolveProfiles` / `resolveUserLabels`; the invariant). Invalidated when a Global
  score is added, deleted, restored or has its `exclude_from_global` flipped, and when an appeal is decided;
  recomputed lazily on the next read. Build-time decision: a watermark (like the room rankings' cache) vs
  explicit invalidation at `GlobalScoreService`'s writers. Either way the watermark includes
  `getRecapPrefsVersion()` (`PreferencesService`): from B31.2–B31.5 (PR #542) it bumps on every recap-pref
  change AND every identity change (`invalidateIdentityCaches` calls it), so a link, merge or alias change
  re-partitions players without a second hook.
- JS that builds a `player_key` (`'iscored:' + lower(name)`) uses `src/utils/sqliteLower.ts` (PR #542), which
  folds A–Z only like SQLite's `LOWER()`; `toLowerCase()` mismatches non-ASCII names ("Éric").
- `player_attributes`, appeal decisions, the flag-alert sent marker, groups + members, `standings_champions`
  (all new). One migration per phase that needs one, numbers claimed at build time (B31 holds 224).
- Routes (new, `global.ts` or a new router file): the Standings read with `window`, `view`, `category`,
  `slice`; a player's breakdown; `/api/me` profile-field read/write; appeal create; the super-admin appeal
  queue and decision.
- The per-table board gains `window` and `slice` on its existing route (`GET /global/scoreboard/:globalGameId`,
  backed by `GlobalLeaderboardService.getForGame` / `getForCard`). Windowed or sliced reads are computed, not
  read from `global_leaderboard_cache` (its key is `(global_game_id, scope)` and must stay that).
- Pages: `/standings` (new, standalone global page on the Arcaid look, `components/parts/ArcaidPage.tsx`), the super-admin appeal
  queue (new), a "Standings profile" section in Account Settings, a points line on the player page.
- A rule file `.claude/rules/standings.md` (new) and its row in the CLAUDE.md rules index; `admin-ui.md` is at
  its size budget, so nothing goes there.

**Reused:** `friendships` / `FriendsService`; the card identity and per-card ranking in
`GlobalLeaderboardService` (`cardId`, the `player_key` partition); `assignCompetitionRanks`; `isMachineReportedScore`;
`machinePlay.ts`; `evaluateSanctioned` + `normalizeSanctionedRules`; `witness_evidence`; the log pull and
`sendToSupport`; `room_members`; the Discord role check; `player_achievements`; the notification chain;
`ActivityLogService.record`.

**Invariants this work touches** (CLAUDE.md): names resolve at read; notifications' five places; every new
event source writes an activity row; Discord commands room-scoped; `=== 'approval'` for member slices; every
`user_mappings` writer (none planned); score correction stays where it is (standings never edit a score).

## 11. Fit with B31 (run recaps)

Agreed with the B31 session, 2026-11-26/27:

- **Plays vs scores.** B31 owns `src/utils/machinePlay.ts` (`'vpx'` only); standings use it only for activity
  boards. Points use `isMachineReportedScore`. No file lists sources a second time.
- **Preferences.** B31's two switches are columns on `user_preferences` (migration 224:
  `recap_play_stats`, `recap_time_of_day`). Standings' profile fields are a separate table and a separate
  migration.
- **Shared pages, B31 first.** B31 adds a privacy section to Account Settings (`RecapPrivacySection`, on main
  since 2.281.0), a "Room" tab on Stats (`PublicStats.tsx`, `?view=room`, `components/stats/RoomStatsView.tsx`)
  and a "Runs" section on the player page (`PlayerDetail.tsx`); the last two are in PR #542 (v2.282.0).
  Standings' edits to those pages come after #542 lands and build on it.
- **Naming.** Global windows are Year / Month / All-time; "season" stays B31's and the rooms'.
- **One stats family.** Recaps live on the run, tournament, table and room; standings live on the Global
  Standings page and the player page's points line. A player's page shows both, B31's runs and the standings'
  points, as neighbours, not a merged section.

## 12. Phases (WORK.md B32.1–B32.7)

Each phase ships on its own; each is one PR (or a few), with mock-data screenshots before merge for UI.

| ID | Ships | New data | Needs |
|---|---|---|---|
| B32.1 | Friends slice + This year / This month on every Global table board; Follow buttons on rows and player pages | none | (G36, the Global Scoreboard restyle, shipped 2.278.0; check G35's open claim on the landing page first) |
| B32.2 | `/standings`: Arcaid Points, All scores / Witness only, three windows, category chips, the Arcaid standard, the explainer, the ADR | cache | B32.1 |
| B32.3 | Flag alerts, Appeal with a log bundle, the owner's appeal queue | decisions, sent-marker | B32.2 |
| B32.4 | "You've been passed" alerts, next target, weekly digest | none | B32.1 |
| B32.5 | Country / state / birth-decade fields, their slices, Privacy page, account deletion | `player_attributes` | B32.2, B31.3 landed |
| B32.6 | Room "Members" slice, then groups (invite, Discord role, room mirror) | groups | B32.2 |
| B32.7 | Year champions, Hall of Fame, titles, `/standings`, monthly Discord post | `standings_champions` | B32.2 |

## 13. Checks to make when each phase is claimed

- How many linked players have machine-reported Global scores (a prod read; ask the owner first). If it is a
  few dozen, Witness only starts thin and All scores carries the page.
- How a desktop score is told apart from a cabinet score on a Global row (R9).
- What `friendships.friend_user_id` holds for a Google-only player (section 7).
- The cost of the points computation on the prod row count (expected small: SQLite window functions over
  `global_scores`).
- UTC windows (3.3).

## 14. Risks

- **Thin fields.** "#1 of 1" is hollow; titles need 5 players, boards say "1 of 1".
- **Fragmentation.** One Standings page with a slice bar, never a page per slice.
- **Unfairness between devices** (4.2): PC players can be flagged, cabinet players cannot, until a cabinet
  evidence profile exists. Say so in the Help text if players ask.
- **Self-declared fields can be false.** Low stakes; the 30-day change limit stops hopping.
- **Collisions.** The landing page (G35, arcaid-fe, links into the Global Scoreboard), `PlayerDetail.tsx` / `PublicStats.tsx` /
  `AccountSettings.tsx` (B31). Sequence, never share a branch.
