import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import type { GameLeaderboard, RankingGroupData, GlobalCardStyles } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
  cardWidthMap,
} from '../components/ScoreboardComponents';

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

  // Config-driven values
  const maxScores = parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5;
  const hideEmpty = config.SCOREBOARD_HIDE_EMPTY === 'true';
  const titleHidden = config.SCOREBOARD_TITLE_HIDDEN === 'true';
  const titleText = config.SCOREBOARD_TITLE || roomName || 'High Scores';
  const titleStyle = config.SCOREBOARD_TITLE_STYLE || 'default';
  const titleSize = config.SCOREBOARD_TITLE_SIZE || 'sm';
  const zoom = parseInt(config.SCOREBOARD_ZOOM || '100', 10) || 100;
  const bgUrl = config.SCOREBOARD_BG_URL || '';
  const bgMode = config.SCOREBOARD_BG_MODE || 'cover';
  const logoUrl = config.LOGO_URL || '';
  const logoPosition = config.LOGO_POSITION || 'left';
  const logoMaxHeight = parseInt(config.LOGO_MAX_HEIGHT || '64', 10) || 64;
  const layout = config.SCOREBOARD_LAYOUT || 'scroll';
  const cardSize = config.SCOREBOARD_CARD_SIZE || 'medium';
  const rankingsPosition = config.SCOREBOARD_RANKINGS_POSITION || 'left';
  const cardOpacity = config.SCOREBOARD_CARD_OPACITY ? parseFloat(config.SCOREBOARD_CARD_OPACITY) : undefined;
  const bgOpacity = config.SCOREBOARD_BG_OPACITY ? parseFloat(config.SCOREBOARD_BG_OPACITY) : 1;
  const headerStyle = config.SCOREBOARD_CARD_HEADER_STYLE || 'banner';
  const wheelScale = parseInt(config.SCOREBOARD_WHEEL_SCALE || '150', 10) || 150;
  const gameColumns = config.SCOREBOARD_GAME_COLUMNS || 'auto';

  const globalStyles: GlobalCardStyles | undefined = config.GLOBAL_CARD_STYLES_ENABLED === 'true' ? {
    enabled: true,
    cssTitle: config.GLOBAL_CARD_CSS_TITLE || undefined,
    cssScores: config.GLOBAL_CARD_CSS_SCORES || undefined,
    cssBox: config.GLOBAL_CARD_CSS_BOX || undefined,
    bgColor: config.GLOBAL_CARD_BG_COLOR || undefined,
  } : undefined;

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;
  const cardWidth = cardWidthMap[cardSize] || 288;

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
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} />
        )}

        {/* Main content area */}
        <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-stretch lg:items-start`}>

          {/* Rankings: left position */}
          {rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-24">
              <p className="text-muted font-display">Waiting for active games...</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div
                className={`grid gap-3 sm:gap-5 ${gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
                style={gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${cardWidth}px, 100%), 1fr))` } : undefined}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex flex-col" style={headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : undefined}>
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <div className="-mx-4 sm:-mx-6 overflow-x-auto">
                <div className="flex gap-3 sm:gap-5 pb-2 px-4 sm:px-6">
                  {visibleLeaderboards.map(lb => (
                    <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, ...(headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}) }}>
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Rankings: right position */}
          {rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} />
          )}
        </div>

        {/* Rankings: bottom position */}
        {rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} />
        )}
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
