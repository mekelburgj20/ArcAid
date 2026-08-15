import type { GlobalCardStyles } from '../components/ScoreboardComponents';
import { cardWidthMap } from '../components/ScoreboardComponents';
import type { PodiumVariant, ScoreboardStyle } from './scoreboardThemes';
import { STYLE_WIDTHS, DEFAULT_SHOWCASE_THEME } from './scoreboardThemes';

// ═══════════════════════════════════════════
// New config interface (Style + Theme system)
// ═══════════════════════════════════════════

export interface ScoreboardConfig {
  // Card style + theme
  style: ScoreboardStyle;
  theme: string;                // only used when style === 'showcase'
  /**
   * Showcase podium look. `holo-steps` (the owner's 2026-08-13 redesign) is
   * the default — it REPLACES what showcase rooms see unless the room has
   * explicitly pinned the old `pyramid`/`chip` via SCOREBOARD_PODIUM_VARIANT.
   * Only used when style === 'showcase'.
   */
  podiumVariant: PodiumVariant;
  maxScores: number;
  minScores: number;
  showTimer: boolean;
  cardBgFill: boolean;
  cardSpacing: number;
  titleFontSize: number;

  // Page-level settings (retained from old system)
  layout: string;               // 'scroll' | 'grid'
  zoom: number;
  bgUrl: string;
  bgMode: string;
  bgOpacity: number;
  logoUrl: string;
  logoPosition: string;
  logoMaxHeight: number;
  titleHidden: boolean;
  titleText: string;
  titleStyle: string;
  titleSize: string;
  rankingsPosition: string;
  rankingsSticky: boolean;
  /**
   * Card style for the Overall Rankings card. Decouples ranking-card rendering
   * from the game-card style so rankings can read as a different "object type"
   * rather than another game card.
   *
   * - `match`   — mirror the scoreboard's style+theme (legacy / default).
   * - `plaque`  — tall, narrow, ornamental hall-of-fame frame.
   * - `compact` — no card chrome; text-only list on the scoreboard background.
   * - `sidebar` — narrow column with abbreviated scores; best beside the grid.
   * - `ticker`  — full-width scrolling marquee strip replacing the ranking
   *   cards entirely (not a per-card look — see `RankingsTicker` in
   *   ScoreboardComponents.tsx and its `tickerMode` branch in
   *   ScoreboardSurface). Text-only; ranking-card background styles do not
   *   apply.
   */
  rankingsStyle: 'match' | 'plaque' | 'compact' | 'sidebar' | 'ticker';
  hideEmpty: boolean;
  requirePhoto: boolean;
  qrMode: string;
  qrSize: number;
  /**
   * Owner call, 2026-08-15: the QR anchors to an EDGE, always horizontally
   * centred. `'top-center' | 'bottom-center'` — the old right-aligned variants
   * are folded into these at read time (see `normalizeQrPosition`).
   */
  qrPosition: 'top-center' | 'bottom-center';
  /**
   * Signed distance from the anchored card edge, in px. NEGATIVE means the QR
   * overlaps INTO the card by that many pixels; positive pushes it further
   * away. Default -10, which reproduces the previous behaviour exactly (the
   * old `SCOREBOARD_QR_OVERLAP_PX` counted the same 10px with the opposite
   * sign, and is still honoured as the fallback).
   */
  qrOffsetPx: number;
  gameTitleStyle: string;         // same options as titleStyle (glow, fire, plasma, etc.)
  bgBehindTitle: boolean;         // true when bgMode is 'fill-entire' — bg image extends behind title
  mobileVertical: boolean;        // true = force vertical scroll on mobile (default), false = keep desktop layout
  mobileScale: number;            // mobile density factor, e.g. 0.6 = 60% of desktop size. 1.0 = full size (default, opt-in shrink only).
  /** S21 — kiosk-only TV/distance zoom. Fallback chain: KIOSK_ZOOM if set,
   *  else SCOREBOARD_ZOOM, else 100. Gated off at <=640px (see item 2's zoom
   *  gate) — phones always render at natural scale regardless of this value. */
  kioskZoom: number;
}

