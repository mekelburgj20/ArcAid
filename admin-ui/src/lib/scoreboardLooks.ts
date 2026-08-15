import type { ScoreboardStyle } from './scoreboardThemes';
import { DEFAULT_SHOWCASE_THEME, STYLE_LABELS } from './scoreboardThemes';

/**
 * Style-system revamp P1 — "Looks": four curated, COMPLETE scoreboard bundles.
 *
 * Replaces `PresetSelector`, which wrote six keys
 * (SCOREBOARD_CARD_LAYOUT / BG_FILL / BG_SIZE / SCORE_COLUMNS / CARD_SIZE /
 * WHEEL_SCALE) that only `deriveCardProps` reads — i.e. only on a room with
 * NO `SCOREBOARD_STYLE`. Migration 144 gave every room a style, so those
 * presets became provably inert: an admin could click "Compact" and watch
 * nothing happen. That is the "obsolete controls" complaint in miniature.
 *
 * The other half of the problem was that picking a card style set exactly ONE
 * key. The style changed; the card height, spacing and layout stayed on
 * whatever the previous look wanted — most visibly `SCOREBOARD_MIN_SCORES`,
 * which defaults to 20 and forces every card to reserve twenty score rows of
 * height no matter how few scores it shows. A Look now carries the values
 * that make its family read correctly.
 *
 * WHAT A LOOK DELIBERATELY DOES NOT TOUCH:
 * - Room identity: title text, logo, background image. Same exclusion rule
 *   the P2 style profiles will use — a Look is a look, not a rebrand.
 * - Personal choices layered on top: `SCOREBOARD_GAME_TITLE_STYLE`,
 *   `SCOREBOARD_TITLE_STYLE`/`_SIZE`. Resetting an admin's chosen title
 *   treatment because they tried a different card family is hostile.
 * - Policy and device settings: QR mode/size/position, mobile vertical/
 *   density, zoom, hide-empty. None of these are visual identity.
 * - `SCOREBOARD_RANKINGS_STYLE`, which the Rankings page owns (it is in
 *   Settings' `hiddenKeys` for exactly that reason) — writing it from here
 *   would put two pages in charge of one key.
 */

/** Every key a Look writes. Also the key set `computeActiveLook` compares. */
export const LOOK_KEYS = [
  'SCOREBOARD_STYLE',
  'SCOREBOARD_THEME',
  'SCOREBOARD_PODIUM_VARIANT',
  'SCOREBOARD_LAYOUT',
  'SCOREBOARD_MAX_SCORES',
  'SCOREBOARD_MIN_SCORES',
  'SCOREBOARD_CARD_SPACING',
  'SCOREBOARD_CARD_BG_FILL',
] as const;

export type LookKey = typeof LOOK_KEYS[number];

export interface LookDefinition {
  id: ScoreboardStyle;
  label: string;
  description: string;
  settings: Partial<Record<LookKey, string>>;
}

/**
 * Arcade leads: it is the flagship and the seeded default (migration 144), so
 * it is the first thing an admin considers rather than a fourth option after
 * the three it replaces.
 */
