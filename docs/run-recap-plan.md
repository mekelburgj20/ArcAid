# Run recaps — "By the numbers" (B31) — implementation contract

Status: design, 2026-11-26. Owner spec + rulings 2026-11-26 (WORK.md B31). Reference: the owner's hand-built
"Lost in Space" recap (one run of *Legends Unchained VPX Tournament Season 06*, Mox's Game Room, `games` row
`6b5067cd-…`, 335 Witness games, 11 Witness players, 18 typed `community` rows).

This file is the contract for the implementation agents. Every name marked **(new)** does not exist yet; every
other name was verified in the code on 2026-11-26. If you find a name here that is wrong, stop and report it;
do not invent a substitute.

---

## 0. Ground rules that apply to every slice

### 0.1 What a "run" is and which scores belong to it
- A run = one `games` row with `tournament_id IS NOT NULL` and `status IN ('ACTIVE','COMPLETED','ARCHIVED')`.
  `QUEUED` / `SCHEDULED` → 404 (not started). **Pinned boards (`tournament_id IS NULL`) are not runs: no recap**
  (no window, unbounded; ADR 0005). **Throwdowns** (`game_room_id IS NULL`) are out of scope: every recap route
  is room-scoped and answers 404 for a game whose tournament is not in `:roomId`.
- **Rotation run** (`tournaments.format = 'rotation'`, or any game with `round_no IS NULL`): the rows are
  exactly the board's rows (`LeaderboardService.queryRankedRows`, private):
  ```sql
  FROM score_history sh
  WHERE sh.game_room_id = ? AND sh.submitted_during_tournament_id = ? AND LOWER(sh.game_name) = LOWER(?)
    AND sh.orphaned_at IS NULL
    AND ${gameRunWindowByIdSql('sh')}          -- src/utils/gameRunWindow.ts, bound param = the game id
  ```
  Never `score_history.game_id` (sparse on prod).
- **Event round** (`t.format = 'event' AND g.round_no IS NOT NULL`): the rows are exactly the round board's rows
  (`EventResultService.getRoundBoardDetail`): `submitted_during_tournament_id = event.id AND orphaned_at IS NULL
  AND (sh.game_id = round.id OR (sh.game_id IS NULL AND LOWER(sh.game_name) = LOWER(round.name) AND created_at
  between scheduled_start_at and scheduled_end_at + eventEndGraceSec(event)))`. B31.1 extracts that predicate
  (see §B31.1) so the recap and the board share it.
- Deleted scores are hard-deleted rows (tombstones only stop re-import), so they are simply absent. Corrections
  edit the row in place, so they are picked up on the next read. **Nothing is cached per run** (§0.6).
- **Practice-mode plays never reach the tournament board** (`attempts.md`: refused with reason `practice`, Global
  fall-through), so they are never in these rows. Nothing to filter.
- **Witness flag mode:** only event rounds gate (`witness.md`, ADR 0031). Under `prevent`
  (`normalizeWitnessFlagMode(t.witness_flag_mode)`), every row whose verdict is `flagged` is **removed from the
  recap entirely** (best, standings, timeline AND play counts), exactly as the standings leave it out. Verdicts
  come from `LeaderboardService.getEventRoundOverlays([gameId])` → `witnessFlagMode` + `witnessByHistoryId`
  (`Record<string, WitnessVerdict>`, key = `String(score_history.id)`). Under `flag`, nothing is removed. Rotation
  runs: nothing is removed (rotation boards never gate on a verdict).

### 0.2 Machine-recorded plays vs typed scores (owner ruling 1)
- **One shared helper, `src/utils/machinePlay.ts` (new, B31.1)**: `export const MACHINE_PLAY_SOURCES: readonly string[] = ['vpx']`, `export function isMachinePlay(source: string | null | undefined): boolean`, and `export function machinePlaySql(alias = 'sh'): string` (returns `<alias>.source IN ('vpx')`, built from the constant). It is the ONE definition of "a game a machine recorded" for B31 AND for the planned global rankings (agreed with that session 2026-11-26): no other file may list play sources. `runRecapCompute.ts` imports it (it may re-export `WITNESS_SOURCES` as an alias but must not redefine it). Only `source = 'vpx'`
  rows are "games": each one is one game reported by Arcaid Witness (cabinet or Castcade desktop; the ingest files
  each GAME, `witness.md` "VPXS auto score collection").
- **`atgames` is NOT a play source.** AtGames keeps each player's BEST only, and a native-table score reaches
  AtGames only if it makes the cabinet's local high-score list (`atgames.md` "Scores and window"). One row ≈ one
  best, not one game. `tournament`, `community` (typed web/Discord), `sync` (iScored, unknown provenance) are typed.
  In data these are `'other'`; in copy "typed in or synced".
- Typed (`'other'`) rows count ONLY for: best score, standings/finish place, who-led timeline (lead changes,
  lead steps, comeback/closest-finish facts). They NEVER count toward games, average, median, sessions, streaks,
  personal bests, per-day/per-hour counts, or any play-volume award. A player with no `vpx` row shows `—` for those
  with the note "typed or synced scores only".
- `score_history.created_at` on a `vpx` row is the game's **END** time (launcher end time, `witness.md`
  "A REPEAT of a play…"). So copy says "games … between midnight and 5 am", never "started"; session length is
  first end → last end ("15 games over 98 minutes").

### 0.3 Limited attempts (owner ruling 5) — recommendation
**Games played = the player's `vpx` rows on the board, in every tournament, limited or not.** Reasons: (a) avg /
median / PBs need a score per game, and `attempts` holds `unreported` starts with no score; (b) one rule across
limited and unlimited tournaments keeps season and room roll-ups comparable; (c) over-limit and practice plays never
land on the board, so the board rows already are "the attempts that scored". In a limited tournament
(`tournaments.max_attempts IS NOT NULL`) the recap ADDS `attempts_used` per player from
`AttemptService.usedByGame(tournamentId)` (`USED_STATUS_SQL` inside; `canonical_user_id` keyed) — shown as
"N of M attempts" in the player detail only, subject to the same play-stats opt-out.

### 0.4 Identity (owner ruling 7) — match the board, per format
Group rows by **the run board's own partition key**, so the recap's finish places can never disagree with the board:
- rotation: `COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username))` (the
  `LeaderboardService.queryRankedRows` / `RankingService` partition);
- event round: `EventResultService`'s `IDENTITY_KEY_SQL` = `COALESCE(sh.submitted_by_user_id, um.discord_user_id,
  'iscored:' || LOWER(sh.iscored_username))` with `LEFT JOIN user_mappings um ON um.iscored_username =
  sh.iscored_username COLLATE NOCASE` (B31.1 exports it).
This is called `key` everywhere below. It is shipped (needed as a React key and for the detail route) but **never
rendered**. Names/avatars resolve at read via `resolveProfiles` (src/services/PlayerProfileResolver.ts) — from the
hydrated `RankedEntry` rows of `LeaderboardService.getRunStandings` for single runs, and from one representative
row per key for bulk reads. Never `|| key`, never a name in a stored row. (See open question Q1 on rotation aliases.)

### 0.5 Privacy (owner ruling 2) — server-side only
Two new `user_preferences` columns (migration 224, §B31.1):
- `recap_play_stats INTEGER` — NULL = shown (default ON), `0` = hidden.
- `recap_time_of_day INTEGER` — NULL/`0` = off (default OFF), `1` = on.
Rules, enforced in `RunRecapService` before anything is serialized:
- Hidden player: `games/average/median/sessions/personal_bests/days_played/best_game_no/attempts_used` are
  `null` in JSON (never computed into the payload), they win no award, and **their `vpx` rows are excluded from
  every aggregate** (headline game count, `per_day`, field totals, room/season "most games" records) so their
  volume cannot be inferred by subtraction. They still appear in standings with best score + finish place, and in
  the lead timeline (standings facts).
- Time-of-day: per-hour figures, the night-owl/early-bird awards and per-game clock times in the player detail
  exist ONLY for opted-in players (`recap_time_of_day = 1`) whose play stats are also shown. Everyone else's game
  list carries the local DATE only. Lead-change times stay public for everyone (standings facts; owner's own format
  prints them) — see Q10.
- Prefs lookup key: the row `key`. Batch-resolve each key's canonical id through `user_identity_links`
  (`IdentityLinkService.resolveCanonical` semantics, one `IN (...)` query) and read prefs for the union of raw +
  canonical ids. **Hidden if ANY of them says `recap_play_stats = 0`; time-of-day on only if the canonical (else
  raw) id says `1`.** `iscored:*` keys have no account → defaults (they have no `vpx` rows anyway).

### 0.6 Caching
- Single-run recap, player detail, player runs, table runs, season recap: **computed on read, no cache** (one run
  is a few hundred rows; a season a few thousand).
- Room records (B31.4) only: optional in-process cache keyed by room, invalidated by a watermark (§B31.4). Stores
  keys/ids only, never names.

### 0.7 Times and days (owner ruling 4)
One zone per run: `resolveTimezone(cadenceTz, await roomTimezone(roomId))` (src/utils/roomTimezone.ts), where
`cadenceTz` = `JSON.parse(t.cadence).timezone` inside try/catch (same pattern as `RotationNudgeService`
`nextRotationWithinWindow`). Never hand-copy `America/Chicago`. Day key = `Intl.DateTimeFormat('en-CA',
{ timeZone })` → `YYYY-MM-DD`; hour = `hour: 'numeric', hourCycle: 'h23'`. DB times come in two shapes
(`YYYY-MM-DD HH:MM:SS` = UTC, and ISO with `Z`): parse with the new `dbTimeMs(s)` (bare shape → append `Z`).

### 0.8 Sessions, lead changes (owner ruling 6)
- `SESSION_GAP_MIN = 20` (new named constant). Within one player's `vpx` games sorted by time, a gap **> 20
  minutes** starts a new session (exactly 20:00 stays in the session).
- Lead changes count only when the leading PLAYER changes. A new best must be **strictly greater** than the
  current leader's best to take the lead (an equal score does not: the board ranks the earlier score first).
  The leader improving their own best is a **lead step** (chart) but not a lead change (list/count).

---

## 1. Shared types — `src/types/runRecap.ts` (new) ≡ `admin-ui/src/lib/runRecapTypes.ts` (new)

B31.1 writes BOTH files with ALL types for ALL slices, so no later slice edits them. Each file = its own header
comment, then the line `// ==== BODY (mirrored, keep identical) ====`, then the body below, byte-identical
after LF normalization. `src/__tests__/runRecap-types-parity.test.ts` (new) reads both files as text, normalizes
CRLF, and compares everything after the marker. Types only, no imports, no runtime code.

