import { useRef, useState, useEffect } from 'react';
import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard } from './ScoreboardComponents';
import CardRouter from './scoreboard/CardRouter';
import { deriveCardProps, deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';

const MOCK_LEADERBOARDS: GameLeaderboard[] = [
  {
    gameId: 'preview-1',
    gameName: 'Medieval Madness',
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-1168',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'DragonSlayer', score: 999_999_999_999 },
      { rank: 2, discord_user_id: '', iscored_username: 'PinWizard42', score: 456_123_789 },
      { rank: 3, discord_user_id: '', iscored_username: 'FlipperKing', score: 123_456_789 },
      { rank: 4, discord_user_id: '', iscored_username: 'SilverBallSam', score: 98_765_432 },
      { rank: 5, discord_user_id: '', iscored_username: 'NovicePlayer', score: 1_234_567 },
    ],
  },
  {
    gameId: 'preview-2',
    gameName: 'The Addams Family',
    tournamentName: 'Weekly Grind',
    tournamentType: 'WG-VPXS',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-5441',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'BumperQueen', score: 876_543_210 },
      { rank: 2, discord_user_id: '', iscored_username: 'TiltMaster', score: 654_321_098 },
      { rank: 3, discord_user_id: '', iscored_username: 'MultiballMax', score: 432_109_876 },
    ],
  },
  {
    gameId: 'preview-3',
    gameName: 'Twilight Zone',
    tournamentName: 'Monthly Grind',
    tournamentType: 'MG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'iscored-5469',
    logoStyleId: null,
    bgStyleId: null,
    catHasBg: 1,
    catHasHeader: 1,
    styleHeaderDisabled: false,
    rankings: [
      { rank: 1, discord_user_id: '', iscored_username: 'ZoneRunner', score: 543_210_987 },
      { rank: 2, discord_user_id: '', iscored_username: 'PowerBall99', score: 321_098_765 },
      { rank: 3, discord_user_id: '', iscored_username: 'RampChamp', score: 210_987_654 },
      { rank: 4, discord_user_id: '', iscored_username: 'SpinnerSue', score: 109_876_543 },
    ],
  },
];

interface ScoreboardPreviewProps {
  settings: Record<string, string>;
}

export default function ScoreboardPreview({ settings }: ScoreboardPreviewProps) {
  const newConfig = deriveScoreboardConfig(settings);
  const useNewCards = !!settings.SCOREBOARD_STYLE;

  const legacyProps = deriveCardProps(settings);
  const {
    maxScores, cardWidth: legacyCardWidth, cardOpacity, scoreColumns,
    headerStyle, bgFill, bgSize, wheelScale, globalStyles,
    layout, gameColumns, glassOpacity, gameTitleStyle, gameTitleEnhance, scoreStyle,
  } = legacyProps;

  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyCardWidth;
  const effectiveLayout = useNewCards ? newConfig.layout : layout;

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const observer = new ResizeObserver(() => {
      const containerWidth = container.clientWidth;
      const contentWidth = content.scrollWidth;
      const newScale = contentWidth > containerWidth
        ? containerWidth / contentWidth
        : 1;
      setScale(newScale);
      setContentHeight(content.scrollHeight * newScale);
    });

    observer.observe(container);
    observer.observe(content);
    return () => observer.disconnect();
  }, [effectiveLayout, gameColumns, cardWidth, headerStyle, useNewCards, newConfig.style]);

  const wheelPad = !useNewCards && headerStyle === 'wheel' ? '2.5rem' : undefined;

  return (
    <div className="relative">
      {/* Preview badge */}
      <div className="absolute -top-2.5 right-2 z-10 px-2 py-0.5 bg-neon-cyan/20 border border-neon-cyan/40 rounded text-[10px] font-display font-bold text-neon-cyan uppercase tracking-wider">
        Preview
      </div>

      {/* Scaled preview container */}
      <div
        ref={containerRef}
        className="border-2 border-dashed border-border/50 rounded-lg p-3 overflow-hidden"
        style={contentHeight != null ? { height: `${contentHeight + 24}px` } : undefined}
      >
        <div
          ref={contentRef}
          style={{
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            width: scale < 1 ? `${100 / scale}%` : undefined,
          }}
        >
          {effectiveLayout === 'grid' ? (
            <div
              className={`grid gap-3 ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
              style={useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(${Math.round(cardWidth * 0.7)}px, 1fr))` } : undefined}
            >
              {MOCK_LEADERBOARDS.map(lb => (
                <div key={lb.gameId} className="grid" style={wheelPad ? { paddingTop: wheelPad } : undefined}>
                  {useNewCards ? (
                    <CardRouter
                      lb={lb}
                      slug="preview"
                      style={newConfig.style}
                      theme={newConfig.theme}
                      maxScores={newConfig.maxScores}
                      showTimer={newConfig.showTimer}
                    />
                  ) : (
                    <GameCard
                      lb={lb}
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
                      glassOpacity={glassOpacity}
                      gameTitleStyle={gameTitleStyle}
                      gameTitleEnhance={gameTitleEnhance}
                      scoreStyle={scoreStyle}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <div className="flex gap-3">
                {MOCK_LEADERBOARDS.map(lb => (
                  <div
                    key={lb.gameId}
                    className="flex-shrink-0"
                    style={{ width: `${cardWidth}px`, ...(wheelPad ? { paddingTop: wheelPad } : {}) }}
                  >
                    {useNewCards ? (
                      <CardRouter
                        lb={lb}
                        slug="preview"
                        style={newConfig.style}
                        theme={newConfig.theme}
                        maxScores={newConfig.maxScores}
                        showTimer={newConfig.showTimer}
                      />
                    ) : (
                      <GameCard
                        lb={lb}
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
                        glassOpacity={glassOpacity}
                        gameTitleStyle={gameTitleStyle}
                        gameTitleEnhance={gameTitleEnhance}
                        scoreStyle={scoreStyle}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