/**
 * Read-time shim for the QR anchor (owner call, 2026-08-15).
 *
 * The QR used to be placeable top-right, bottom-right or bottom-center. It is
 * now an EDGE choice, always horizontally centred — a QR hanging off one
 * corner reads as a mistake, and the two right-aligned variants existed only
 * because the centred one was added later.
 *
 * Stored right-aligned values fold onto the same edge rather than resetting to
 * a default, so no room silently moves its QR from the bottom to the top.
 * Rows upgrade to the new vocabulary the next time an admin saves; nothing
 * needs a migration to render correctly in the meantime. Same doctrine as
 * `parseTournamentRules` on the backend.
 */
export function normalizeQrPosition(stored: string | undefined): 'top-center' | 'bottom-center' {
  switch (stored) {
    case 'bottom-center':
    case 'bottom-right':
      return 'bottom-center';
    case 'top-center':
    case 'top-right':
      return 'top-center';
    default:
      return 'top-center';
  }
}

/** Default signed offset — negative overlaps into the card. Reproduces the
 *  previous fixed 10px overlap. */
export const DEFAULT_QR_OFFSET_PX = -10;

/**
 * Signed edge offset, superseding the unsigned `SCOREBOARD_QR_OVERLAP_PX`.
 *
 * The old key could only express "how far INSIDE the card" and was clamped at
 * zero, so an admin could never push the QR away from the edge. The new key is
 * signed: negative overlaps, positive separates. When only the legacy key is
 * stored we negate it, which is an exact behavioural match.
 */
export function deriveQrOffsetPx(config: Record<string, string>): number {
  const explicit = parseInt(config.SCOREBOARD_QR_OFFSET_PX ?? '', 10);
  if (Number.isFinite(explicit)) return explicit;
  const legacy = parseInt(config.SCOREBOARD_QR_OVERLAP_PX ?? '', 10);
  // `|| 0` normalises the -0 that negating a zero overlap would otherwise
  // produce — harmless in layout maths, confusing in a stored value.
  if (Number.isFinite(legacy)) return -Math.max(0, legacy) || 0;
  return DEFAULT_QR_OFFSET_PX;
}

/**
 * Boolean scoreboard settings whose ABSENCE means ON.
 *
 * `deriveScoreboardConfig` below reads these as `value !== 'false'` and every
 * other boolean as `value === 'true'`. Any UI that draws a switch for one of
 * these keys must consult this set rather than assuming default-off, or it
 * shows the switch in the opposite position to the behaviour the user is
 * looking at — which is exactly what SCOREBOARD_MOBILE_VERTICAL did in the
 * viewer preferences modal until 2026-08-15.
 *
 * Lives here, next to the derivation it mirrors, so the two cannot drift into
 * separate files and disagree.
 */
export const TOGGLE_DEFAULT_ON = new Set([
  'SCOREBOARD_SHOW_TIMER',
  // Owner call, 2026-08-15 — both default ON product-wide.
  'SCOREBOARD_MOBILE_VERTICAL',
  'SCOREBOARD_CARD_BG_FILL',
  // Not a scoreboard "feature" toggle but the same default-on rule: the logo
  // shows unless a room or viewer turns it off. Surfaced to viewers inverted,
  // as "Hide Game Room Logo".
  'SCOREBOARD_LOGO_ENABLED',
]);

/**
 * Derives the new ScoreboardConfig from a settings record.
 * Includes legacy migration: if SCOREBOARD_STYLE is absent, heuristically
 * maps old granular keys to the appropriate style/theme.
 */
