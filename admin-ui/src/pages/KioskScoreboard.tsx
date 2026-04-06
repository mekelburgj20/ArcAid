import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
} from '../components/ScoreboardComponents';
import CardRouter from '../components/scoreboard/CardRouter';
import { deriveCardProps, deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';

export default function KioskScoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [configLoaded, setConfigLoaded] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');

  // Resolve room and fetch scoreboard config
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((portal: { id: string; name: string }) => {
        setRoomName(portal.name);
        setRoomId(portal.id);
        return fetch(`/api/rooms/${portal.id}/scoreboard-config`);
      })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => { setConfig(cfg || {}); setConfigLoaded(true); })
      .catch(() => { setConfigLoaded(true); });
  }, [slug]);

  const loadData = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/leaderboard`);
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
    try {
      const res = await fetch(`/api/rooms/${roomId}/rankings`);
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
  }, [roomId]);

  // Initial load + auto-refresh
  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const refreshSeconds = parseInt(config.KIOSK_REFRESH_SECONDS || '60', 10);
    if (refreshSeconds > 0) {
      const interval = setInterval(loadData, refreshSeconds * 1000);
      return () => clearInterval(interval);
    }
  }, [loadData, config.KIOSK_REFRESH_SECONDS]);

  // New style/theme config
  const newConfig = deriveScoreboardConfig(config, roomName);
  const useNewCards = !!config.SCOREBOARD_STYLE;

  // Legacy config
  const legacyProps = deriveCardProps(config, roomName);
  const {
    maxScores, hideEmpty, titleHidden, titleText, titleStyle, titleSize,
    zoom, bgUrl, bgMode, logoUrl, logoPosition, logoMaxHeight,
    layout: legacyLayout, cardWidth: legacyCardWidth, rankingsPosition,
    cardOpacity, bgOpacity,
    headerStyle, bgFill, bgSize, wheelScale, gameColumns, globalStyles,
    glassOpacity, gameTitleStyle, gameTitleEnhance, scoreStyle,
  } = legacyProps;
  const layout = useNewCards ? newConfig.layout : legacyLayout;

  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyCardWidth;
  const visibleLeaderboards = (useNewCards ? newConfig.hideEmpty : hideEmpty) ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;

  // Guard: wait for config to load, then check if kiosk is enabled
  if (!configLoaded) {
    return <div className="min-h-screen bg-deep" />;
  }
  if (config.KIOSK_ENABLED !== 'true') {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <p className="text-muted font-display text-lg">Kiosk mode is not available for this room</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary relative">
      {/* Background image layer with opacity control */}
      {bgUrl && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
            opacity: bgOpacity,
          }}
        />
      )}
      <div
        className="px-4 sm:px-6 py-6 relative"
        style={{
          ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
          minHeight: '100vh',
        }}
      >
        {/* Title */}
        {!titleHidden && (
          <div className="text-center mb-8 overflow-hidden">
            <div className={`inline-flex items-center gap-4 max-w-full ${
              logoPosition === 'above' || logoPosition === 'below' ? 'flex-col' : 'flex-row'
            }`}>
              {logoUrl && (logoPosition === 'left' || logoPosition === 'above') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain flex-shrink-0" />
              )}
              <p className={`font-display text-muted ${getTitleSizeClass(titleSize)} uppercase tracking-widest ${getTitleStyleClass(titleStyle)} min-w-0`}>
                {titleText}
              </p>
              {logoUrl && (logoPosition === 'right' || logoPosition === 'below') && (
                <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain flex-shrink-0" />
              )}
            </div>
          </div>
        )}
        {titleHidden && logoUrl && (
          <div className="text-center mb-8">
            <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto" />
          </div>
        )}

        {/* Rankings: top position */}
        {rankingsPosition === 'top' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
        )}

        {/* Main content area */}
        <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-stretch lg:items-start`}>

          {/* Rankings: left position */}
          {rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-24">
              <p className="text-muted font-display">Waiting for active games...</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div
                className={`grid ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
                style={{
                  ...(useNewCards ? { gap: newConfig.cardSpacing } : {}),
                  ...(useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.7)}px, 100%), 1fr))` } : {}),
                }}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="grid" style={!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : undefined}>
                    {useNewCards ? (
                      <CardRouter
                        lb={lb} slug={slug || ''} roomId={roomId}
                        style={newConfig.style} theme={newConfig.theme}
                        maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                        showTimer={newConfig.showTimer}
                        cardBgFill={newConfig.cardBgFill}
                        titleFontSize={newConfig.titleFontSize || undefined}
                        qrMode="disabled"
                      />
                    ) : (
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <div className="-mx-4 sm:-mx-6 overflow-x-auto">
                <div className={`flex pb-2 px-4 sm:px-6 ${useNewCards ? '' : 'gap-3 sm:gap-5'}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
                  {visibleLeaderboards.map(lb => (
                    <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}) }}>
                      {useNewCards ? (
                        <CardRouter
                          lb={lb} slug={slug || ''} roomId={roomId}
                          style={newConfig.style} theme={newConfig.theme}
                          maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                          showTimer={newConfig.showTimer}
                          cardBgFill={newConfig.cardBgFill}
                          titleFontSize={newConfig.titleFontSize || undefined}
                          qrMode="disabled"
                        />
                      ) : (
                        <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Rankings: right position */}
          {rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
          )}
        </div>

        {/* Rankings: bottom position */}
        {rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
        )}
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