```ts
// ==== BODY (mirrored, keep identical) ====

/** 'witness' = an Arcaid Witness game (source 'vpx'); 'other' = typed in or synced (tournament/community/sync/atgames). */
export type RecapSource = 'witness' | 'other';
/** shown = play stats public; hidden = the player opted out; none = no Witness games in this run (typed/synced only). */
export type RecapPlayStats = 'shown' | 'hidden' | 'none';
export type RecapRunState = 'active' | 'completed';

/** A player as rendered. `key` is the board partition key: never rendered, used for React keys and the detail route. */
export interface RecapPlayerRef {
  key: string;
  /** Routing key for /:slug/players/:name. */
  iscored_username: string;
  display_name: string | null;
  discord_user_id: string | null;
  avatar_hash: string | null;
  avatar_url: string | null;
}

export interface RecapPlayerRow extends RecapPlayerRef {
  /** Finish place from the run board (LeaderboardService.getRunStandings). */
  rank: number;
  best: number;
  /** ISO UTC. */
  best_at: string;
  best_source: RecapSource;
  play_stats: RecapPlayStats;
  /** Everything below is null unless play_stats === 'shown'. */
  games: number | null;
  /** Rounded to an integer. */
  average: number | null;
  median: number | null;
  sessions: number | null;
  personal_bests: number | null;
  days_played: number | null;
  /** 1-based index of the best game among this player's Witness games; null when the best is typed/synced. */
  best_game_no: number | null;
  /** Limited-attempts tournaments only (AttemptService.usedByGame). */
  attempts_used: number | null;
}

export type RecapLeadKind = 'first' | 'takes_first' | 'takes_back';

export interface RecapLeadChange {
  at: string;            // ISO UTC
  player_key: string;    // into RunRecap.players
  score: number;
  kind: RecapLeadKind;
  /** True on the last change of a COMPLETED run (the leader at the close won it). */
  wins_it: boolean;
}

/** Every change of the leading score (lead changes AND the leader beating their own best): the step chart's points. */
export interface RecapLeadStep {
  at: string;
  player_key: string;
  score: number;
}

export type RecapAwardId =
  | 'most_games' | 'longest_streak' | 'longest_session' | 'busiest_day'
  | 'most_personal_bests' | 'best_first_game' | 'most_consistent' | 'night_owl' | 'early_bird';

export interface RecapAward {
  id: RecapAwardId;
  label: string;               // "Most games"
  player_keys: string[];       // 1-3 keys (ties share)
  value: number;
  /** Server-built English fragment with NO names in it, e.g. "122 games, all 7 days, 8.58 billion points in total". */
  detail: string;
}

export interface RecapBucket {
  kind: 'day' | 'week';
  /** 'YYYY-MM-DD' local (a week bucket: its Monday). */
  key: string;
  /** 'Fri 11/20' or 'Week of Nov 2'. */
  label: string;
  games: number;
}

/** Run-level facts the roll-ups aggregate. Computed from ALL rows (typed included): standings facts. */
export interface RecapFacts {
  /** (1st best - 2nd best) / 1st best; null with < 2 players. */
  closest_finish_ratio: number | null;
  /** Largest (leader best - eventual winner best) / leader best after the winner's first score; null = led wire to wire or < 2 players. */
  comeback_ratio: number | null;
  lead_changes: number;        // excludes the 'first' entry
  /** Longest session in the run by games (visible players only). */
  longest_streak: { player_key: string; games: number; minutes: number } | null;
  most_games: { player_key: string; games: number } | null;
}

export interface RunRecap {
  version: 1;
  run: {
    game_id: string;
    game_name: string;
    tournament_id: string;
    tournament_name: string;
    tournament_type: string;
    format: 'rotation' | 'event';
    round_no: number | null;
    state: RecapRunState;
    start_date: string | null;
    end_date: string | null;
    /** Completed: end_date. Active: next rotation (nextRotationIso) or the round's scheduled end; null when unknown. */
    close_at: string | null;
    /** IANA zone every day/time label used (resolveTimezone). */
    timezone: string;
    image_url: string | null;
    max_attempts: number | null;
  };
  totals: {
    players: number;             // standings size
    witness_games: number;       // visible players only
    witness_players: number;     // visible players with >= 1 Witness game
    hidden_players: number;      // opted out AND had Witness games
    other_only_players: number;  // no Witness game at all
  };
  hero: {
    winner_key: string | null;   // standings rank 1 (leader so far when active)
    best: number | null;
    best_at: string | null;
    best_source: RecapSource | null;
    /** Winner's Witness-game index of the winning game; null when typed/synced or hidden. */
    winning_game_no: number | null;
    winner_games: number | null;
    /** Completed: close - best_at. Active: null. */
    ms_before_close: number | null;
    /** Winner's own Witness games per local day (non-zero days only); null unless shown. */
    winner_days: RecapBucket[] | null;
    /** The winning game was the Nth Witness game of the winner on its local day; null unless shown. */
    game_of_day: number | null;
  };
  players: RecapPlayerRow[];     // standings order
  lead_changes: RecapLeadChange[];
  lead_steps: RecapLeadStep[];
  awards: RecapAward[];
  /** Field Witness games per day (week when the span > 14 days); null when the span is one day or there are no Witness games. */
  per_day: RecapBucket[] | null;
  facts: RecapFacts;
  /** Server-built Discord text (§B31.1 text contract), <= 4000 chars. */
  discord_text: string;
  generated_at: string;
}

export interface RecapPlayerGame {
  /** 1-based Witness game number; null for a typed/synced score. */
  n: number | null;
  source: RecapSource;
  /** Local 'YYYY-MM-DD'. */
  day: string;
  /** Local 'HH:MM' (24 h) ONLY when the player opted in to time-of-day; else null. */
  time: string | null;
  score: number;
  /** 1-based session index; null for typed/synced. */
  session: number | null;
  is_pb: boolean;
  is_best: boolean;
}

export interface RecapSession {
  n: number;
  games: number;
  minutes: number;
  best: number;
  day: string;                 // local day of its first game
}

export interface RecapPlayerDetail {
  player: RecapPlayerRow;
  /** Empty when play_stats !== 'shown' (only player.best is shown then). */
  games: RecapPlayerGame[];
  sessions: RecapSession[];
  /** 24 local-hour buckets; null unless opted in to time-of-day. */
  hours: number[] | null;
  timezone: string;
}

export interface LiveRunsResponse {
  runs: Array<{ game_id: string; game_name: string; start_date: string | null; image_url: string | null }>;
}

// ---- B31.3 ----
export interface PlayerRunLine {
  game_id: string;
  game_name: string;
  tournament_id: string;
  tournament_name: string;
  state: RecapRunState;
  end_date: string | null;
  image_url: string | null;
  games: number | null;        // null unless shown
  average: number | null;
  best: number;
  best_game_no: number | null;
  finish: number;
  field: number;
}
export interface PlayerRunsResponse {
  player: RecapPlayerRef | null;  // null when the player has no run in this room
  play_stats: 'shown' | 'hidden';
  runs: PlayerRunLine[];          // newest first, all of them (no cap; FE shows 20 then "Show all")
}

export interface TableRunsSummary {
  game_name: string;
  runs: number;                    // completed runs of this table in this room
  typical_winning_score: number | null;  // median of the completed runs' winning scores
  median_game: number | null;      // median of every visible Witness game across those runs
  most_games_in_run: { player: RecapPlayerRef; games: number; game_id: string; tournament_id: string } | null;
  recent: Array<{
    game_id: string; tournament_id: string; tournament_name: string; end_date: string | null;
    winner: RecapPlayerRef | null; winning_score: number | null; players: number; witness_games: number;
  }>;                              // newest first, max 10
}

// ---- B31.4 ----
export type SeasonAwardId =
  | 'most_runs_won' | 'played_every_table' | 'most_games' | 'closest_finish'
  | 'most_lead_changes' | 'biggest_comeback' | 'biggest_margin';
export type RoomRecordId =
  | 'longest_streak' | 'most_games_in_run' | 'most_lead_changes' | 'biggest_comeback' | 'closest_finish';

export interface RecapRunLink {
  game_id: string; game_name: string; tournament_id: string; tournament_name: string; end_date: string | null;
}

export interface SeasonAward {
  id: SeasonAwardId;
  label: string;
  player_keys: string[];       // may be empty for a run-level award
  value: number;
  detail: string;              // no names
  run: RecapRunLink | null;    // the run it happened in, when run-level
}

export interface SeasonRecap {
  tournament: { id: string; name: string; type: string; format: 'rotation' | 'event'; is_active: boolean };
  runs: number;                // completed runs
  live_runs: number;
  players: RecapPlayerRef[];   // every key any award/standing below names
  standings: Array<{ player_key: string; runs_played: number; runs_won: number; podiums: number; games: number | null }>;
  awards: SeasonAward[];
}

export interface RoomRecord {
  id: RoomRecordId;
  label: string;
  player_keys: string[];
  value: number;
  detail: string;
  run: RecapRunLink;
}
export interface RoomRecordsResponse {
  players: RecapPlayerRef[];
  records: RoomRecord[];
  generated_at: string;
}
```

