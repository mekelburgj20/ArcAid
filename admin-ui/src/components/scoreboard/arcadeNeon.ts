import type { GameLeaderboard } from '../ScoreboardComponents';

/**
 * Which neon the Arcade card's frame wears. `none` is a DECLARED key rather
 * than an absent attribute so "no tournament" and the stylesheet default are
 * the same stated thing rather than two paths that happen to agree.
 *
 * A `.ts` sibling of `ArcadeCard.tsx` (the `tournamentCardTitle.ts` pattern):
 * exporting this from the component file would break Vite fast-refresh —
 * `react-refresh/only-export-components`.
 */
/**
 * Per-rank podium row tint / border / medal colour. Every value is a token so
 * the card works under both polarities — never a literal rgba(). Ranks 4+
 * have no entry (they are `ArcadeCard`'s business, and render untinted).
 * Lives here rather than in `ArcadePodium.tsx` for the same fast-refresh
 * reason as `arcadeNeonKey` — and a replacement podium design reading the
 * same token table is theme-correct for free.
 */
export const ARCADE_RANK_TINTS: Record<number, { bg: string; border: string; medal: string; label: string }> = {
  1: { bg: 'var(--sb-row-gold-bg)', border: 'var(--sb-row-gold-border)', medal: 'text-neon-amber', label: '1st place' },
  2: { bg: 'var(--sb-row-silver-bg)', border: 'var(--sb-row-silver-border)', medal: 'text-medal-silver', label: '2nd place' },
  3: { bg: 'var(--sb-row-bronze-bg)', border: 'var(--sb-row-bronze-border)', medal: 'text-medal-bronze', label: '3rd place' },
};

export function arcadeNeonKey(lb: Pick<GameLeaderboard, 'tournamentType' | 'isPinned'>): string {
  if (lb.isPinned) return 'pinned';
  switch ((lb.tournamentType || '').toUpperCase()) {
    case 'DG': return 'dg';
    case 'WG-VPXS': return 'wg';
    case 'WG-VR': return 'wg-vr';
    case 'MG': return 'mg';
    default: return 'none';
  }
}
