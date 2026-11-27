import type { RecapPlayerRow, RunRecap } from '../../../lib/runRecapTypes';

function player(over: Partial<RecapPlayerRow> & Pick<RecapPlayerRow, 'key' | 'rank' | 'best'>): RecapPlayerRow {
  return {
    iscored_username: over.key, display_name: null, discord_user_id: null, avatar_hash: null, avatar_url: null,
    best_at: '2026-11-20T15:00:00.000Z', best_source: 'witness', play_stats: 'shown',
    games: 10, average: 5_000_000, median: 4_000_000, sessions: 2, personal_bests: 3, days_played: 2,
    best_game_no: 4, attempts_used: null,
    ...over,
  };
}

/** A hand-written completed run: 3 players (shown, typed-only, hidden), 3 lead steps, 2 awards, 2 days. */
export function makeRecap(over: Partial<RunRecap> = {}): RunRecap {
  return {
    version: 1,
    run: {
      game_id: 'g-1', game_name: 'Lost in Space', tournament_id: 't-1', tournament_name: 'Season 06',
      tournament_type: 'WK', format: 'rotation', round_no: null, state: 'completed',
      start_date: '2026-11-20T06:00:00.000Z', end_date: '2026-11-22T06:00:00.000Z', close_at: '2026-11-22T06:00:00.000Z',
      timezone: 'America/Chicago', image_url: null, max_attempts: null,
    },
    totals: { players: 3, witness_games: 24, witness_players: 1, hidden_players: 1, other_only_players: 1 },
    hero: {
      winner_key: 'ann', best: 31_400_000, best_at: '2026-11-21T20:00:00.000Z', best_source: 'witness',
      winning_game_no: 22, winner_games: 22, ms_before_close: 7 * 3_600_000, winner_days: null, game_of_day: 5,
    },
    players: [
      player({ key: 'ann', rank: 1, best: 31_400_000, display_name: 'Ann A', games: 22, average: 9_000_000, median: 8_000_000 }),
      player({
        key: 'bob', rank: 2, best: 20_000_000, play_stats: 'none', best_source: 'other', games: null, average: null,
        median: null, sessions: null, personal_bests: null, days_played: null, best_game_no: null,
      }),
      player({
        key: 'cy', rank: 3, best: 10_000_000, play_stats: 'hidden', games: null, average: null,
        median: null, sessions: null, personal_bests: null, days_played: null, best_game_no: null,
      }),
    ],
    lead_changes: [
      { at: '2026-11-20T14:00:00.000Z', player_key: 'bob', score: 12_000_000, kind: 'first', wins_it: false },
      { at: '2026-11-21T14:00:00.000Z', player_key: 'ann', score: 20_000_001, kind: 'takes_first', wins_it: true },
    ],
    lead_steps: [
      { at: '2026-11-20T14:00:00.000Z', player_key: 'bob', score: 12_000_000 },
      { at: '2026-11-21T14:00:00.000Z', player_key: 'ann', score: 20_000_001 },
      { at: '2026-11-21T20:00:00.000Z', player_key: 'ann', score: 31_400_000 },
    ],
    awards: [
      { id: 'most_games', label: 'Most games', player_keys: ['ann'], value: 22, detail: '22 games, 2 days' },
      { id: 'longest_streak', label: 'Longest streak', player_keys: ['ann', 'bob'], value: 9, detail: '9 games in a row' },
    ],
    per_day: [
      { kind: 'day', key: '2026-11-20', label: 'Fri 11/20', games: 4 },
      { kind: 'day', key: '2026-11-21', label: 'Sat 11/21', games: 20 },
    ],
    facts: { closest_finish_ratio: 0.3, comeback_ratio: null, lead_changes: 1, longest_streak: null, most_games: null },
    discord_text: '## Lost in Space recap',
    generated_at: '2026-11-22T07:00:00.000Z',
    ...over,
  };
}
