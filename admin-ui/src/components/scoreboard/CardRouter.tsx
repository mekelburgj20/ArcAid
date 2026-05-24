import type { GameLeaderboard, RankedEntry } from '../ScoreboardComponents';
import type { ScoreboardStyle } from '../../lib/scoreboardThemes';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../../lib/scoreboardThemes';
import ShowcaseCard from './ShowcaseCard';
import BannerCard from './BannerCard';
import MinimalCard from './MinimalCard';

export interface CardRouterProps {
  lb: GameLeaderboard;
  slug: string;
  roomId?: string;
  style: ScoreboardStyle;
  theme?: string;
  maxScores: number;
  minScores?: number;
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  qrSize?: number;
  qrPosition?: string;
  /** v2.13.12 — pixels of QR that overlap the card's bottom edge (bottom-anchored
   *  positions only). Defaults to 10 when omitted. */
  qrOverlapPx?: number;
  cardBgFill?: boolean;
  cardSpacing?: number;
  titleFontSize?: number;
  gameTitleStyle?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
  /** v2.2.8 — title-click navigation target (replaces the old GameCard Link overlay). */
  titleLinkTo?: string;
  titleLinkOnClick?: (e: React.MouseEvent) => void;
}

export default function CardRouter({
  lb,
  slug,
  roomId,
  style,
  theme,
  maxScores,
  minScores = 20,
  showTimer = true,
  viewerUsername,
  viewerEntry,
  qrMode = 'disabled',
  qrSize = 30,
  qrPosition = 'top-right',
  qrOverlapPx = 10,
  cardBgFill = false,
  titleFontSize,
  gameTitleStyle,
  onSubmitScore,
  titleLinkTo,
  titleLinkOnClick,
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
    qrOverlapPx,
    cardBgFill,
    titleFontSize,
    gameTitleStyle,
    onSubmitScore,
    titleLinkTo,
    titleLinkOnClick,
  };

  switch (style) {
    case 'showcase': {
      const themeConfig = SHOWCASE_THEMES[theme || DEFAULT_SHOWCASE_THEME] ?? SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]!;
      return <ShowcaseCard {...commonProps} theme={themeConfig} />;
    }
    case 'minimal':
      return <MinimalCard {...commonProps} />;
    case 'banner':
    default:
      return <BannerCard {...commonProps} />;
  }
}
