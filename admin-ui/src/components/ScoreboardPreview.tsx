import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard } from './ScoreboardComponents';
import { deriveCardProps } from '../lib/scoreboardConfig';

const MOCK_LEADERBOARD: GameLeaderboard = {
  gameId: 'preview-1',
  gameName: 'Medieval Madness',
  tournamentName: 'Daily Grind',
  tournamentType: 'DG',
  imageUrl: null,
  gameStatus: 'ACTIVE',
  catalogueStyleId: null,
  logoStyleId: null,
  bgStyleId: null,
  styleHeaderDisabled: false,
  rankings: [
    { rank: 1, discord_user_id: '', iscored_username: 'DragonSlayer', score: 999_999_999_999 },
    { rank: 2, discord_user_id: '', iscored_username: 'PinWizard42', score: 456_123_789 },
    { rank: 3, discord_user_id: '', iscored_username: 'FlipperKing', score: 123_456_789 },
    { rank: 4, discord_user_id: '', iscored_username: 'SilverBallSam', score: 98_765_432 },
    { rank: 5, discord_user_id: '', iscored_username: 'NovicePlayer', score: 1_234_567 },
  ],
};

interface ScoreboardPreviewProps {
  settings: Record<string, string>;
}

export default function ScoreboardPreview({ settings }: ScoreboardPreviewProps) {
  const {
    maxScores, cardWidth, cardOpacity, scoreColumns,
    headerStyle, bgFill, bgSize, wheelScale, globalStyles,
  } = deriveCardProps(settings);

  return (
    <div className="relative">
      {/* Preview badge */}
      <div className="absolute -top-2.5 right-2 z-10 px-2 py-0.5 bg-neon-cyan/20 border border-neon-cyan/40 rounded text-[10px] font-display font-bold text-neon-cyan uppercase tracking-wider">
        Preview
      </div>
      {/* Card container with dashed border */}
      <div
        className="border-2 border-dashed border-border/50 rounded-lg p-4 flex justify-center"
        style={headerStyle === 'wheel' ? { paddingTop: '3.5rem' } : undefined}
      >
        <div style={{ width: `${cardWidth}px`, maxWidth: '100%' }}>
          <GameCard
            lb={MOCK_LEADERBOARD}
            slug="preview"
            maxScores={maxScores}
            cardOpacity={cardOpacity}
            scoreColumns={scoreColumns}
            headerStyle={headerStyle}
            globalStyles={globalStyles}
            wheelScale={wheelScale}
            bgFill={bgFill}
            bgSize={bgSize}
            cardWidth={cardWidth}
          />
        </div>
      </div>
    </div>
  );
}
