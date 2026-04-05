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
  showTimer?: boolean;
  viewerUsername?: string;
  viewerEntry?: RankedEntry | null;
  qrMode?: string;
  onSubmitScore?: (lb: GameLeaderboard) => void;
}

export default function CardRouter({
  lb,
  slug,
  roomId,
  style,
  theme,
  maxScores,
  showTimer = true,
  viewerUsername,
  viewerEntry,
  qrMode = 'disabled',
  onSubmitScore,
}: CardRouterProps) {
  switch (style) {
    case 'showcase': {
      const themeConfig = SHOWCASE_THEMES[theme || DEFAULT_SHOWCASE_THEME] ?? SHOWCASE_THEMES[DEFAULT_SHOWCASE_THEME]!;
      return (
        <ShowcaseCard
          lb={lb}
          slug={slug}
          roomId={roomId}
          theme={themeConfig}
          maxScores={maxScores}
          showTimer={showTimer}
          viewerUsername={viewerUsername}
          viewerEntry={viewerEntry}
          qrMode={qrMode}
          onSubmitScore={onSubmitScore}
        />
      );
    }
    case 'minimal':
      return (
        <MinimalCard
          lb={lb}
          slug={slug}
          roomId={roomId}
          maxScores={maxScores}
          showTimer={showTimer}
          viewerUsername={viewerUsername}
          viewerEntry={viewerEntry}
          qrMode={qrMode}
          onSubmitScore={onSubmitScore}
        />
      );
    case 'banner':
    default:
      return (
        <BannerCard
          lb={lb}
          slug={slug}
          roomId={roomId}
          maxScores={maxScores}
          showTimer={showTimer}
          viewerUsername={viewerUsername}
          viewerEntry={viewerEntry}
          qrMode={qrMode}
          onSubmitScore={onSubmitScore}
        />
      );
  }
}