export function deriveScoreboardConfig(config: Record<string, string>, roomName?: string): ScoreboardConfig {
  let style = (config.SCOREBOARD_STYLE || '') as ScoreboardStyle;
  let theme = config.SCOREBOARD_THEME || DEFAULT_SHOWCASE_THEME;

  // Legacy migration: if no SCOREBOARD_STYLE key, infer from old settings
  if (!style) {
    const oldLayout = config.SCOREBOARD_CARD_LAYOUT || 'banner';
    const oldBgFill = config.SCOREBOARD_BG_FILL || 'off';
    if (oldLayout === 'fullart' || (oldLayout === 'banner' && oldBgFill === 'fill')) {
      // "Showcase" look from old system
      style = 'showcase';
      theme = DEFAULT_SHOWCASE_THEME;
    } else if (oldLayout === 'wheel') {
      style = 'showcase';
      theme = DEFAULT_SHOWCASE_THEME;
    } else {
      style = 'banner';
    }
  }

  // Validate style. `arcade` (style-system revamp Phase 1) joins the
  // whitelist; the fallback stays 'banner' deliberately — a room that somehow
  // stored an unknown value is a data fault, and silently promoting it to the
  // new flagship would hide that behind a redesign. The AUTO-CONVERT of legacy
  // rooms is a migration (144), not a read-time coercion, so the conversion is
  // recorded once rather than re-derived on every page load.
  if (!['arcade', 'banner', 'showcase', 'minimal'].includes(style)) {
    style = 'banner';
  }

  return {
    style,
    theme,
    podiumVariant: (['pyramid', 'chip', 'holo-steps'].includes(config.SCOREBOARD_PODIUM_VARIANT || '')
      ? config.SCOREBOARD_PODIUM_VARIANT
      : 'holo-steps') as PodiumVariant,
    maxScores: parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5,
    // Owner report, 2026-08-15: "'Scores per card' and 'Min Card Height' are
    // redundant or may even conflict."
    //
    // They are different things — max = how many rows to RENDER, min = how much
    // height to RESERVE, in row units — but the old fixed default of 20 made
    // them fight: every card reserved twenty rows of height while showing five,
    // which is where the dead space under the scores came from. It also meant
    // raising "Scores per card" appeared to do nothing to card height.
    //
    // The minimum now TRACKS the maximum unless an admin pins it. Cards size to
    // what they show; a room that wants a taller uniform grid can still say so.
    minScores: (() => {
      const stored = parseInt(config.SCOREBOARD_MIN_SCORES || '', 10);
      if (Number.isFinite(stored) && stored > 0) return stored;
      return parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5;
    })(),
    showTimer: config.SCOREBOARD_SHOW_TIMER !== 'false',
    // Owner call, 2026-08-15: default ON. Was `=== 'true'` (default off), which
    // left every room's cards showing table art only in the header strip
    // unless an admin found the toggle. Rooms that deliberately turned it off
    // keep it off — the stored 'false' still wins.
    cardBgFill: config.SCOREBOARD_CARD_BG_FILL !== 'false',
    cardSpacing: parseInt(config.SCOREBOARD_CARD_SPACING || '24', 10) || 24,
    titleFontSize: parseInt(config.SCOREBOARD_TITLE_FONT_SIZE || '0', 10) || 0,

    layout: config.SCOREBOARD_LAYOUT || (style === 'showcase' || style === 'minimal' ? 'vertical' : 'scroll'),
    zoom: parseInt(config.SCOREBOARD_ZOOM || '100', 10) || 100,
    // S21 — kiosk distance-tuning zoom. KIOSK_ZOOM wins when set; otherwise
    // fall back to SCOREBOARD_ZOOM so existing TVs keep their current zoom
    // with no config changes; otherwise 100. Clamped defensively [50, 300].
    kioskZoom: (() => {
      const kiosk = parseInt(config.KIOSK_ZOOM || '', 10);
      const board = parseInt(config.SCOREBOARD_ZOOM || '', 10);
      const n = Number.isFinite(kiosk) ? kiosk : Number.isFinite(board) ? board : 100;
      return Math.min(300, Math.max(50, n));
    })(),
    bgUrl: config.SCOREBOARD_BG_URL || '',
    bgMode: config.SCOREBOARD_BG_MODE || 'cover',
    bgOpacity: config.SCOREBOARD_BG_OPACITY ? parseFloat(config.SCOREBOARD_BG_OPACITY) : 1,
    logoUrl: config.SCOREBOARD_LOGO_ENABLED === 'false' ? '' : (config.LOGO_URL || ''),
    logoPosition: config.LOGO_POSITION || 'left',
    logoMaxHeight: parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64,
    titleHidden: config.SCOREBOARD_TITLE_HIDDEN === 'true',
    titleText: config.SCOREBOARD_TITLE || roomName || 'High Scores',
    titleStyle: config.SCOREBOARD_TITLE_STYLE || 'default',
    titleSize: config.SCOREBOARD_TITLE_SIZE || 'sm',
    rankingsPosition: config.SCOREBOARD_RANKINGS_POSITION || 'left',
    rankingsSticky: config.SCOREBOARD_RANKINGS_STICKY === 'true',
    rankingsStyle: (['match', 'plaque', 'compact', 'sidebar', 'ticker'].includes(config.SCOREBOARD_RANKINGS_STYLE || '')
      ? config.SCOREBOARD_RANKINGS_STYLE
      : 'match') as ScoreboardConfig['rankingsStyle'],
    hideEmpty: config.SCOREBOARD_HIDE_EMPTY === 'true',
    requirePhoto: config.REQUIRE_SCORE_PHOTO === 'true',
    qrMode: config.SCOREBOARD_QR_MODE || 'disabled',
    // v2.13.12 — default size bumped 24 → 30 (~25% larger) for better phone scanning.
    qrSize: parseInt(config.SCOREBOARD_QR_SIZE || '30', 10) || 30,
    qrPosition: normalizeQrPosition(config.SCOREBOARD_QR_POSITION),
    qrOffsetPx: deriveQrOffsetPx(config),
    gameTitleStyle: config.SCOREBOARD_GAME_TITLE_STYLE || 'default',
    bgBehindTitle: (config.SCOREBOARD_BG_MODE || 'cover') === 'fill-entire',
    mobileVertical: config.SCOREBOARD_MOBILE_VERTICAL !== 'false',
    // s20 bumped 0.6 -> 0.85 as an interim mitigation until the true mobile
    // layout landed. S21 is that promised work (true full-width mobile cards
    // at natural scale) — mobileScale is now an opt-in densifier defaulting
    // to 1.0 (no shrink). Rooms/viewers with an explicit value keep it,
    // clamped to the supported range.
    mobileScale: (() => {
      const raw = config.SCOREBOARD_MOBILE_SCALE ? parseFloat(config.SCOREBOARD_MOBILE_SCALE) : 1.0;
      const n = Number.isFinite(raw) ? raw : 1.0;
      return Math.min(1.0, Math.max(0.3, n));
    })(),
  };
}

