import type { GlobalCardStyles } from '../components/ScoreboardComponents';
import { cardWidthMap } from '../components/ScoreboardComponents';
import type { ScoreboardStyle } from './scoreboardThemes';
import { STYLE_WIDTHS, DEFAULT_SHOWCASE_THEME } from './scoreboardThemes';

// ═══════════════════════════════════════════
// New config interface (Style + Theme system)
// ═══════════════════════════════════════════

export interface ScoreboardConfig {
  // Card style + theme
  style: ScoreboardStyle;
  theme: string;                // only used when style === 'showcase'
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
  qrPosition: string;            // 'top-right' | 'bottom-right' | 'bottom-center'
  /** v2.13.12 — pixels of QR that overlap the card's bottom edge (only applies
   *  to bottom-anchored positions). 0 = QR touches the bottom edge from below;
   *  higher = more of the QR sits inside the card. Default 10. */
  qrOverlapPx: number;
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

  // Validate style
  if (!['banner', 'showcase', 'minimal'].includes(style)) {
    style = 'banner';
  }

  return {
    style,
    theme,
    maxScores: parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5,
    minScores: parseInt(config.SCOREBOARD_MIN_SCORES || '20', 10) || 20,
    showTimer: config.SCOREBOARD_SHOW_TIMER !== 'false',
    cardBgFill: config.SCOREBOARD_CARD_BG_FILL === 'true',
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
    qrPosition: config.SCOREBOARD_QR_POSITION || 'top-right',
    qrOverlapPx: (() => {
      const raw = parseInt(config.SCOREBOARD_QR_OVERLAP_PX || '10', 10);
      return Number.isFinite(raw) ? Math.max(0, raw) : 10;
    })(),
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
 * Geometry for bottom-anchored QR placements (`bottom-center` and `bottom-right`).
 * The QR straddles the card's bottom edge: `overlapPx` of it sits inside the
 * card, the rest hangs below.
 *
 * Returns:
 *   - `overhang`     px below the card baseline (used for marginBottom on the
 *                    layout wrapper AND for `bottom: -overhang` on the
 *                    absolutely-positioned bottom-center QR, AND for the
 *                    negative marginTop trick on bottom-right). Equals
 *                    `qrSize - peek`.
 *   - `peek`         px of QR visible inside the card. Equals `overlapPx`
 *                    clamped to `[0, qrSize]`.
 *   - `footerExtra`  extra bottom padding for the footer to clear the peek.
 *
 * v2.13.12 — refactored to take `overlapPx` as a user-controlled parameter
 * (was hardcoded to min(4, qrSize * 0.1)) and to apply to bottom-right as well
 * as bottom-center (was bottom-center only). Default overlap = 10px.
 */
export function qrBottomMetrics(
  qrSize: number,
  qrEnabled: boolean,
  qrPosition: string,
  overlapPx: number = 10,
): { overhang: number; peek: number; footerExtra: number } {
  // Only bottom-anchored positions need overhang reservation.
  if (!qrEnabled || qrSize <= 0 || (qrPosition !== 'bottom-center' && qrPosition !== 'bottom-right')) {
    return { overhang: 0, peek: 0, footerExtra: 0 };
  }
  const peek = Math.max(0, Math.min(qrSize, overlapPx));
  const overhang = Math.max(0, qrSize - peek);
  return {
    overhang,
    peek,
    footerExtra: Math.round(peek) + 4,
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
