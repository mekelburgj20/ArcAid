/**
 * The /scoreboard game grid's layout, in one place (v2.55.0).
 *
 * It lives here rather than in the page because TWO surfaces lay cards out: the
 * grid itself and the "My Pins" carousel above it, which must give its cards
 * the SAME width. A second hardcoded card width would drift the first time the
 * grid is retuned, which is exactly the class of bug this release is fixing.
 *
 * v2.65.0 (declutter) retunes both axes:
 *   • Max columns 4 → 3. Four cards across a 1440px page left each one ~330px
 *     wide with 14px between them, which is what made the grid read as a wall
 *     of tiles rather than as separate leaderboards.
 *   • The gutter roughly doubles, and is now breakpoint-aware. At the 1-column
 *     phone breakpoint it is a VERTICAL stack gap and nothing else — the only
 *     separator between one card's Submit button and the next card's art — so
 *     it is deliberately not the smallest value in the set.
 *
 * The class list and the numbers below MUST agree; the numbers exist because
 * the carousel measures pixels and Tailwind classes are not readable at
 * runtime. Change one, change the other.
 */

export const GRID_COLUMNS: Array<{ minWidth: number; columns: number }> = [
  { minWidth: 1024, columns: 3 }, // lg
  { minWidth: 640, columns: 2 },  // sm
  { minWidth: 0, columns: 1 },
];

/** Mirrors the `gap-*` utilities in `GRID_CLASS`, in px, largest first. */
export const GRID_GAPS: Array<{ minWidth: number; gap: number }> = [
  { minWidth: 1024, gap: 32 }, // lg:gap-8
  { minWidth: 0, gap: 28 },    // gap-7
];

export const GRID_CLASS =
  'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-7 lg:gap-8 items-stretch';

/** Columns the grid shows at a given viewport width. */
export function gridColumnsAt(viewportWidth: number): number {
  return GRID_COLUMNS.find(b => viewportWidth >= b.minWidth)?.columns ?? 1;
}

/** The gutter, in px, the grid uses at a given viewport width. */
export function gridGapAt(viewportWidth: number): number {
  return GRID_GAPS.find(b => viewportWidth >= b.minWidth)?.gap ?? 28;
}