/** Card width for the current style */
export function getCardWidth(style: ScoreboardStyle): number {
  return STYLE_WIDTHS[style] || STYLE_WIDTHS.banner;
}

/**
 * QR edge geometry (owner call, 2026-08-15).
 *
 * The QR anchors to the card's top or bottom edge, horizontally centred, and
 * `offsetPx` is its SIGNED distance from that edge:
 *
 *   offsetPx = -10  →  10px of the QR sits INSIDE the card, the rest hangs off
 *   offsetPx =   0  →  the QR touches the edge from outside
 *   offsetPx = +12  →  a 12px gap between the card edge and the QR
 *
 * Returns:
 *   - `outside`     px the QR extends BEYOND the card edge. The layout must
 *                   reserve this much room on that side, and the absolutely
 *                   positioned QR uses it as its negative `top`/`bottom`.
 *   - `peek`        px of QR visible inside the card (0 unless offset < 0).
 *   - `footerExtra` extra padding so card content clears the peek.
 *
 * Replaces `qrBottomMetrics`, which only understood bottom edges and could not
 * express a positive gap (its `overlapPx` was clamped at zero).
 */
export function qrEdgeMetrics(
  qrSize: number,
  qrEnabled: boolean,
  qrPosition: 'top-center' | 'bottom-center' = 'top-center',
  offsetPx: number = DEFAULT_QR_OFFSET_PX,
): { outside: number; peek: number; footerExtra: number } {
  if (!qrEnabled || qrSize <= 0) {
    return { outside: 0, peek: 0, footerExtra: 0 };
  }
  const peek = Math.max(0, Math.min(qrSize, -offsetPx));
  const outside = Math.max(0, qrSize + offsetPx);
  return {
    outside,
    peek,
    // Only a BOTTOM-anchored QR overlaps the footer; a top-anchored one
    // overlaps the header art, which needs no padding.
    footerExtra: qrPosition === 'bottom-center' && peek > 0 ? Math.round(peek) + 4 : 0,
  };
}

// ═══════════════════════════════════════════
// Legacy config (kept temporarily for old GameCard)
// ═══════════════════════════════════════════

