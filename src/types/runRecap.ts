/**
 * Run recap types (B31, docs/run-recap-plan.md section 1). Types only: no imports,
 * no runtime code. The body below is mirrored byte-identically in
 * admin-ui/src/lib/runRecapTypes.ts and locked by runRecap-types-parity.test.ts.
 */

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