---

## B31.1 — Recap service, endpoints, Discord text, two preferences (lands FIRST, alone)

**Goal:** everything the other slices consume: types, compute, the single-run read, the bulk summarizer, the
Discord text, the prefs (DB + API + Account Settings), the route file with reserved blocks, FE shared libs.

### Files
Create (all new):
| File | Content |
|---|---|
| `src/types/runRecap.ts`, `admin-ui/src/lib/runRecapTypes.ts` | §1 |
| `src/utils/machinePlay.ts` | the shared machine-play helper (§0.2) + `src/__tests__/machine-play.test.ts` |
| `src/utils/runRecapCompute.ts` | pure compute, no DB/imports beyond types and `machinePlay` |
| `src/utils/runRecapText.ts` | pure Discord text builder + bot splitter |
| `src/services/RunRecapService.ts` | DB loaders, single-run recap, player detail, live runs, bulk summarizer |
| `src/database/migrations/runRecaps.ts` | migration 224 handler |
| `src/api/routes/recaps.ts` | router with B31.1 routes + reserved B31.3/B31.4 blocks |
| `admin-ui/src/lib/recapFormat.ts` | FE formatters |
| `admin-ui/src/components/RecapPrivacySection.tsx` | the two switches (Panel) |
| `.claude/rules/recaps.md` | path-scoped rule file, sections per slice (admin-ui.md is at 39,983 of 40,000 chars: nothing more fits there) |

Modify:
| File | Change |
|---|---|
| `src/database/database.ts` | append `{ name: '224_run_recaps', handler: async (db) => { const { runRecaps } = await import('./migrations/runRecaps.js'); await runRecaps(db); } }` after `223_practice_mode` |
| `src/services/PreferencesService.ts` | prefs methods (below) |
| `src/api/schemas.ts` | `UpdatePreferencesSchema`: add `recap_play_stats: z.boolean().optional()`, `recap_time_of_day: z.boolean().optional()`, extend the `.refine` and its message |
| `src/api/routes/global.ts` | `POST /me/preferences`: write the two when sent (same "only what was sent" rule); `GET` returns them via `getAll` |
| `src/api/server.ts` | `import recapsRouter from './routes/recaps.js'`; `app.use('/api', recapsRouter);` right after `app.use('/api', integrityRouter);` |
| `src/services/EventResultService.ts` | export `IDENTITY_KEY_SQL`; extract the round row predicate into exported `roundRowsWhere(event, round): { sql: string; params: unknown[] }` (alias `sh`, assumes `um` joined); `getRoundBoardDetail` uses it (no behaviour change; existing event tests are the guard) |
| `src/utils/publicLinks.ts` | `tournamentRunRecapUrl(slug, tournamentId, gameId)` (new) = `tournamentRunUrl(...) + '&recap=1'`; comment "change with `tournamentRecapPath`" |
| `admin-ui/src/lib/tournamentLinks.ts` | `tournamentRecapPath(slug, tournamentId, gameId)` (new) = `${tournamentResultsPath(slug, tournamentId, gameId)}&recap=1` |
| `admin-ui/src/pages/AccountSettings.tsx` | `<RecapPrivacySection />` inside `<PanelGroup {...SETTINGS_GROUPS.scores}>` directly after `<GlobalSharingSection />` |
| `CLAUDE.md` | one row in the Rules index: `recaps.md` — "run recaps (B31): RunRecapService, recap routes, the Discord recap text, recap prefs, recap UI" |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | version bump (minor) |

### Migration 224 — `src/database/migrations/runRecaps.ts` (new): `export async function runRecaps(db)`
Idempotent (PRAGMA check like `223_practice_mode`):
```sql
ALTER TABLE user_preferences ADD COLUMN recap_play_stats INTEGER;   -- NULL = shown, 0 = hidden
ALTER TABLE user_preferences ADD COLUMN recap_time_of_day INTEGER;  -- NULL/0 = off, 1 = on
CREATE TABLE IF NOT EXISTS run_recap_posts (          -- B31.5's idempotency ledger; created now so B31.5 never touches database.ts
  game_id      TEXT PRIMARY KEY,                       -- no FK: an audit row that outlives its game (like maintenance_runs)
  game_room_id TEXT,
  status       TEXT NOT NULL,                          -- 'claimed' | 'posted' | 'skipped' | 'failed'
  channel_id   TEXT,
  message_ids  TEXT,                                   -- JSON array
  reason       TEXT,
  claimed_at   TEXT NOT NULL,
  finished_at  TEXT
);
```
Migration number **224** (last on main and on every local/remote branch is `223_practice_mode`; scanned
2026-11-26).

