import { formatRecapScore } from './recapFormat';
import type { PlayerRunLine } from './runRecapTypes';

export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "22 games · avg 116.2M · best 492.3M (game #22) · 1st of 11"; hidden or typed-only drops the game parts. */
export function runLineText(r: PlayerRunLine): string {
  const parts: string[] = [];
  if (r.games != null) {
    parts.push(`${r.games} ${r.games === 1 ? 'game' : 'games'}`);
    if (r.average != null) parts.push(`avg ${formatRecapScore(r.average)}`);
  }
  parts.push(r.best_game_no != null && r.games != null
    ? `best ${formatRecapScore(r.best)} (game #${r.best_game_no})`
    : `best ${formatRecapScore(r.best)}`);
  parts.push(`${ordinal(r.finish)} of ${r.field}`);
  return parts.join(' · ');
}
