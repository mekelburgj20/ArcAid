/**
 * The /scoreboard game grid's layout, in one place (v2.55.0).
 *
 * It lives here rather than in the page because TWO surfaces lay cards out: the
 * grid itself and the "My Pins" carousel above it, which must give its cards
 * the SAME width. A second hardcoded card width would drift the first time the
 * grid is retuned, which is exactly the class of bug this release is fixing.
 *
 * `gap-3.5` is 14px in Tailwind v4; the breakpoints are Tailwind's sm/md/lg.
 */
export const GRID_GAP_PX = 14;

export const GRID_COLUMNS: Array<{ minWidth: number; columns: number }> = [
  { minWidth: 1024, columns: 4 }, // lg
  { minWidth: 768, columns: 3 },  // md
  { minWidth: 640, columns: 2 },  // sm
  { minWidth: 0, columns: 1 },
];

export const GRID_CLASS =
  'grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 items-stretch';

/** Columns the grid shows at a given viewport width. */
export function gridColumnsAt(viewportWidth: number): number {
  return GRID_COLUMNS.find(b => viewportWidth >= b.minWidth)?.columns ?? 1;
}