### PreferencesService additions (src/services/PreferencesService.ts)
```ts
static async getRecapPlayStats(userId: string): Promise<boolean>;          // row?.recap_play_stats !== 0
static async setRecapPlayStats(userId: string, shown: boolean): Promise<void>;   // upsert 1/0 like setShareToGlobal
static async getRecapTimeOfDay(userId: string): Promise<boolean>;          // row?.recap_time_of_day === 1
static async setRecapTimeOfDay(userId: string, on: boolean): Promise<void>;
/** Batched, privacy-safe resolution for recap reads (§0.5). Keys may be iscored:* (→ defaults). */
static async getRecapPrefsFor(keys: string[]): Promise<Map<string, { playStats: boolean; timeOfDay: boolean }>>;
```
`getAll` gains `recap_play_stats: boolean, recap_time_of_day: boolean`. Each setter bumps a module-level
`recapPrefsVersion` counter exported as `getRecapPrefsVersion()` (B31.4's cache watermark reads it).

### Compute — `src/utils/runRecapCompute.ts` (new)
```ts
export const SESSION_GAP_MIN = 20;
// Witness test: import { isMachinePlay } from './machinePlay' (§0.2). Never a local list.
export const NIGHT_OWL_HOURS = [0, 5] as const;   // [from, to) local
export const EARLY_BIRD_HOURS = [5, 9] as const;
export const PER_DAY_MAX_DAYS = 14;               // longer spans bucket by week (Monday start)

export interface RecapScoreRow {
  history_id: number; key: string; iscored_username: string; discord_user_id: string | null;
  submitted_by_user_id: string | null; score: number; source: string; created_at: string;
}
export interface RecapStanding { key: string; rank: number; history_id: number | null; score: number; created_at: string | null }
export interface RecapPrefs { playStats: boolean; timeOfDay: boolean }

export interface ComputeInput {
  rows: RecapScoreRow[];                    // already filtered (§0.1), any order
  standings: RecapStanding[];               // board order
  prefs: Map<string, RecapPrefs>;           // missing key = defaults {true,false}
  timezone: string;
  state: 'active' | 'completed';
  start_date: string | null; end_date: string | null; close_at: string | null;
  attemptsUsed: Map<string, number> | null; // key → used (limited only)
  now: Date;
}
/** A RecapPlayerRow without the name/avatar fields: ids only (names are attached by the service). */
export type ComputedPlayerRow = Omit<RecapPlayerRow, 'iscored_username' | 'display_name' | 'discord_user_id' | 'avatar_hash' | 'avatar_url'>;
/** RunRecap minus run/refs/discord_text: ids only. */
export interface ComputedRunRecap {
  players: ComputedPlayerRow[];             // standings order
  totals: RunRecap['totals']; hero: RunRecap['hero']; lead_changes: RecapLeadChange[]; lead_steps: RecapLeadStep[];
  awards: RecapAward[]; per_day: RecapBucket[] | null; facts: RecapFacts;
  /** For the detail route: per key, the ordered games + sessions + hours (privacy already applied). */
  detail: Map<string, { games: RecapPlayerGame[]; sessions: RecapSession[]; hours: number[] | null }>;
}
export function computeRunRecap(input: ComputeInput): ComputedRunRecap;
// helpers, exported for tests:
export function dbTimeMs(s: string): number;
export function localDayKey(ms: number, tz: string): string;
export function localHour(ms: number, tz: string): number;
export function dayLabel(dayKey: string): string;                 // 'Fri 11/20' (en-US, computed from the key, zone-free)
export function medianOf(values: number[]): number;               // even n: mean of the middle two, rounded
export function sessionsOf(timesMs: number[]): Array<{ first: number; last: number; count: number; startIndex: number }>;
export function leadTimeline(rows: RecapScoreRow[]): { changes: Omit<RecapLeadChange, 'wins_it'>[]; steps: RecapLeadStep[] };
```
Algorithm notes (tests pin each):
- Sort rows by `(dbTimeMs(created_at), history_id)`.
- `leadTimeline`: running best per key; `leader = null`; for each row that raises its key's best: if no leader →
  `first`; else if key ≠ leader and best > leader's best → `takes_back` if key led before, else `takes_first`; if key
  = leader → step only. `wins_it` = last change AND state `completed`. The final leader MUST equal standings rank 1;
  if not (cache drift), log WARN once and trust the standings for hero/players, the timeline as computed.
- Personal bests: count of the player's Witness games that beat every earlier Witness game of theirs, **game #1
  included** (matches the reference run: two players with 8 each) — Q8.
- `days_played`, per-day: Witness games of visible players only. Per-day span = local day of the first Witness game
  → local day of `min(end_date ?? now, last row)`; zero days in between are listed; > 14 days → weeks; one day → null.
- `facts.comeback_ratio`: walk lead steps; from the eventual winner's first row on, track
  `(leaderBest - winnerBest) / leaderBest` while the winner is not leading; max of it; null if the winner led from
  their first score or < 2 players. `closest_finish_ratio` from standings 1 and 2.
- Players with `play_stats !== 'shown'`: stat fields null; excluded from totals/per_day/awards/facts.longest_streak
  and facts.most_games.

### Awards catalogue (B31.1 computes; B31.2 renders; Discord text prints)
Eligibility for every award: the player's `play_stats === 'shown'`, the stat is over Witness games only, and the
run has **>= 2 players with shown Witness games**. Ties: every tied player shares it (`player_keys` up to 3); **4 or
more tied → the award is omitted**. Order of the list = the order below; every qualifying award is in the payload (at most 9, one per id); the Discord text prints at most 9 and trims to 4 under its budget.

| id | label | rule | minimum | detail (no names) |
|---|---|---|---|---|
| `most_games` | Most games | max Witness games | 3 games | "122 games, all 7 days, 8.58 billion points in total" ("on 5 of 7 days" when not all) |
| `longest_streak` | Longest streak | max games in one session | 5 games | "19 games in 47 minutes" |
| `longest_session` | Longest session | max session minutes | session >= 3 games and >= 30 min; omitted when it is the same session as `longest_streak` | "15 games over 98 minutes" |
| `busiest_day` | Busiest day | max games by one player on one local day | 5 games | "32 games on Mon 11/23" |
| `most_personal_bests` | Most personal bests | max PB count (§ above) | 3 | "8" / "8 each" |
| `best_first_game` | Best first game | highest score on a player's Witness game #1 | >= 3 players with Witness games | "166.1M on game #1" + ", good for the lead" when that row is a lead change (`first`/`takes_first`/`takes_back`) |
| `most_consistent` | Most consistent | lowest coefficient of variation (population sd / mean) | 10 games | "half their games between 21.5M and 92.0M" (Q1..Q3) |
| `night_owl` | Night owl | most games with local hour in [0,5) | opted in to time-of-day; 5 games | "24 games between midnight and 5 am" |
| `early_bird` | Early bird | most games with local hour in [5,9) | opted in; 5 games | "12 games between 5 and 9 am" |

### Service — `src/services/RunRecapService.ts` (new)
```ts
export interface RunContext {
  roomId: string; gameId: string; gameName: string; status: string; startDate: string | null; endDate: string | null;
  roundNo: number | null; scheduledStartAt: string | null; scheduledEndAt: string | null;
  tournament: { id: string; name: string; type: string; format: 'rotation' | 'event'; cadence: string | null;
                witnessFlagMode: WitnessFlagMode; maxAttempts: number | null; roomSlug: string };
  isEventRound: boolean; timezone: string;
}
export class RunRecapService {
  /** null = not a run in this room (wrong room, pinned, QUEUED/SCHEDULED, missing). Selects explicit columns only (never t.*: invite_code). */
  static async loadRunContext(roomId: string, gameId: string): Promise<RunContext | null>;
  /** §0.1 rows, prevent-flagged rows removed for event rounds. */
  static async loadRunRows(ctx: RunContext): Promise<RecapScoreRow[]>;
  static async getRunRecap(roomId: string, gameId: string, opts?: { now?: Date }): Promise<RunRecap | null>;
  static async getPlayerRunDetail(roomId: string, gameId: string, playerKey: string): Promise<RecapPlayerDetail | null>;
  static async listLiveRuns(roomId: string, tournamentId: string): Promise<LiveRunsResponse | null>;
  /**
   * Bulk: every run in the room matching the filter, each computed with computeRunRecap (no discord_text), plus
   * one RecapPlayerRef per key seen (resolveProfiles on a representative row). B31.3 and B31.4 consume this; they
   * never re-query score rows themselves.
   */
  static async summarizeRuns(roomId: string, filter: {
    tournamentId?: string; gameName?: string; keys?: string[]; statuses?: Array<'ACTIVE' | 'COMPLETED' | 'ARCHIVED'>;
  }): Promise<{ runs: Array<{ run: RunRecap['run']; recap: ComputedRunRecap }>; refs: Map<string, RecapPlayerRef> }>;
}
```
`getRunRecap` steps: `loadRunContext` → `loadRunRows` → `LeaderboardService.getRunStandings([gameId])` (standings,
hydrated names; map each entry to a key via its `history_id` → row.key) → `PreferencesService.getRecapPrefsFor(keys)`
→ if limited, `AttemptService.usedByGame(tournamentId)[gameId]` (canonical id → key via the same identity-link
batch) → `computeRunRecap` → refs from the standings entries → `GameArtService.artForNames([gameName])` →
`buildRunRecapText(recap, { maxChars: 4000, link: tournamentRunRecapUrl(slug, tid, gameId) })`. `close_at` for an
active rotation run = `nextRotationIso(t.cadence, now, roomTz)` (src/utils/cronUtils.ts), for an active round =
`scheduledEndAt`.

`summarizeRuns` SQL (rotation runs; event rounds are loaded per round via `loadRunRows`, they are few):
```sql
SELECT g.id AS run_id, sh.id AS history_id,
       COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS key,
       sh.iscored_username, sh.discord_user_id, sh.submitted_by_user_id, sh.score, sh.source, sh.created_at
  FROM games g
  JOIN tournaments t ON t.id = g.tournament_id
  JOIN score_history sh
    ON sh.game_room_id = t.game_room_id
   AND sh.submitted_during_tournament_id = g.tournament_id
   AND LOWER(sh.game_name) = LOWER(g.name)
   AND sh.orphaned_at IS NULL
   AND ${gameRunWindowSql('sh', 'g')}
 WHERE t.game_room_id = ?
   AND g.status IN (/* filter.statuses, default ACTIVE, COMPLETED, ARCHIVED */)
   AND NOT (t.format = 'event' AND g.round_no IS NOT NULL)
   [AND g.tournament_id = ?] [AND LOWER(g.name) = LOWER(?)]
```
(Same join as `RankingService.computeRankings` / `AutoPickSignalService`.) Standings for all runs in ONE
`LeaderboardService.getRunStandings(runIds)` call. With `filter.keys`, keep only runs where one of the keys has a
row, but compute each kept run from ALL its rows (finish place needs everyone). Measure on a copy of the prod DB
(Mox's room): if > 300 ms, report it; do not add a cache in B31.1.

### Routes — `src/api/routes/recaps.ts` (new), mounted at `/api`
Every route: `roomVisibilityGate` explicitly (roomsRouter's `router.use('/:roomId', roomVisibilityGate)` also runs
first for `/api/rooms/:roomId/*`, as it does for `integrity.ts`; the explicit gate is belt-and-braces, as the events
routes do), `try/catch` → `logError` + 500, `req.params.x as string`, missing/wrong room → 404 `{error:'Run not found'}`.
| Method + path | Handler | Response |
|---|---|---|
| `GET /rooms/:roomId/runs/:gameId/recap` | `RunRecapService.getRunRecap` | `RunRecap` |
| `GET /rooms/:roomId/runs/:gameId/recap/players/:playerKey` | `getPlayerRunDetail` (`decodeURIComponent` the key; unknown key → 404) | `RecapPlayerDetail` |
| `GET /rooms/:roomId/tournaments/:tournamentId/runs/live` | `listLiveRuns` (ACTIVE runs, `openCardSql`) | `LiveRunsResponse` |

File layout, verbatim marker comments (later slices insert ONLY between their own markers; the blank lines between
blocks keep their git hunks apart):
```ts
// ===== B31.1: run recap =====
...routes...
// ===== end B31.1 =====


// ===== B31.3: player and table runs (B31.3 inserts here) =====
// ===== end B31.3 =====


// ===== B31.4: season recap and room records (B31.4 inserts here) =====
// ===== end B31.4 =====
export default router;
```
Public read, no auth needed. No rate limiter beyond the global `generalLimiter`.

### Discord text — `src/utils/runRecapText.ts` (new)
```ts
export const DISCORD_COPY_MAX = 4000;   // the owner pastes as a Nitro user
export const DISCORD_BOT_MAX = 2000;    // a bot message's content limit (Nitro does not apply to bots)
export function buildRunRecapText(recap: Omit<RunRecap, 'discord_text'>, opts: { maxChars: number; link?: string | null }): string;
/** Split at section boundaries ('\n## ') into <= maxChars chunks, never inside a code block; at most 3 chunks. */
export function splitRecapForBot(text: string, maxChars?: number): string[];
export function abbrevScore(n: number): string;   // 950 · 31.4K · 116.2M · 8.6B · 1.2T (1 decimal, trailing .0 kept as in "92.0M")
export function wordsScore(n: number): string;    // "8.58 billion" (3 significant digits; million/billion/trillion)
```
Format (mirrors lis_discord.md; names = `display_name ?? iscored_username`, never a key or id; NO emoji):
~~~
# <game_name> ▸ by the numbers
-# <tournament_name>[ · Round <n>] · <Fri Nov 20 – Thu Nov 26> · <G> games from <P> players on Arcaid Witness[ · so far]
## ▸ <Winner> wins with <best, en-US grouped digits>        (active: "leads with")
<hero sentence>
- <winner bullet>  (0-3)
## ▸ Lead changes
```
<Fri  8:04am  Name          31.4M  ← first score>
<...                                ← takes first | takes it back | <either>, wins it>
```
## ▸ Leaderboard
```
Player         Games    Avg  Median   Best
<rows in rank order; '—' for null>
```
## ▸ Awards
- **<label>:** <Name>[ and <Name>] — <detail>
## ▸ Games per day
```
Fri 11/20  79  ████████████████████
```
-# <footnote>
-# Full recap: <link>
~~~
(`<link>` is wrapped in angle brackets so Discord does not unfurl it.)

Rules:
- Subtitle: no Witness games → `-# <tournament> · <dates> · <N> players`. Date range: first row's local day →
  `end_date` local day (active: today); same day → one date. Event round adds `· Round <n>`.
- Hero sentence: Witness winning game & shown → `The winning score was game #22 of 22 (the last), Thursday around
  4 pm, about 7 hours before the close.`; typed/synced → `The winning score was typed in, Thursday around 4 pm, …`;
  hidden → `The winning score came Thursday around 4 pm, …`; active → `…, posted about 3 hours ago.` Hour rounds to
  the nearest hour; durations: < 60 min "N minutes", < 48 h "about N hours", else "N days".
- Winner bullets (winner shown, >= 2 Witness games): `Games by day: 16 Fri, 2 Sat, 4 Thu` (max 7 days);
  `Won it on game #4 of the day` (winning game is Witness and that day had >= 2 of theirs); `Half of their games
  scored 84.6M or more` (median). Neutral "their": never guess a pronoun.
- Lead list: time = `ddd h:mma` (hour space-padded to 2) when the run spans <= 6 local days, else `M/D h:mma`.
  Annotation: `first` → "first score", `takes_first` → "takes first", `takes_back` → "takes it back", plus
  ", wins it" on `wins_it`. More than 10 entries → first entry, a line `            … <k> more lead changes`, last 9.
- Leaderboard: max 10 rows; more → last line `+ <k> more players`. A row with `play_stats` hidden/none shows `—` in
  Games/Avg/Median.
- Awards: at most 7 bullets, catalogue order.
- Games per day: omitted when `per_day` is null. Bar = `█` × `max(1, round(games / max * 20))` (0 games → no bar).
- Footnote (always when the run has any score): `-# Games, averages and medians count only games recorded by Arcaid
  Witness; scores typed in or synced count for the standings and the lead.` + (hidden_players > 0) ` <k> players keep
  their play stats private.` + ` Times are <City> time.` where City = last segment of the IANA zone with `_` → space.
- No scores at all: title + subtitle + `No scores were posted in this run.` only.
- Code blocks: names with a backtick get `'` instead; names capped at 16 code points with `…` (player names only:
  game titles are never cut). Pad by code points. Outside code blocks escape backslash, `*`, `_`, `~`, `|` and the
  backtick exactly like `escapeMd` in `src/services/DiscordScorePostService.ts` (regex `/([\\*_~|`])/g`; copy it,
  it is module-private there).
- Budget: build, and while `length > maxChars` apply in order: leaderboard 10→7; lead list 10→6; awards 7→4; drop
  winner bullets; drop Games per day; leaderboard →5; then drop whole sections from the bottom (never the title,
  subtitle, hero header, footnote).

### FE shared libs
- `admin-ui/src/lib/recapFormat.ts` (new): `formatRecapScore(n)` (same tiers/output as BE `abbrevScore`; full value
  goes in `title` via `n.toLocaleString()`), `formatRecapDay(dayKey)`, `formatRecapTime(iso, tz)` (Intl with
  `timeZone`), `formatDuration(ms)`. Both formatters are tested against the same case table.
- `admin-ui/src/components/RecapPrivacySection.tsx` (new), modelled on `components/GlobalSharingSection.tsx`
  (player client `playerApi`, optimistic toggle with rollback, renders after load): `<Panel id="run-recaps" title="Run
  recaps">`, two checkboxes:
  - "Show my play stats in run recaps" (default on) — "Games played, averages, sessions, streaks and games per day.
    Your best score and finishing place always show."
  - "Show when I play" (default off) — "Lets you win time-of-day awards like Night owl, and shows the time of each of
    your games in your run detail."

### Edge cases (B31.1 owns them; tests below)
0 scores (recap with empty players, hero nulls, empty text body) · 1 score (one `first` change, `wins_it` when
completed, no awards) · all typed (witness totals 0, `per_day` null, no awards, `play_stats: 'none'`) · ties on best
(rank by board; tie does not take the lead) · player with 1 Witness game (avg = median = best, sessions 1, PB 1, no
streak/session award) · winner hidden (hero numbers null, no bullets) · winner's best typed (`winning_game_no` null)
· re-run table (two runs, same tournament: each recap only its window) · event round under `prevent` (flagged rows
gone everywhere) and under `flag` (kept) · legacy run with `start_date` NULL (unbounded window; per-day switches to
weeks past 14 days) · DST: a run across 2026-11-01 in America/Chicago buckets days correctly · active run
(`state 'active'`, "so far", no `wins_it`) · ARCHIVED run (completed).

### Tests (vitest, backend under `src/__tests__/`)
| File (new) | Covers | Copy setup from |
|---|---|---|
| `run-recap-compute.test.ts` | pure: session gap boundary (20:00 same, 20:01 new), median odd/even, lead timeline (strict >, self-improvement = step only, takes_back), PB count incl. game #1, per-day/zero days/DST/weeks, every award's minimum, 3-way tie shared, 4-way omitted, night owl only for opted-in, hidden excluded from totals/per_day, `none` rows | — |
| `run-recap-lis.test.ts` | an ANONYMIZED fixture of the reference run (`src/__tests__/fixtures/run-recap-lis.json`: names → Player A…, ids → fake snowflakes, scores and times kept; Q3) reproduces 335 games / 11 players, winner-equivalent 22 games avg 116,170,221 median 84,578,100, 7 lead changes in the reference order and annotations, the reference per-day counts (79, 43, 43, 80, 9, 42, 39), streak-player-equivalent streak 19 in 47 min, session-player-equivalent session 98 min | `history-weeks.test.ts` (seeding) |
| `run-recap-api.test.ts` | supertest on the router: 404 wrong room / pinned / QUEUED / unknown key; recap ranks == `getRunStandings` ranks; re-run window; a `deleteEvent` removes a row from the next read; a correction changes best; JSON of an opted-out player has `null` stats AND their games are absent from `totals`/`per_day`; time-of-day opt-in shows `time` + night owl; limited tournament `attempts_used`; event round `prevent` vs `flag`; approval room refuses a signed-out read | `history-weeks.test.ts`, `game-run-window.test.ts`, `witness-event-board-verdicts.test.ts` (prevent setup) |
| `run-recap-text.test.ts` | LIS fixture text matches the section shape of lis_discord.md (title, subtitle, sections, annotations, bars); synthetic 60-player / 40-change / long-name run ≤ 4000; `splitRecapForBot` chunks ≤ 2000 and never split a code block; no emoji (`/\p{Extended_Pictographic}/u` finds nothing); no key/snowflake appears in the text; markdown in names escaped | — |
| `recap-preferences.test.ts` | GET/POST `/me/preferences` round-trip both keys, defaults (true/false), only-what-was-sent, `getRecapPrefsFor` canonical/raw union | `global-sharing-preference.test.ts` |
| `migration-224-run-recaps.test.ts` | idempotent twice; columns + table exist | `migration-164-score-history-nullable.test.ts` |
| `runRecap-types-parity.test.ts` | §1 parity | — |
FE: `admin-ui/src/components/__tests__/RecapPrivacySection.test.tsx` (defaults, toggle posts the one key, rollback
on failure), `admin-ui/src/lib/__tests__/recapFormat.test.ts`. Run `npm run docs:check`.

---

## B31.2 — The recap on the run view (FE only)

**Goal:** `/:slug/tournaments/:tid?run=<gameId>&recap=1` shows the run's recap; run cards link to it; active runs
are reachable as "so far".

### Placement
- `TournamentDetail.tsx`: when `params.get('recap') === '1'` and `params.get('run')` is set (Runs view), render
  `<RunRecapView roomId slug tournamentId gameId />` instead of `<RunFeed>`, with a back link "← All runs" that
  removes `recap` and keeps `run` (the feed then opens on that run's week, existing behaviour). The Runs/By table
  switcher stays; `setView` already drops every other param.
- Runs view (no `recap`): `<LiveRunsStrip>` above the feed — `GET /api/rooms/:roomId/tournaments/:tid/runs/live`;
  one chip per ACTIVE run "<Table> · so far →" to `tournamentRecapPath`. Renders nothing when empty.
- `RunFeed.tsx` `RunCard`: a "By the numbers" link (`Button`-styled `ButtonLink` size `xs`, secondary) under the
  winner line, to `tournamentRecapPath(slug, run.tournament_id, run.game_id)`, only when `run.tournament_id` and
  `players > 0`. History (shared RunFeed) gets it too.

### Files
Create: `admin-ui/src/components/recap/` — `RunRecapView.tsx`, `RecapHero.tsx`, `WhoLedChart.tsx`,
`LeadChangeList.tsx`, `RecapPlayerTable.tsx`, `PlayerRunDetail.tsx`, `RecapAwards.tsx`, `GamesPerDay.tsx`,
`LiveRunsStrip.tsx`, `CopyForDiscordButton.tsx`; `admin-ui/src/lib/chartScale.ts` (move `formatAxisScore`,
`niceStep`, `yScaleFor` out of `ScoreHistoryChart.tsx`, export them, import them back there — no behaviour change).
Modify: `pages/TournamentDetail.tsx`, `components/results/RunFeed.tsx`, `components/ScoreHistoryChart.tsx`
(imports only), `.claude/rules/recaps.md` (B31.2 section).

### Components (props)
```ts
RunRecapView({ roomId, slug, tournamentId, gameId }: { roomId: string; slug: string | undefined; tournamentId: string; gameId: string })
RecapHero({ recap }: { recap: RunRecap })
WhoLedChart({ steps, changes, players, run }: { steps: RecapLeadStep[]; changes: RecapLeadChange[]; players: RecapPlayerRow[]; run: RunRecap['run'] })
LeadChangeList({ changes, players, timezone }: {...})
RecapPlayerTable({ players, onOpen }: { players: RecapPlayerRow[]; onOpen: (key: string) => void })
PlayerRunDetail({ roomId, gameId, player, open, onClose }: { roomId: string; gameId: string; player: RecapPlayerRow; open: boolean; onClose: () => void })
RecapAwards({ awards, players }: { awards: RecapAward[]; players: RecapPlayerRow[] })
GamesPerDay({ buckets }: { buckets: RecapBucket[] })
LiveRunsStrip({ roomId, slug, tournamentId }: {...})
CopyForDiscordButton({ text }: { text: string })
```
- Load: `useRetryingLoad` + `roomFetch` (`lib/loadRetry.ts` rules; `Skeleton` in the content's shape while
  `loading`, `LoadFailedNotice` while `retrying`; 404 → `EmptyState` "This run has no recap" with a link back).
  An ACTIVE run shows "So far" beside the title, "Updated <time>" and a `Button` "Refresh" (no socket: the page
  emits no `join:room`, so `useLiveRefresh` does not apply).
- Look: themed room page → shared parts (`Panel`/`PanelGroup` tone `cyan`, `StatTiles` for Players / Witness games /
  Lead changes / Days, `Button`, `Dialog` with `sheet` for the player detail, `EmptyState`, `Skeleton`, `ListRow`
  for awards). No hex/rgb/oklch; no library default look (ADR 0042); no text under 12 px; name transition
  properties; game titles wrap (`break-words`), never ellipsized; names via `playerName()` + `PlayerAvatar`; first
  place gold (`neon-amber`).
- **Hero:** `GameArt`, title (wraps), tournament + local date range, winner avatar + name (gold), best
  `formatScore` (full digits), the hero sentence's facts as a caption ("Game #22 of 22 · about 7 hours before the
  close"; typed → "Typed in"; hidden → no game number).
- **Who led (step chart):** hand-rolled inline SVG like `ScoreHistoryChart` (ResizeObserver width, `chartScale`
  helpers, theme tokens only). x = time from `start_date` (else first row) to `end_date` (active: now), y = leading
  score. One horizontal segment per `lead_steps` interval, coloured by its leader; risers neutral
  (`--color-border`). Colours: the eventual winner = `--color-neon-amber`; other leaders in order of first lead:
  `neon-cyan`, `neon-magenta`, `neon-green`, `neon-purple`, `neon-blue`, then cycling (coral is danger: never).
  Direct labels (leader name at the start of a segment when >= 64 px wide), a dot per lead change with a tooltip on
  hover/tap/focus (`<g tabIndex=0 role="img" aria-label="Fri 8:04 am, Player A takes first with 31.4M">`), and
  `LeadChangeList` underneath as the text equivalent (`<ol>`). One step (single leader) still draws; zero → no chart.
- **Player table:** semantic `<table>`; columns Player, Games, Avg, Median, Best; default order = rank; header
  buttons sort (aria-sort; numeric desc first; nulls last); cells `formatRecapScore` with full value in `title`;
  `—` for null with a footnote marker: `none` → "Typed in or synced only", `hidden` → "Keeps play stats private".
  Row is a button (keyboard and tap) → `PlayerRunDetail`. Fits 360 px: Player column flexible (names may truncate;
  game titles never), numbers `tabular-nums`, no horizontal page scroll.
- **Player detail (`Dialog sheet`):** fetches `/recap/players/:key` once per open. Header: avatar, name, best,
  finish. Shown players: games in order as a compact bar strip (one bar per Witness game, index-scaled — NOT
  time-scaled, so a non-opted-in player's times are not drawn), PBs marked, best marked gold; a list "Game n · score
  · day[ · time]" with typed rows labelled "Typed in"; sessions list "Session 3 · 11 games · 37 min · best 120.1M";
  `attempts_used` as "12 of 20 attempts" when present; hour histogram only when `hours`. Hidden/none: best + finish
  + the reason line only. This replaces the 50-row-capped history expand (`ScoreHistoryService.getPlayerGameHistory`)
  for run purposes; GameDetail's expand stays as is.
- **Awards:** one `ListRow` per award: label, names (joined "and"), detail.
- **Games per day:** a list of rows `label · count · bar` (bar = a token-coloured div, width % of max); numbers are
  visible text (accessible without the bars).
- **Copy for Discord:** `Button` secondary "Copy for Discord" → `navigator.clipboard.writeText(recap.discord_text)`
  with the `ShareButton` fallback chain (textarea + `execCommand('copy')`); success toast "Copied — paste it in
  Discord" via `useToast().toast(...)`; failure toast error. Visible to everyone (Q5).

### Tests
`admin-ui/src/components/recap/__tests__/RunRecapView.test.tsx` (mock `roomFetch`; hero, typed and hidden notes,
sorting, detail opens and fetches the key route, copy calls clipboard with `discord_text`, active "So far" + Refresh,
404 empty state), `WhoLedChart.test.tsx` (segments == steps, dots == changes, winner segment uses
`var(--color-neon-amber)`, no hex in the markup), `LiveRunsStrip.test.tsx`; update
`components/results/__tests__/RunFeed.test.tsx` (link present / absent with 0 players) and
`pages/__tests__/TournamentDetail.test.tsx` (`?run=x&recap=1` renders the recap, back link drops `recap`);
`components/__tests__/ScoreHistoryChart.test.tsx` must pass unchanged. Run `npx vitest run` in admin-ui, build, lint
(per-file counts vs HEAD).

---

## B31.3 — A player's runs (PlayerDetail) and a table's runs (GameDetail)

### Backend — `src/services/RunRollupService.ts` (new)
```ts
export class RunRollupService {
  /** identifier = provider id (isProviderUserId) or an iScored/room name, exactly like /stats/enhanced/player/:identifier. */
  static async playerRuns(roomId: string, identifier: string): Promise<PlayerRunsResponse>;
  static async tableRuns(roomId: string, gameName: string): Promise<TableRunsSummary>;
}
```
- `playerRuns`: keys = provider id → `[id]`; a name → `[user_mappings.discord_user_id (NOCASE) if any,
  'iscored:' + lower(name)]`. `RunRecapService.summarizeRuns(roomId, { keys })`; per run take the player's row
  (if two keys appear in one run, the better finish). `play_stats` from `getRecapPrefsFor`; hidden → `games`,
  `average`, `best_game_no` null. `field` = standings size. Newest first by `end_date` (active first).
- `tableRuns`: `summarizeRuns(roomId, { gameName, statuses: ['COMPLETED','ARCHIVED'] })` (+ ACTIVE excluded);
  `typical_winning_score` = median of rank-1 bests; `median_game` = median of visible Witness game scores across
  runs (`null` if none); `most_games_in_run` = max over runs of `facts.most_games`; `recent` max 10.
- Routes (inside the B31.3 markers of `src/api/routes/recaps.ts`):
  `GET /rooms/:roomId/players/:identifier/runs` → `PlayerRunsResponse`;
  `GET /rooms/:roomId/tables/:gameName/runs` → `TableRunsSummary` (`decodeURIComponent` both params).

### Frontend
- Create `admin-ui/src/components/recap/PlayerRunsList.tsx` (`{ roomId, slug, identifier }`): section "Runs" —
  one line per run: `GameArt` 40, table name (wraps), tournament name, then "22 games · avg 116.2M · best 492.3M
  (game #22) · 1st of 11"; hidden → "best 492.3M · 1st of 11"; each line links to `tournamentRecapPath`. 20 lines,
  then "Show all". `EmptyState` when none.
- Create `admin-ui/src/components/recap/TableRunsPanel.tsx` (`{ roomId, slug, gameName }`): `StatTiles` Runs /
  Typical winning score / Median game / Most games in one run (+ name), then the recent runs as links. Renders
  nothing when `runs === 0`.
- Modify `pages/PlayerDetail.tsx`: mount `<PlayerRunsList identifier={id} …/>` after the "Recent Scores" section.
- Modify `pages/GameDetail.tsx`: mount `<TableRunsPanel gameName={name} …/>` directly before the "Past Results"
  section (around the `stats.recentResults` block). Both via `useRetryingLoad` + `roomFetch`.

### Edge cases
Player only in typed runs (lines with `games: null`, note) · player in a run twice under two keys (alias) · table
with only active runs (panel hidden) · event rounds of the table in an event tournament are included (they are runs).

### Tests
`src/__tests__/run-rollups.test.ts` (keys by id and by name; finish/field; hidden nulls; table medians; re-run
windows) copying `history-weeks.test.ts`; FE `pages/__tests__/PlayerDetail.test.tsx` (runs section, hidden line) and
new `pages/__tests__/GameDetailTableRuns.test.tsx` copying `GameDetailLoadRetry.test.tsx` mocks.

---

## B31.4 — Season recap (tournament page) and room records (Stats)

### Backend — `src/services/SeasonRecapService.ts` (new)
```ts
export class SeasonRecapService {
  static async seasonRecap(roomId: string, tournamentId: string): Promise<SeasonRecap | null>;  // null = not in room
  static async roomRecords(roomId: string): Promise<RoomRecordsResponse>;
}
```
Both reduce `RunRecapService.summarizeRuns` output; never query score rows themselves.

Season awards (completed runs only; same tie rule as runs: <= 3 share, 4+ omitted):
| id | label | rule | minimum |
|---|---|---|---|
| `most_runs_won` | Most runs won | count of rank-1 finishes | 2 |
| `played_every_table` | Played every table | players with a score (any source) in every completed run | >= 3 runs; > 3 players → `player_keys` empty, detail "7 players" |
| `most_games` | Most games | sum of shown Witness games | 10 |
| `closest_finish` | Closest finish | min `facts.closest_finish_ratio` | 2 players; `run` set; detail "0.4% between first and second" |
| `most_lead_changes` | Most lead changes | max `facts.lead_changes` | 3; `run` set |
| `biggest_comeback` | Biggest comeback | max `facts.comeback_ratio`, winner's key | >= 0.25; `run` set; detail "was 61% behind the lead" |
| `biggest_margin` | Biggest winning margin | max `1 - 2nd/1st` | 2 players; `run` set (replaces "best single score", Q2) |
`standings`: per player runs played, runs won, podiums (rank <= 3), games (null when hidden).

Room records (all completed runs of the room): `longest_streak` (max `facts.longest_streak.games`),
`most_games_in_run` (`facts.most_games`), `most_lead_changes`, `biggest_comeback`, `closest_finish` — each with
its `run` link. Cache: `Map<roomId, { watermark: string; value: RoomRecordsResponse-minus-refs }>`, watermark =
`SELECT COUNT(*), COALESCE(MAX(id),0), COALESCE(SUM(score),0) FROM score_history WHERE game_room_id = ?` +
`SELECT COUNT(*), MAX(end_date) FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE t.game_room_id = ?
AND g.status IN ('COMPLETED','ARCHIVED')` + `getRecapPrefsVersion()`. (A delete changes COUNT, a correction changes
SUM, a prefs change bumps the version.) Refs resolve after the cache read, never cached.

Routes (inside the B31.4 markers): `GET /rooms/:roomId/tournaments/:tournamentId/recap` → `SeasonRecap`;
`GET /rooms/:roomId/stats/records` → `RoomRecordsResponse`.

### Frontend
- Create `admin-ui/src/components/recap/SeasonRecapView.tsx` (`{ roomId, slug, tournamentId }`): `StatTiles`
  (Runs, Players, Witness games, Lead changes), awards (`ListRow`, run awards link to `tournamentRecapPath`),
  standings table (Player, Runs, Won, Podiums, Games).
- Modify `pages/TournamentDetail.tsx`: a third tab button "By the numbers" (`?view=numbers`), rendering
  `<SeasonRecapView>`; `view` type becomes `'runs' | 'tables' | 'numbers'`; the select keeps the view. **Rebase on
  B31.2 first** (same file).
- Create `admin-ui/src/components/stats/RoomStatsView.tsx` (the shell of B7's planned third tab, section order:
  Records first; B7 later adds its sections here) and `admin-ui/src/components/stats/RoomRecordsSection.tsx`.
- Modify `pages/PublicStats.tsx`: `View` gains `'room'` (`?view=room`), a third `role="tab"` button "Room" (icon
  `Trophy`), rendering `<RoomStatsView>`; the search box hides on `room`.

### Tests
`src/__tests__/season-recap.test.ts`, `src/__tests__/room-records.test.ts` (cache reused when nothing changed;
invalidated by a delete, a correction, an opt-out) copying `history-weeks.test.ts`; FE
`components/recap/__tests__/SeasonRecapView.test.tsx`, update `pages/__tests__/PublicStats.test.tsx` (room tab) and
`pages/__tests__/TournamentDetail.test.tsx` (numbers tab).

---

## B31.5 — Post the recap to Discord when a run ends (fifth announce kind, off by default)

**Design: a per-minute sweep, not a hook in the close paths.** Runs close in five places
(`TournamentEngine.processSlotMaintenance` ~line 1604, `activateGame` with `completeExisting` inside callers'
transactions ~line 200, `deactivateGame` ~line 585, `EventScheduler` round close/skip ~lines 377 and 466). A sweep
is after COMMIT by construction, covers every path, waits for late Witness reports, and needs no edit to
`TournamentEngine.ts` (WORK.md's "touches" line for B31.5 should drop it).

### Files
Create: `src/utils/discordRunRecaps.ts` (`DISCORD_RUN_RECAPS_ENABLED_KEY = 'DISCORD_RUN_RECAPS_ENABLED'`,
`parseRunRecapsEnabled(raw)`: `'true'` = on, anything else off — same shape as `parseScorePostsEnabled`),
`src/services/RunRecapPostService.ts`, `admin-ui/src/components/DiscordRunRecapPosts.tsx`.
Modify: `src/utils/discordAnnounceRoutes.ts` (`AnnounceKind` += `'recaps'`; `ANNOUNCE_KINDS` += `{ kind: 'recaps',
label: 'Run recaps', description: 'By-the-numbers recap when a run ends' }`; `EMPTY` += `recaps: null`),
`src/utils/discord.ts` (`resolveAnnouncementChannelId`: room route fallback becomes
`roomRoutes[kind] ?? ((kind === 'scores' || kind === 'recaps') ? roomRoutes.tournament : null)`),
`src/engine/Scheduler.ts` (`startRunRecapPostSweep()`, per minute, reentrancy flag like
`startEngagementReminderSweep`, called from `start()` beside it), `src/utils/activityDiff.ts` (label
`DISCORD_RUN_RECAPS_ENABLED: 'Post run recaps to Discord'`; not default-on), `admin-ui/src/lib/announceRoutes.ts`
(mirror the kind), `admin-ui/src/pages/Settings.tsx` (claim the key in the managed-keys list beside
`DISCORD_SCORE_POSTS_*`; mount `<DiscordRunRecapPosts settings onSaveNow={saveSettingsNow} />` after
`<DiscordScorePosts>` under the same `category === 'Discord' && DISCORD_GUILD_ID` guard), `.claude/rules/discord.md`
(the kinds line: five kinds), `.claude/rules/recaps.md` (B31.5 section). `DiscordAnnounceRoutes` and
`TournamentAnnounceRoutes` pick the new row up from `ANNOUNCE_KINDS` with no edit.

### `RunRecapPostService` (new)
```ts
export const RECAP_POST_SETTLE_MS = 10 * 60_000;   // wait for late Witness reports / final sync
export const RECAP_POST_MAX_AGE_MS = 6 * 3_600_000; // never post history when the switch is turned on, or after long downtime
export class RunRecapPostService {
  static async sweep(now?: Date): Promise<{ posted: number; skipped: number; failed: number }>;
}
```
Sweep:
1. Candidates: `games g JOIN tournaments t` where `g.status IN ('COMPLETED','ARCHIVED')`, `t.game_room_id IS NOT
   NULL`, `julianday(g.end_date)` between `now - MAX_AGE` and `now - SETTLE`, `NOT EXISTS (SELECT 1 FROM
   run_recap_posts p WHERE p.game_id = g.id)`. Batch the rooms' `DISCORD_RUN_RECAPS_ENABLED`
   (`GameRoomSettingsService.getManyForRooms`); drop rooms that are off (no ledger row for them).
2. Claim: `INSERT OR IGNORE INTO run_recap_posts (game_id, game_room_id, status, claimed_at) VALUES (?, ?,
   'claimed', ?)`; continue only when `changes === 1` (at most once, across ticks and processes).
3. Channel: `resolveAnnouncementChannelId(roomId, t.discord_channel_id, 'recaps', t.discord_announce_routes)`;
   null → `status 'skipped', reason 'no_channel'`.
4. `RunRecapService.getRunRecap(roomId, gameId)`; null or no players → `skipped`, `reason 'no_scores'`.
5. `splitRecapForBot(buildRunRecapText(recap, { maxChars: DISCORD_COPY_MAX, link }), DISCORD_BOT_MAX)`; first chunk
   `sendChannelMessage(channelId, chunk, { threadName: '<game> by the numbers', noMentions: true })`; the rest into
   `result.threadId ?? channelId`. Any `void` result (send failed; `sendChannelMessage` already logged it and wrote
   the bot-failure activity row) → `status 'failed'`, no retry. Else `status 'posted'`, `channel_id`,
   `message_ids`, `finished_at`.
`DiscordRunRecapPosts.tsx` mirrors `DiscordScorePosts.tsx`'s toggle (instant save, `''` = off): "Post run recaps to
Discord" — "When a run ends, the bot posts its By the numbers recap to the Run recaps channel (or the Tournament
posts channel)."

### Edge cases
Switch off (no ledger row, so turning it on later still posts runs that ended inside the 6 h window) · tournament
Announcements "Don't post" (catch-all `'none'` or route `'none'`) → skipped · Discord off for the room → skipped ·
forum channel → one post, extra chunks in its thread · event rounds post like rotation runs (Q6) · Throwdowns and
pinned boards never qualify · two processes/ticks → one post (claim).

### Tests
`src/__tests__/run-recap-posts.test.ts` copying `discord-score-posts.test.ts` mocks: off by default; on → one post;
second sweep no-op; concurrent sweeps → one send; settle and max-age bounds; `'none'` route → skipped; room route
fallback to `tournament`; forum chunks into the thread; every chunk <= 2000 with `allowed_mentions: {parse: []}`.
Update `src/__tests__/discord-announce-routes-tournament.test.ts` (five kinds) and
`admin-ui/src/components/__tests__/DiscordScorePosts.test.tsx`-style new `DiscordRunRecapPosts.test.tsx`; any FE test
that counts announce rows.

---

## 2. File-overlap matrix and build order

| File | B31.1 | B31.2 | B31.3 | B31.4 | B31.5 |
|---|---|---|---|---|---|
| `src/types/runRecap.ts`, `admin-ui/src/lib/runRecapTypes.ts` | create | read | read | read | read |
| `src/utils/runRecapCompute.ts`, `runRecapText.ts`, `src/services/RunRecapService.ts` | create | — | read | read | read |
| `src/api/routes/recaps.ts` | create (+markers) | — | own block | own block | — |
| `src/api/server.ts`, `src/database/database.ts`, `PreferencesService.ts`, `schemas.ts`, `global.ts`, `EventResultService.ts`, `publicLinks.ts` | edit | — | — | — | — |
| `admin-ui/src/lib/tournamentLinks.ts`, `lib/recapFormat.ts` | edit/create | read | read | read | — |
| `admin-ui/src/pages/AccountSettings.tsx` | edit | — | — | — | — |
| `admin-ui/src/pages/TournamentDetail.tsx` | — | **edit** | — | **edit** | — |
| `admin-ui/src/components/results/RunFeed.tsx`, `ScoreHistoryChart.tsx`, `lib/chartScale.ts` | — | edit | — | — | — |
| `admin-ui/src/components/recap/*` | — | create (run view) | create (2 files) | create (1 file) | — |
| `admin-ui/src/pages/PlayerDetail.tsx`, `GameDetail.tsx` | — | — | edit | — | — |
| `admin-ui/src/pages/PublicStats.tsx`, `components/stats/*` | — | — | — | edit/create | — |
| `src/services/RunRollupService.ts` | — | — | create | — | — |
| `src/services/SeasonRecapService.ts` | — | — | — | create | — |
| `discordAnnounceRoutes.ts`, `discord.ts`, `Scheduler.ts`, `activityDiff.ts`, `lib/announceRoutes.ts`, `Settings.tsx`, `RunRecapPostService.ts` | — | — | — | — | edit/create |
| `.claude/rules/recaps.md` | create (5 sections) | own section | own section | own section | own section |
| `CHANGELOG.md`, `package.json`, `package-lock.json` | bump | bump | bump | bump | bump |

**Build order**
1. **B31.1 alone**, merged and deployed (it ships the prefs UI and the API; nothing else visible).
2. Then in parallel worktrees: **B31.2**, **B31.3**, **B31.5**, and **B31.4's backend + Stats tab**.
3. **B31.4's TournamentDetail tab** after B31.2 merges (rebase; the only true overlap). If B31.4 finishes first,
   B31.2 rebases instead.
Shared every time: the version slot (CLAUDE.md "Two open PRs share one version slot": the second squash carries the
higher version, both CHANGELOG blocks kept) and `recaps.md` (each slice writes only inside its pre-made section).
Each worktree: `npm run build`, admin-ui `npm ci` + `npm run build` + `npx vitest run` + per-file lint vs HEAD,
`npm run docs:check`, CRLF check (`git diff --numstat` vs `-w --numstat`).

---

## 3. Open questions — DECIDED (lead, 2026-11-26): build every default in brackets as written

1. **Rotation aliases.** Rotation boards key on `COALESCE(submitted_by_user_id, 'iscored:'||lower(name))` with no
   `user_mappings` join, so an unowned synced alias row in a frozen (finished) tournament stays a separate standings
   line. The recap matches the board [match the board; changing the board is out of scope].
2. **"Best single score" across a season** compares different tables' scores, which are not comparable. [Replaced by
   "Biggest winning margin"; confirm or name another.]
3. **Test fixture**: commit an anonymized copy of the Lost in Space run (real scores and times, names and ids
   replaced) as `src/__tests__/fixtures/run-recap-lis.json`? [yes]
4. **Own hidden stats**: should a signed-in player who opted out still see their own play stats? [no in v1: the
   routes are public reads and carry no viewer.]
5. **Copy for Discord** for everyone or room admins only? [everyone]
6. **Event rounds in Discord**: post a recap per round, or rotation runs only? [both; per-tournament "Don't post" on
   the Run recaps row silences one tournament]
7. **Bot posts are limited to 2,000 characters** (Nitro's 4,000 does not apply to bots): the auto-post goes out as up
   to 3 messages split at section boundaries. [split; the alternative is one shortened message]
8. **Personal bests count game #1** (reference run: two players with 8 each). [count it]
9. **Night owl window**: the reference named the peak hour ("midnight and 1 am"); the plan uses fixed windows
   (night owl 00:00–05:00, early bird 05:00–09:00). [fixed windows]
10. **Lead-change times** stay public for every player (standings facts in the owner's own format), while per-game
    times in a player's detail need the time-of-day opt-in. [as stated]
11. **Witness rows carry the game's END time**, so copy says "games between …", never "started". A start time exists
    only in `witness_evidence`/observations; not worth the join for v1. [end times]
12. **Prevent-mode flagged rows** are removed from play counts too, not only from the standings. [removed everywhere]
