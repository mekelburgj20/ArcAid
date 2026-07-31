import type { GlobalGameCardGame, TopScoreEntry } from '../components/GlobalGameCard';

/**
 * Leaderboard density planning for the Global Scoreboard card (v2.57.0, A5a).
 *
 * This lives in `lib/` rather than beside the card for two reasons: it is a
 * pure function over the payload (no React), and a component module that also
 * exports helpers breaks Fast Refresh. The types it reads are declared on the
 * card and imported here as TYPES ONLY, so there is no runtime import cycle.
 */

/** v2.50.0 (A2): cards render the top 6 only. */
export const CARD_ROWS = 6;

/**
 * The page-level leaderboard density.
 *
 * `top6`  — ranks 1-6 straight from the top. The default, and the only mode
 *           offered to a logged-out visitor (there is no "my score" to centre
 *           on, so the toggle is hidden entirely).
 * `mine`  — ranks 1-3, a break line, then the viewer's own neighbourhood.
 *
 * One toggle drives every card at once; there is deliberately no per-card
 * control. It flips CLIENT-SIDE with no refetch, which is the entire reason
 * `neighbors` shipped on the payload back in A4.
 */
export type Density = 'top6' | 'mine';

/** One rendered leaderboard line, after the density plan is resolved. */
export interface PlannedRow {
  entry: TopScoreEntry;
  rank: number;
  isYou: boolean;
  /** The player exactly one rank above the viewer — the "NEXT" target. */
  isNext: boolean;
  /** A rank gap opens before this row, so a break line precedes it. */
  gapBefore: boolean;
}

export interface RowPlan {
  rows: PlannedRow[];
  /**
   * `mine` mode only, and only when the viewer has no score on this game:
   * what it takes to get onto the board. Null otherwise.
   */
  prompt: { rank: number; score: number } | null;
}

/**
 * Resolve which leaderboard lines a card shows, for a given density.
 *
 * Rank → entry resolution: `top_scores` is dense from rank 1 (index + 1), and
 * `neighbors` entries carry an explicit `rank` that overlays it. Any rank with
 * no entry on either source is simply skipped — a card never invents a row.
 */
export function planRows(game: GlobalGameCardGame, density: Density): RowPlan {
  const top = game.top_scores || [];
  const byRank = new Map<number, TopScoreEntry>();
  top.forEach((entry, i) => byRank.set(i + 1, entry));
  for (const n of game.neighbors || []) {
    if (typeof n.rank === 'number') byRank.set(n.rank, n);
  }

  const myRank = game.my_rank ?? null;
  /** The lowest rank a Top 6 card would show — the bar for "on the board". */
  const lastQualifyingRank = Math.min(CARD_ROWS, top.length);

  /**
   * `highlight` is what keeps Top 6 rendering byte-identical to A4: there, a
   * viewer inside the top 6 has never carried a "You" badge, and quietly adding
   * one would be an unannounced visual change to the default mode. In `mine`
   * density the highlight IS the point of the mode.
   */
  const plan = (ranks: number[], highlight: boolean, prompt: RowPlan['prompt'] = null): RowPlan => {
    const present = ranks.filter(r => byRank.has(r)).sort((a, b) => a - b);
    return {
      rows: present.map((rank, i) => ({
        entry: byRank.get(rank) as TopScoreEntry,
        rank,
        isYou: highlight && myRank === rank,
        isNext: highlight && myRank != null && rank === myRank - 1,
        gapBefore: i > 0 && rank > present[i - 1] + 1,
      })),
      prompt,
    };
  };

  if (density === 'top6') {
    // Unchanged from A4: ranks 1-6, plus the viewer's own row appended when
    // they sit below them (rendered by the caller, not planned here).
    return plan(Array.from({ length: CARD_ROWS }, (_, i) => i + 1), false);
  }

  // `mine`: the viewer has no score here — show the podium and tell them what
  // it takes to get on the board, rather than a truncated list they're absent
  // from. A board with no rows at all falls through to the "Claim 1st" CTA.
  if (myRank == null) {
    return plan([1, 2, 3], true, lastQualifyingRank > 0
      ? { rank: lastQualifyingRank, score: (byRank.get(lastQualifyingRank) as TopScoreEntry).score }
      : null);
  }

  // Ranks 1-3 plus the viewer's neighbourhood. Ranks 4 and 5 join the set when
  // the viewer is inside the top 4, which is what makes ranks 1-4 render as a
  // contiguous 1-5 with no break line (design: "you are ranked 4 → no break
  // line needed"). At rank 5 the union is already 1-6 and contiguous, so the
  // break line falls out of the gap check rather than a special case.
  const ranks = new Set<number>([1, 2, 3, myRank - 1, myRank, myRank + 1]);
  if (myRank <= 4) { ranks.add(4); ranks.add(5); }
  return plan([...ranks].filter(r => r >= 1), true);
}
