import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import { DEFAULT_QR_OFFSET_PX } from '../../lib/scoreboardConfig';
import type { PodiumVariant, ScoreboardStyle } from '../../lib/scoreboardThemes';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../../lib/scoreboardThemes';
import ShowcaseCard from './ShowcaseCard';
import BannerCard from './BannerCard';
import MinimalCard from './MinimalCard';
import ArcadeCard from './ArcadeCard';

export interface CardRouterProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  style: ScoreboardStyle;
  theme?: string;
  /** Showcase podium override (per-room setting). When set it wins over the
   *  theme's own `podiumVariant`; omitted (older callers/tests) keeps the
   *  theme default. */
  podiumVariant?: PodiumVariant;
  maxScores: number;
  minScores?: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  qrSize?: number;
  qrPosition?: 'top-center' | 'bottom-center';
  /** v2.13.12 — pixels of QR that overlap the card's bottom edge (bottom-anchored
   *  positions only). Defaults to 10 when omitted. */
  qrOffsetPx?: number;
  cardBgFill?: boolean;
  /** v2.115.0 — room/viewer "Game Art Header" toggle. Default true; when false
   *  the cards drop their header ART but keep title, chip and countdown. */
  gameHeaderEnabled?: boolean;
  cardSpacing?: number;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** v2.2.8 — title-click navigation target (replaces the old GameCard Link overlay). */
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
  /**
   * v2.109.0 (score-gesture-photos) — opens the game's quick popup; every
   * card row's click routes here once it's expanded (or immediately for a
   * single-score row). Omitting this prop changes nothing (rows stay on
   * plain inline expand, same as before).
   */
  onOpenQuickView?: () => void;
}

export default function CardRouter({
  lb,
  slug,
  roomId,
  style,
  theme,
  podiumVariant,
  maxScores,
  minScores = 20,
  showTimer = true,
  viewerUsername,
  viewerEntry,
  qrMode = 'disabled',
  qrSize = 30,
  qrPosition = 'top-center',
  qrOffsetPx = DEFAULT_QR_OFFSET_PX,
  cardBgFill = false,
  gameHeaderEnabled = true,
  titleFontSize,
  gameTitleStyle,
  onSubmitScore,
  titleLinkTo,
  titleLinkOnClick,
  onOpenQuickView,
}: CardRouterProps) {
  const commonProps = {
    lb,
    slug,
    roomId,
    maxScores,
    minScores,
    showTimer,
    viewerUsername,
    viewerEntry,
    qrMode,
    qrSize,
    qrPosition,
    qrOffsetPx,
    cardBgFill,
    gameHeaderEnabled,
    titleFontSize,
    gameTitleStyle,
    onSubmitScore,
    titleLinkTo,
    titleLinkOnClick,
    onOpenQuickView,
  };

  switch (style) {
    case 'arcade':
      return <ArcadeCard {...commonProps} />;
    case 'showcase': {
      const themeConfig = SHOWCASE_THEMES[theme || DEFAULT_SHOWCASE_THEME] ?? SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]!;
      const effectiveTheme = podiumVariant ? { ...themeConfig, podiumVariant } : themeConfig;
      return <ShowcaseCard {...commonProps} theme={effectiveTheme} />;
    }
    case 'minimal':
      return <MinimalCard {...commonProps} />;
    case 'banner':
    default:
      return <BannerCard {...commonProps} />;
  }
}
