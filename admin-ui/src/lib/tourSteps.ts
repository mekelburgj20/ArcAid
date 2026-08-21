/**
 * v2.48.0 — first-login player tutorial step config
 * (docs/contracts/first-login-tutorial-contract.md). One exported array so the copy can
 * be iterated in a single place (e.g. a later screenshot-loop tuning pass).
 *
 * Each `selector` matches a `data-tour="..."` attribute anchored in
 * PublicLayout.tsx (nav / nav-scores), UserMenu.tsx (user-menu), and the
 * three scoreboard card components — BannerCard / ShowcaseCard / MinimalCard
 * (game-card-title). TourOverlay filters this list down to steps whose
 * anchor actually exists in the DOM before rendering — see its
 * "Anchor groundwork" contract note for why game-card-title alone is allowed
 * to be missing (empty room, or not on the scoreboard page).
 */
export interface TourStep {
  key: string;
  selector: string;
  title: string;
  body: string;
  /**
   * Preferred tooltip placement. 'right' anchors the bubble beside the target
   * (falls back to below when there's no horizontal room, e.g. phones) — used
   * for the game-card step so the bubble doesn't cover the very card it's
   * pointing at. Default (undefined) = below/above heuristic.
   */
  placement?: 'right';
}

export const TOUR_STEPS: TourStep[] = [
  {
    key: 'nav',
    selector: '[data-tour="nav"]',
    title: 'Find your way around',
    body: "Everything in this room lives up here — Lobby, Scores, Picks, Stats, and Players.",
  },
  {
    key: 'nav-scores',
    selector: '[data-tour="nav-scores"]',
    title: 'Scores',
    body: 'Scores is where the leaderboards live — and where you post your own.',
  },
  {
    key: 'game-card-title',
    selector: '[data-tour="game-card-title"]',
    title: 'Game details',
    body: "Click any game's title for full standings and details — or tap the + on a card to submit your score.",
    placement: 'right',
  },
  {
    key: 'user-menu',
    selector: '[data-tour="user-menu"]',
    title: 'Account menu',
    body: "That's you — Account settings, Scoreboard display options, and Friends live here.",
  },
];
