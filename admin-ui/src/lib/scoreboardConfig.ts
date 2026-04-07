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
  hideEmpty: boolean;
  requirePhoto: boolean;
  qrMode: string;
  qrSize: number;
  qrPosition: string;            // 'top-right' | 'bottom-right'
  gameTitleStyle: string;         // same options as titleStyle (glow, fire, plasma, etc.)
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
    bgUrl: config.SCOREBOARD_BG_URL || '',
    bgMode: config.SCOREBOARD_BG_MODE || 'cover',
    bgOpacity: config.SCOREBOARD_BG_OPACITY ? parseFloat(config.SCOREBOARD_BG_OPACITY) : 1,
    logoUrl: config.LOGO_URL || '',
    logoPosition: config.LOGO_POSITION || 'left',
    logoMaxHeight: parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64,
    titleHidden: config.SCOREBOARD_TITLE_HIDDEN === 'true',
    titleText: config.SCOREBOARD_TITLE || roomName || 'High Scores',
    titleStyle: config.SCOREBOARD_TITLE_STYLE || 'default',
    titleSize: config.SCOREBOARD_TITLE_SIZE || 'sm',
    rankingsPosition: config.SCOREBOARD_RANKINGS_POSITION || 'left',
    rankingsSticky: config.SCOREBOARD_RANKINGS_STICKY === 'true',
    hideEmpty: config.SCOREBOARD_HIDE_EMPTY === 'true',
    requirePhoto: config.REQUIRE_SCORE_PHOTO === 'true',
    qrMode: config.SCOREBOARD_QR_MODE || 'disabled',
    qrSize: parseInt(config.SCOREBOARD_QR_SIZE || '24', 10) || 24,
    qrPosition: config.SCOREBOARD_QR_POSITION || 'top-right',
    gameTitleStyle: config.SCOREBOARD_GAME_TITLE_STYLE || 'default',
  };
}

/** Card width for the current style */
export function getCardWidth(style: ScoreboardStyle): number {
  return STYLE_WIDTHS[style] || STYLE_WIDTHS.banner;
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
    logoUrl: config.LOGO_URL || '',
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
