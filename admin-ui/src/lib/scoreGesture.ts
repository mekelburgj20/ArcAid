/**
 * Score-row click gesture — v2.109.0 (score-gesture-photos work package).
 *
 * Replaces v2.108.0's own-row-click-opens-popup exception, which routed only
 * the VIEWER'S OWN row to the game's quick popup (`GameQuickView`) and left
 * every other row on plain inline expand/collapse. Every row now follows the
 * SAME two-step gesture, regardless of who submitted it:
 *
 *   - Not expanded, has more than one score (`canExpand`) → click EXPANDS.
 *   - Expanded (or never had more than one score to expand in the first
 *     place) → click OPENS the quick popup instead.
 *
 * Collapsing back is the −/chevron icon's job EXCLUSIVELY — it is its own
 * click target (with its own `stopPropagation`), not a restatement of the
 * row-body click, which now means "popup" once a row is expanded. See each
 * card family's row render for the icon wiring; this module only owns the
 * decision of what the row body's click does.
 */

/** Quiet hint on a row whose click opens the quick popup — applies to every
 *  such row now (single-score rows, and expanded multi-score rows), not just
 *  the viewer's own as in v2.108.0. */
export const QUICK_VIEW_HINT = 'Open game details';

/**
 * The click handler for a card row, or `undefined` when nothing is wired
 * (the row is neither expandable nor does the caller pass a popup opener —
 * matches v2.107 inert rendering exactly).
 */
export function resolveRowClick(
  canExpand: boolean,
  isExpanded: boolean,
  onExpand: () => void,
  onOpenQuickView?: () => void,
): (() => void) | undefined {
  if (canExpand && !isExpanded) return onExpand;
  return onOpenQuickView;
}

/** True when `resolveRowClick`'s result (if any) opens the popup rather than
 *  expanding — drives the chevron-vs-plus icon choice and the hint tooltip. */
export function opensQuickView(canExpand: boolean, isExpanded: boolean, hasOpener: boolean): boolean {
  return (!canExpand || isExpanded) && hasOpener;
}
