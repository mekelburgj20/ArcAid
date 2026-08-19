/**
 * v2.116.0 (C1) — the room-display settings vocabulary, shared by the panel
 * that edits them (`components/scoreboard/DisplaySettingsPanel.tsx`), the page
 * that hosts it (`pages/Leaderboard.tsx`), and the Settings page, which no
 * longer renders these controls but must still CLAIM their keys or a stored
 * value leaks into its raw "Other" card.
 *
 * They live here rather than beside the panel so the panel file exports a
 * component and nothing else (fast refresh).
 */

// Toggles that render inside the display panel.
// Style-system revamp P0 (honesty fix, item 9): SCOREBOARD_GAME_TITLE_ENHANCE
// removed — it's read only by the legacy deriveCardProps path, so it does
// nothing on any room using a card style (every room, post the P0 seed fix).
// Stays honored in the legacy derivation until Phase 1 retires it.
export const SCOREBOARD_TOGGLES: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'SCOREBOARD_HIDE_EMPTY': {
    label: 'Hide Empty Games',
    description: 'When enabled, game cards with no scores are hidden from the public leaderboard.',
  },
  'SCOREBOARD_TITLE_HIDDEN': {
    label: 'Hide Game Room Title',
    description: 'When enabled, the game room name/heading (e.g., "Arcaid_Demo") is hidden on the public leaderboard.',
  },
  'SCOREBOARD_CARD_BG_FILL': {
    label: 'Card Background Fill',
    description: 'When enabled, game background images fill the entire card behind scores for an immersive look.',
    // Owner call, 2026-08-15 — default ON, matching deriveScoreboardConfig.
    defaultOn: true,
  },
  'SCOREBOARD_GAME_HEADER_ENABLED': {
    label: 'Game Art Header',
    description: "When enabled, each card shows the game's art block at the top. Turn it off for a text-first board — cards keep their title, tournament label and countdown either way.",
    // Owner ask, 2026-08-19 — default ON, matching deriveScoreboardConfig.
    defaultOn: true,
  },
  'SCOREBOARD_RANKINGS_STICKY': {
    label: 'Always Visible Rankings',
    description: 'When enabled, the Overall Rankings card stays pinned on screen and does not scroll away.',
  },
};

/** Title-style options, shared by the Branding title picker, the game-title
 *  dropdown, and the Settings page's SELECT_OPTIONS lookup. */
export const TITLE_STYLE_OPTIONS: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'glow', label: 'Neon Cyan' },
  { value: 'neon-magenta', label: 'Neon Magenta' },
  { value: 'chrome', label: 'Chrome' },
  { value: 'fire', label: 'Fire' },
  { value: 'plasma', label: 'Plasma' },
  { value: 'backglass', label: 'Backglass' },
  { value: 'marquee', label: 'Marquee' },
  { value: 'retro', label: 'Retro' },
  { value: 'pixel', label: 'Pixel' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'arcade-red', label: 'Arcade Red' },
  { value: 'arcade-cyan', label: 'Arcade Cyan' },
  { value: 'arcade-amber', label: 'Arcade Amber' },
  { value: 'arcade-green', label: 'Arcade Green' },
  { value: 'holo', label: 'Holo Sweep' },
  { value: 'outlined', label: 'Outlined' },
];

export const TITLE_SIZE_OPTIONS: { value: string; label: string }[] = [
  { value: 'xs', label: 'Extra Small' },
  { value: 'sm', label: 'Small (Default)' },
  { value: 'base', label: 'Medium' },
  { value: 'lg', label: 'Large' },
  { value: 'xl', label: 'Extra Large' },
  { value: '2xl', label: '2X Large' },
  { value: '3xl', label: '3X Large' },
  { value: '4xl', label: '4X Large' },
];

/**
 * Every on/off key the display panel owns → its value when the row is absent.
 * Used by the rail's dirty diff: an off-default toggle stores nothing until
 * touched, so flipping it on and back off must read as CLEAN rather than as
 * `undefined` vs. `'false'`. Same rule Settings.tsx applies to its own set.
 */
export const DISPLAY_TOGGLE_DEFAULTS: Record<string, boolean> = {
  ...Object.fromEntries(Object.entries(SCOREBOARD_TOGGLES).map(([k, v]) => [k, !!v.defaultOn])),
  SCOREBOARD_MOBILE_VERTICAL: true,
  SCOREBOARD_LOGO_ENABLED: true,
  SCOREBOARD_SHOW_TIMER: true,
};

/** True iff key `k` differs between two config snapshots. Boolean toggles
 *  compare by effective on/off (default-resolved); everything else by string. */
export function displaySettingChanged(
  k: string, a: Record<string, string>, b: Record<string, string>,
): boolean {
  if (k in DISPLAY_TOGGLE_DEFAULTS) {
    const eff = (src: Record<string, string>) =>
      (src[k] !== undefined && src[k] !== '' ? src[k] === 'true' : DISPLAY_TOGGLE_DEFAULTS[k]);
    return eff(a) !== eff(b);
  }
  return (a[k] ?? '') !== (b[k] ?? '');
}
