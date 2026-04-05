import type { GlobalCardStyles } from '../components/ScoreboardComponents';
import { cardWidthMap } from '../components/ScoreboardComponents';

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
 * Derives card display props from a settings config record.
 * Used by both Scoreboard.tsx and ScoreboardPreview.tsx.
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