export const LOOK_DEFINITIONS: LookDefinition[] = [
  {
    id: 'arcade',
    ...STYLE_LABELS.arcade,
    settings: {
      SCOREBOARD_STYLE: 'arcade',
      SCOREBOARD_PODIUM_VARIANT: 'holo-steps',
      // 380px art cards tile well; a horizontal strip wastes the art block.
      SCOREBOARD_LAYOUT: 'grid',
      // Podium (3) + a seven-row tail, matching the Global Scoreboard depth
      // this look is ported from. MIN tracks MAX so the card reserves exactly
      // the height it uses instead of the 20-row default's dead space.
      SCOREBOARD_MAX_SCORES: '10',
      SCOREBOARD_MIN_SCORES: '10',
      SCOREBOARD_CARD_SPACING: '24',
      SCOREBOARD_CARD_BG_FILL: 'true',
    },
  },
  {
    id: 'banner',
    ...STYLE_LABELS.banner,
    settings: {
      SCOREBOARD_STYLE: 'banner',
      // Narrow 280px cards — the classic side-scrolling iScored strip.
      SCOREBOARD_LAYOUT: 'scroll',
      SCOREBOARD_MAX_SCORES: '10',
      SCOREBOARD_MIN_SCORES: '10',
      SCOREBOARD_CARD_SPACING: '24',
      // Banner's identity is its header image, not a full-bleed fill; leaving
      // fill off keeps the score rows legible on busy table art.
      SCOREBOARD_CARD_BG_FILL: 'true',
    },
  },
  {
    id: 'showcase',
    ...STYLE_LABELS.showcase,
    settings: {
      SCOREBOARD_STYLE: 'showcase',
      SCOREBOARD_THEME: DEFAULT_SHOWCASE_THEME,
      SCOREBOARD_PODIUM_VARIANT: 'holo-steps',
      SCOREBOARD_LAYOUT: 'vertical',
      SCOREBOARD_MAX_SCORES: '10',
      SCOREBOARD_MIN_SCORES: '10',
      SCOREBOARD_CARD_SPACING: '24',
      SCOREBOARD_CARD_BG_FILL: 'true',
    },
  },
  {
    id: 'minimal',
    ...STYLE_LABELS.minimal,
    settings: {
      SCOREBOARD_STYLE: 'minimal',
      SCOREBOARD_LAYOUT: 'vertical',
      SCOREBOARD_MAX_SCORES: '10',
      SCOREBOARD_MIN_SCORES: '10',
      // Tighter than the art looks — with no images the default gap reads as
      // a hole between text blocks.
      SCOREBOARD_CARD_SPACING: '16',
      // The ONE Look that opts out of the 2026-08-15 bg-fill default: Minimal
      // is "clean typography, no images" by definition, and MinimalCard does
      // render a background when this is on. A Look overriding a product
      // default is the point of Looks; flag it if the owner disagrees.
      SCOREBOARD_CARD_BG_FILL: 'false',
    },
  },
];

/**
 * Has this room been hand-tuned away from its Look?
 *
 * Compares ONLY the bundle keys the room has EXPLICITLY stored. An unset key
 * does not count as divergence — and that distinction is the whole point.
 * Every room that predates Looks has a stored `SCOREBOARD_STYLE` and nothing
 * else in the bundle; scoring those as "customised" because they differ from
 * a bundle we introduced afterwards would flag every single room in the
 * product as modified on the day this ships, which is both false and useless.
 * "Customised" must mean "you changed something", not "you predate this".
 *
 * Consequence worth knowing: a room on a bare `SCOREBOARD_STYLE` reads as its
 * Look while still rendering with the old per-key defaults (notably
 * `SCOREBOARD_MIN_SCORES` = 20, which reserves twenty rows of card height).
 * Clicking the Look writes the bundle and fixes that. Retrofitting every room
 * by migration was rejected deliberately — it would silently change how every
 * existing scoreboard looks, which is the owner's call, not a side effect.
 *
 * Returns `'unset'` for a room with no `SCOREBOARD_STYLE` at all — the legacy
 * render path. Migration 144 converted every room that existed when it ran,
 * so in practice this appears only in tests and in a room restored from a
 * pre-144 backup; the picker surfaces it as a warning rather than quietly
 * highlighting a tile the room is not actually using.
 */
export function computeActiveLook(settings: Record<string, string>): ScoreboardStyle | 'custom' | 'unset' {
  const style = settings.SCOREBOARD_STYLE;
  if (!style) return 'unset';
  const look = LOOK_DEFINITIONS.find(l => l.id === style);
  if (!look) return 'custom';

  const diverged = Object.entries(look.settings).some(([key, value]) => {
    const stored = settings[key as LookKey];
    if (stored === undefined || stored === '') return false;
    return stored !== value;
  });
  return diverged ? 'custom' : look.id;
}
