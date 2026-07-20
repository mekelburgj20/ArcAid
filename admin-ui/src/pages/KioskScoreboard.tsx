import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import { Flame, TrendingUp, Target, Trophy, Gamepad2, Star, Users } from 'lucide-react';
import {
  GameCard,
  RankingGroupCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
} from '../components/ScoreboardComponents';
import CardRouter from '../components/scoreboard/CardRouter';
import { deriveCardProps, deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';
import { getSocket } from '../lib/websocket';
import { getPortal } from '../lib/portal';

export default function KioskScoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [configLoaded, setConfigLoaded] = useState(false);
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [feedEvents, setFeedEvents] = useState<Array<{ id: number; type: string; title: string; created_at: string }>>([]);
  const [scoreToast, setScoreToast] = useState<{ player: string; score: number; game: string } | null>(null);

  // Resolve room and fetch scoreboard config
  useEffect(() => {
    if (!slug) return;
    getPortal(slug)
      .then(portal => {
        setRoomName(portal.name);
        setRoomId(portal.roomId);
        return fetch(`/api/rooms/${portal.roomId}/scoreboard-config`);
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
    try {
      const res = await fetch(`/api/rooms/${roomId}/lobby/feed?limit=15`);
      if (res.ok) {
        const events = await res.json();
        setFeedEvents(events.filter((e: any) => !e.target_user_id));
      }
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

  // S4: live updates over the room-scoped socket channel. The 60s poll above
  // stays as a backstop. Joins room:<id>, refreshes on leaderboard:updated, and
  // shows a TV-scaled toast on score:new.
  useEffect(() => {
    if (!roomId) return;
    const socket = getSocket();
    socket.emit('join:room', roomId);
    // Re-join on every (re)connect — room membership is per-connection and does
    // not survive a socket reconnect (long-running TV kiosk / idle tab).
    const onConnect = () => socket.emit('join:room', roomId);
    socket.on('connect', onConnect);
    const onScore = (data?: { playerName?: string; score?: number; gameName?: string }) => {
      loadData();
      if (data?.playerName && data?.gameName) {
        setScoreToast({ player: data.playerName, score: data.score ?? 0, game: data.gameName });
        setTimeout(() => setScoreToast(null), 6000);
      }
    };
    const onUpdate = () => { loadData(); };
    socket.on('score:new', onScore);
    socket.on('leaderboard:updated', onUpdate);
    return () => {
      socket.emit('leave:room', roomId);
      socket.off('connect', onConnect);
      socket.off('score:new', onScore);
      socket.off('leaderboard:updated', onUpdate);
    };
  }, [roomId, loadData]);

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
  const isBanner = useNewCards && newConfig.style === 'banner';
  const effectiveLayout = isBanner ? 'scroll' : layout;
  const visibleLeaderboards = (useNewCards ? newConfig.hideEmpty : hideEmpty) ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;
  const inlineRankings = useNewCards && !newConfig.rankingsSticky && rankingGroups.length > 0;
  const hasQrTop = useNewCards && (newConfig.qrMode === 'kiosk-only' || newConfig.qrMode === 'all') && newConfig.qrPosition === 'top-right';
  const rankQrTopPad = hasQrTop ? newConfig.qrSize + 4 : 0;

  // Measure header height so bg image can start below it
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bgBehindTitle = useNewCards ? newConfig.bgBehindTitle : false;
  const effectiveBgSize = bgMode === 'fill-entire' ? 'cover' : bgMode === 'repeat' ? 'auto' : bgMode;

  const TICKER_ICONS: Record<string, typeof Flame> = {
    new_high_score: Flame, rank_change: TrendingUp, score_posted: Target,
    tournament_results: Trophy, tournament_active: Gamepad2,
    player_milestone: Star, friend_score: Users,
  };

  const tickerItems = useMemo(() => feedEvents.map(e => {
    const ago = (() => {
      const s = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 1000);
      if (s < 60) return 'just now';
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${Math.floor(h / 24)}d ago`;
    })();
    return { id: e.id, title: e.title, ago, Icon: TICKER_ICONS[e.type] || Target };
  }), [feedEvents]);

  // Guard: wait for config to load, then check if kiosk is enabled
  if (!configLoaded) {
    return <div className="min-h-screen bg-deep" />;
  }
  // Available unless explicitly disabled — matches the Settings "Kiosk Mode"
  // toggle, which defaults ON (defaultOn: true). Gating on === 'true' treated
  // an absent (never-saved) value as disabled, contradicting that default.
  if (config.KIOSK_ENABLED === 'false') {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <p className="text-muted font-display text-lg">Kiosk mode is not available for this room</p>
      </div>
    );
  }

  return (
    <div className={`min-h-screen bg-deep text-primary relative ${newConfig.mobileVertical ? 'scoreboard-mobile-vertical' : ''}`}>
      {/* S4: live score toast (TV-scaled) */}
      {scoreToast && (
        <div className="fixed top-8 left-1/2 -translate-x-1/2 z-[60] pointer-events-none">
          <div className="bg-surface border-2 border-neon-cyan/50 rounded-2xl shadow-2xl px-10 py-6 text-center">
            <div className="text-2xl font-bold text-neon-cyan tracking-wider uppercase">New Score</div>
            <div className="text-4xl font-extrabold text-primary mt-2">{scoreToast.player}</div>
            <div className="text-2xl text-primary/85 mt-2">
              <span className="text-neon-cyan font-bold">{scoreToast.score.toLocaleString()}</span> — {scoreToast.game}
            </div>
          </div>
        </div>
      )}
      {/* Background image layer — offset below header unless fill-entire */}
      {bgUrl && (
        <div
          className="fixed pointer-events-none"
          style={{
            top: bgBehindTitle ? 0 : headerHeight,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: effectiveBgSize,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center top',
            opacity: bgOpacity,
          }}
        />
      )}
      <div
        className="px-4 sm:px-6 py-6 relative"
        style={{
          ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
          minHeight: '100vh',
          paddingBottom: feedEvents.length > 0 ? 48 : undefined,
        }}
      >
        {/* Title — solid background by default when bg image is set */}
        <div
          ref={headerRef}
          className="relative z-[1]"
        >
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
        </div>

        {/* Rankings: top position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'top' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} />
        )}

        {/* Main content area */}
        <div className={`flex scoreboard-mobile-scale ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row gap-6 items-stretch lg:items-start' : 'flex-col gap-6'}`} style={{ '--mobile-scale': newConfig.mobileScale } as React.CSSProperties}>

          {/* Rankings: left position (only when sticky/separate) */}
          {!inlineRankings && rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-24">
              <p className="text-muted font-display">Waiting for active games...</p>
            </div>
          ) : effectiveLayout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div
                className={`scoreboard-grid-layout grid ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${!useNewCards && gameColumns === '2' ? 'grid-cols-1 md:grid-cols-2' : ''}`}
                style={{
                  ...(useNewCards ? { gap: newConfig.cardSpacing } : {}),
                  ...(useNewCards || gameColumns !== '2' ? { gridTemplateColumns: `repeat(auto-fill, minmax(min(${Math.round(cardWidth * 0.7)}px, 100%), 1fr))` } : {}),
                }}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} style={{ ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}), overflow: 'visible', minWidth: 0 }}>
                    {useNewCards ? (
                      <CardRouter lb={lb} slug={slug || ''} roomId={roomId} style={newConfig.style} theme={newConfig.theme} maxScores={newConfig.maxScores} minScores={newConfig.minScores} showTimer={newConfig.showTimer} cardBgFill={newConfig.cardBgFill} titleFontSize={newConfig.titleFontSize || undefined} qrMode={newConfig.qrMode === 'kiosk-only' || newConfig.qrMode === 'all' ? 'enabled' : 'disabled'} qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition} qrOverlapPx={newConfig.qrOverlapPx} gameTitleStyle={newConfig.gameTitleStyle} />
                    ) : (
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                    )}
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} style={{ overflow: 'visible', minWidth: 0 }}>
                    <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />
                  </div>
                ))}
              </div>
            </div>
          ) : effectiveLayout === 'vertical' ? (
            <div className="flex-1 min-w-0">
              <div className="flex flex-col items-center" style={{ gap: useNewCards ? newConfig.cardSpacing : 20 }}>
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%' }}>
                    {useNewCards ? (
                      <CardRouter lb={lb} slug={slug || ''} roomId={roomId} style={newConfig.style} theme={newConfig.theme} maxScores={newConfig.maxScores} minScores={newConfig.minScores} showTimer={newConfig.showTimer} cardBgFill={newConfig.cardBgFill} titleFontSize={newConfig.titleFontSize || undefined} qrMode={newConfig.qrMode === 'kiosk-only' || newConfig.qrMode === 'all' ? 'enabled' : 'disabled'} qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition} qrOverlapPx={newConfig.qrOverlapPx} gameTitleStyle={newConfig.gameTitleStyle} />
                    ) : (
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                    )}
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%' }}>
                    <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <div className="-mx-4 sm:-mx-6 overflow-x-auto scoreboard-hscroll-layout">
                <div className={`flex pb-2 px-4 sm:px-6 ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${isBanner ? 'scoreboard-banner-scroll' : ''}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
                  {visibleLeaderboards.map(lb => (
                    <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}) }}>
                      {useNewCards ? (
                        <CardRouter lb={lb} slug={slug || ''} roomId={roomId} style={newConfig.style} theme={newConfig.theme} maxScores={newConfig.maxScores} minScores={newConfig.minScores} showTimer={newConfig.showTimer} cardBgFill={newConfig.cardBgFill} titleFontSize={newConfig.titleFontSize || undefined} qrMode={newConfig.qrMode === 'kiosk-only' || newConfig.qrMode === 'all' ? 'enabled' : 'disabled'} qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition} qrOverlapPx={newConfig.qrOverlapPx} gameTitleStyle={newConfig.gameTitleStyle} />
                      ) : (
                        <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} cardOpacity={cardOpacity} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                      )}
                    </div>
                  ))}
                  {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                    <div key={`rank-${group.id}`} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))` }}>
                      <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Rankings: right position (only when sticky/separate) */}
          {!inlineRankings && rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
          )}
        </div>

        {/* Rankings: bottom position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} />
        )}
      </div>

      {/* Lobby feed ticker */}
      {tickerItems.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-deep/90 border-t border-border/30 backdrop-blur-sm overflow-hidden" style={{ height: 36 }}>
          <div className="kiosk-ticker flex items-center gap-10 whitespace-nowrap h-full px-4">
            {/* Double the items for seamless loop */}
            {[...tickerItems, ...tickerItems].map((item, i) => {
              const Icon = item.Icon;
              return (
                <span key={`${item.id}-${i}`} className="inline-flex items-center gap-1.5 text-xs">
                  <Icon size={12} className="text-neon-cyan flex-shrink-0" />
                  <span className="text-primary/80">{item.title}</span>
                  <span className="text-faint ml-1">{item.ago}</span>
                </span>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        .scoreboard-hscroll-layout {
          scrollbar-width: thin;
          scrollbar-color: var(--color-border) transparent;
          overscroll-behavior-x: contain;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar { height: 8px; }
        .scoreboard-hscroll-layout::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
        .scoreboard-hscroll-layout::-webkit-scrollbar-thumb { background: var(--color-border); border-radius: 4px; }
        .scoreboard-hscroll-layout::-webkit-scrollbar-thumb:hover { background: var(--color-muted); }
        @keyframes kiosk-ticker-scroll {
          from { transform: translateX(0); }
          to { transform: translateX(-50%); }
        }
        .kiosk-ticker {
          animation: kiosk-ticker-scroll 60s linear infinite;
        }
        @media (max-width: 640px) {
          .scoreboard-mobile-scale { zoom: var(--mobile-scale, 0.6); }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout { overflow-x: hidden !important; }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div { flex-direction: column !important; align-items: center !important; }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div > div { flex-shrink: 1 !important; max-width: 100% !important; }
          .scoreboard-mobile-vertical .scoreboard-grid-layout { grid-template-columns: 1fr !important; justify-items: center; }
          .scoreboard-mobile-vertical .scoreboard-grid-layout > div { max-width: 100%; }
        }
      `}</style>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
