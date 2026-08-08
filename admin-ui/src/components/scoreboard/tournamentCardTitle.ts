import type { GameLeaderboard } from '../ScoreboardComponents';

/**
 * What a tournament card's TITLE is: where it points, and what clicking it does.
 *
 * Shared rather than written per page. v2.86.0 gave the room-admin Leaderboard
 * the public card via `ScoreboardSurface`, and a card whose title is a `<Link>`
 * for players but a dead `<h3>` for admins is not the same card — a difference
 * no screenshot comparison catches. Both pages pass these into the surface's
 * `titleLinkTo` / `titleLinkOnClick` props.
 *
 * Its own module (rather than an export from `ScoreboardSurface.tsx`) so that
 * file keeps exporting only its component — see `react-refresh/only-export-components`.
 */

/**
 * Where a tournament card's title navigates.
 *
 * Plan §10 / Sprint 3: Tournament-tab cards link to game detail like All Games.
 * v2.13.12 — append `&tab=tournaments` so the GameDetail back link returns to
 * the Tournaments tab (rather than the All Games default).
 */
export function tournamentCardTitleLink(slug: string) {
  return (lb: GameLeaderboard): string =>
    lb.globalGameId
      ? `/games/${lb.globalGameId}?from=${encodeURIComponent(slug)}&tab=tournaments`
      : `/${slug}/games/${encodeURIComponent(lb.gameName)}?tab=tournaments`;
}

/**
 * What a click on that title does: opens the quick-view popup instead of
 * navigating. Takes the opener so each page owns its own `GameQuickView`
 * instance (the popup is page chrome, not part of the surface) while the
 * DECISION of what a click means stays in one place.
 */
export function tournamentCardTitleClick(openQuickView: (lb: GameLeaderboard) => void) {
  return (lb: GameLeaderboard) => (e: React.MouseEvent) => {
    // v2.13.13 — defensive: skip when the click originated on a nested
    // interactive element (e.g., the GameInfoPopup "i" icon button that sits
    // inside the title Link). React's stopPropagation in those children
    // doesn't always prevent the parent's onClick from firing in production
    // builds; closest('button') is a more reliable bail.
    if ((e.target as HTMLElement).closest('button')) return;
    // Plain left-click → open modal. Middle/ctrl/cmd/shift-click falls through
    // to the underlying <Link href> so the user can open the full page in a
    // new tab.
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      openQuickView(lb);
    }
  };
}