export interface CardDisplayProps {
  maxScores: number;
  hideEmpty: boolean;
  titleHidden: boolean;
  titleText: string;
  titleStyle: string;
  titleSize: string;
  zoom: number;
  bgUrl: string;
  bgMode: string;
  logoUrl: string;
  logoPosition: string;
  logoMaxHeight: number;
  layout: string;
  cardSize: string;
  cardWidth: number;
  rankingsPosition: string;
  requirePhoto: boolean;
  cardOpacity: number | undefined;
  bgOpacity: number;
  scoreColumns: number;
  qrMode: string;
  headerStyle: string;
  bgFill: string;
  bgSize: string;
  wheelScale: number;
  gameColumns: string;
  glassOpacity: number;
  scoreStyle: string;
  gameTitleStyle: string;
  gameTitleEnhance: boolean;
  globalStyles: GlobalCardStyles | undefined;
}

/**
 * Legacy: derives old-style card props from settings.
 * Kept temporarily while old GameCard is still used on the admin Leaderboard page.
 */
export function deriveCardProps(config: Record<string, string>, roomName?: string): CardDisplayProps {
  const rawLayout = config.SCOREBOARD_CARD_LAYOUT || 'banner';
  const headerStyle = rawLayout === 'fullart' ? 'banner' : rawLayout;
  const bgFill = rawLayout === 'fullart' ? 'fill' : (config.SCOREBOARD_BG_FILL || 'off');
  const cardSize = config.SCOREBOARD_CARD_SIZE || 'medium';

  const globalStyles: GlobalCardStyles | undefined = config.GLOBAL_CARD_STYLES_ENABLED === 'true' ? {
    enabled: true,
    cssTitle: config.GLOBAL_CARD_CSS_TITLE || undefined,
    cssScores: config.GLOBAL_CARD_CSS_SCORES || undefined,
    cssBox: config.GLOBAL_CARD_CSS_BOX || undefined,
    bgColor: config.GLOBAL_CARD_BG_COLOR || undefined,
  } : undefined;

  return {
    maxScores: parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5,
    hideEmpty: config.SCOREBOARD_HIDE_EMPTY === 'true',
    titleHidden: config.SCOREBOARD_TITLE_HIDDEN === 'true',
    titleText: config.SCOREBOARD_TITLE || roomName || 'High Scores',
    titleStyle: config.SCOREBOARD_TITLE_STYLE || 'default',
    titleSize: config.SCOREBOARD_TITLE_SIZE || 'sm',
    zoom: parseInt(config.SCOREBOARD_ZOOM || '100', 10) || 100,
    bgUrl: config.SCOREBOARD_BG_URL || '',
    bgMode: config.SCOREBOARD_BG_MODE || 'cover',
    logoUrl: config.SCOREBOARD_LOGO_ENABLED === 'false' ? '' : (config.LOGO_URL || ''),
    logoPosition: config.LOGO_POSITION || 'left',
    logoMaxHeight: parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64,
    layout: config.SCOREBOARD_LAYOUT || 'scroll',
    cardSize,
    cardWidth: cardWidthMap[cardSize] || 288,
    rankingsPosition: config.SCOREBOARD_RANKINGS_POSITION || 'left',
    requirePhoto: config.REQUIRE_SCORE_PHOTO === 'true',
    cardOpacity: config.SCOREBOARD_CARD_OPACITY ? parseFloat(config.SCOREBOARD_CARD_OPACITY) : undefined,
    bgOpacity: config.SCOREBOARD_BG_OPACITY ? parseFloat(config.SCOREBOARD_BG_OPACITY) : 1,
    scoreColumns: parseInt(config.SCOREBOARD_SCORE_COLUMNS || '1', 10) || 1,
    qrMode: config.SCOREBOARD_QR_MODE || 'disabled',
    headerStyle,
    bgFill,
    bgSize: config.SCOREBOARD_BG_SIZE || 'cover',
    wheelScale: parseInt(config.SCOREBOARD_WHEEL_SCALE || '150', 10) || 150,
    gameColumns: config.SCOREBOARD_GAME_COLUMNS || 'auto',
    glassOpacity: parseInt(config.SCOREBOARD_GLASS_OPACITY || '60', 10) || 60,
    scoreStyle: config.SCOREBOARD_SCORE_STYLE || 'glass',
    gameTitleStyle: config.SCOREBOARD_GAME_TITLE_STYLE || 'default',
    gameTitleEnhance: config.SCOREBOARD_GAME_TITLE_ENHANCE === 'true',
    globalStyles,
  };
}
