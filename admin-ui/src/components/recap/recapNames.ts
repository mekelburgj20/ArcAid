import { playerName } from '../ScoreboardComponents';
import type { RecapLeadKind, RecapLeadStep, RecapPlayerRef } from '../../lib/runRecapTypes';

/** "A", "A and B", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The label for a key in a recap's players (display name, else the board name). */
export function nameForKey(players: RecapPlayerRef[], key: string): string {
  const p = players.find(x => x.key === key);
  return p ? playerName(p) : 'A player';
}

export const LEAD_VERB: Record<RecapLeadKind, string> = {
  first: 'posts the first score',
  takes_first: 'takes first',
  takes_back: 'takes first back',
};

const OTHER_COLORS = [
  'var(--color-neon-cyan)',
  'var(--color-neon-magenta)',
  'var(--color-neon-green)',
  'var(--color-neon-purple)',
  'var(--color-neon-blue)',
];
const WINNER_COLOR = 'var(--color-neon-amber)';

/** Winner gold; everyone else by order of first lead. */
export function leaderColors(steps: RecapLeadStep[], winnerKey: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (winnerKey) map.set(winnerKey, WINNER_COLOR);
  let i = 0;
  for (const s of steps) {
    if (!map.has(s.player_key)) map.set(s.player_key, OTHER_COLORS[i++ % OTHER_COLORS.length]!);
  }
  return map;
}
