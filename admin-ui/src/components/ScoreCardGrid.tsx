import { Plus } from 'lucide-react';
import CardRouter from './scoreboard/CardRouter';
import { GameCard } from './ScoreboardComponents';
import type { GameLeaderboard, RankedEntry } from './ScoreboardComponents';
import { deriveScoreboardConfig, deriveCardProps, getCardWidth } from '../lib/scoreboardConfig';
import { LOAD_MORE_LABEL } from '../lib/scoresCopy';

/**
 * Presentational card grid extracted from the legacy GamesTabView (verbatim
 * render block: useNewCards CardRouter/GameCard dispatch, config derivation,
 * the auto-fill grid, hover "+" submit button, loading spinner, Load-More
 * button, and an empty-state slot). This is the coherence guarantee that
 * Tournaments | Room Scores | Global all render identical cards — no card
 * variant lives outside this component.
 */
export interface ScoreCardGridProps {
  cards: (GameLeaderboard & { viewerEntry?: RankedEntry | null })[];
  slug: string;
  roomId: string;
  config: Record<string, string>;
  roomName: string;
  viewerUsername?: string;
  loading: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  emptyState: React.ReactNode;
  linkFor: (lb: GameLeaderboard) => string;
  onSubmit: (lb: GameLeaderboard) => void;
  onTitleClick?: (lb: GameLeaderboard, e: React.MouseEvent) => void;
}

export default function ScoreCardGrid({
  cards,
  slug,
  roomId,
  config,
  roomName,
  viewerUsername,
  loading,
  hasMore,
  loadingMore,
  onLoadMore,
  emptyState,
  linkFor,
  onSubmit,
  onTitleClick,
}: ScoreCardGridProps) {
  const useNewCards = !!config.SCOREBOARD_STYLE;
  const newConfig = deriveScoreboardConfig(config, roomName);
  const legacyProps = deriveCardProps(config, roomName);
  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyProps.cardWidth;
  const cardGap = useNewCards ? newConfig.cardSpacing : 20;

  // Plain left-click opens the caller's title-click handler (e.g. a quick-view
  // modal); modifier/middle-click falls through to the underlying <Link href>
  // so the user can open the full page in a new tab.
  const handleTitleClick = (lb: GameLeaderboard) => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      onTitleClick?.(lb, e);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (cards.length === 0) {
    return <>{emptyState}</>;
  }

  return (
    <>
      <div
        className="grid"
        style={{
          gap: cardGap,
          gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.85)}px, 100%), 1fr))`,
          justifyContent: 'center',
        }}
      >
        {cards.map(lb => {
          const linkTo = linkFor(lb);

          return (
            <div
              key={`${lb.gameStatus}-${lb.gameId}`}
              className="relative group/card justify-self-center w-full"
              style={{ maxWidth: `${cardWidth}px` }}
            >
              {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter. */}
              {useNewCards ? (
                <CardRouter
                  lb={lb}
                  slug={slug}
                  roomId={roomId}
                  style={newConfig.style}
                  theme={newConfig.theme}
                  maxScores={newConfig.maxScores}
                  minScores={newConfig.minScores}
                  showTimer={false}
                  cardBgFill={newConfig.cardBgFill}
                  titleFontSize={newConfig.titleFontSize || undefined}
                  viewerUsername={viewerUsername}
                  viewerEntry={lb.viewerEntry}
                  qrMode="disabled"
                  gameTitleStyle={newConfig.gameTitleStyle}
                  titleLinkTo={linkTo}
                  titleLinkOnClick={onTitleClick ? handleTitleClick(lb) : undefined}
                />
              ) : (
                <GameCard
                  lb={lb}
                  slug={slug}
                  maxScores={legacyProps.maxScores}
                  roomId={roomId}
                  cardOpacity={legacyProps.cardOpacity}
                  scoreColumns={legacyProps.scoreColumns}
                  viewerUsername={viewerUsername}
                  viewerEntry={lb.viewerEntry}
                  headerStyle={legacyProps.headerStyle}
                  globalStyles={legacyProps.globalStyles}
                  wheelScale={legacyProps.wheelScale}
                  bgFill={legacyProps.bgFill}
                  bgSize={legacyProps.bgSize}
                  cardWidth={legacyProps.cardWidth}
                  glassOpacity={legacyProps.glassOpacity}
                  gameTitleStyle={legacyProps.gameTitleStyle}
                  gameTitleEnhance={legacyProps.gameTitleEnhance}
                  scoreStyle={legacyProps.scoreStyle}
                />
              )}

              <button
                className="absolute top-2 right-2 z-20 w-8 h-8 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/20 flex items-center justify-center opacity-0 group-hover/card:opacity-100 focus:opacity-100 transition-opacity cursor-pointer backdrop-blur-sm"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); onSubmit(lb); }}
                aria-label={`Submit score for ${lb.displayName || lb.gameName}`}
                title="Submit score"
              >
                <Plus size={16} />
              </button>
            </div>
          );
        })}
      </div>
      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            onClick={onLoadMore}
            disabled={loadingMore}
            className="px-5 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50 cursor-pointer"
          >
            {loadingMore ? 'Loading...' : LOAD_MORE_LABEL}
          </button>
        </div>
      )}
    </>
  );
}
