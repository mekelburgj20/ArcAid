import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getSocket } from '../lib/websocket';
import { useViewerAuth, useViewerHeaders } from '../contexts/ViewerAuthContext';
import type { GameLeaderboard, RankingGroupData, RankedEntry } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingGroupCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
} from '../components/ScoreboardComponents';
import CardRouter from '../components/scoreboard/CardRouter';
import ScoreSubmitModal from '../components/ScoreSubmitModal';
import { deriveCardProps } from '../lib/scoreboardConfig';
import { deriveScoreboardConfig, getCardWidth } from '../lib/scoreboardConfig';


interface LeaderboardWithViewer extends GameLeaderboard {
  viewerEntry?: RankedEntry | null;
}

export default function Scoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<LeaderboardWithViewer[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [flash, setFlash] = useState(false);
  const [scoreToast, setScoreToast] = useState<{ player: string; score: number; game: string } | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [selectedGame, setSelectedGame] = useState<GameLeaderboard | null>(null);
  const viewerHeaders = useViewerHeaders();
  const { discordUser } = useViewerAuth();

  // Resolve room and fetch scoreboard config
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((portal: { id: string; name: string }) => {
        setRoomName(portal.name);
        setRoomId(portal.id);
        return fetch(`/api/rooms/${portal.id}/scoreboard-config`, { headers: viewerHeaders });
      })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => setConfig(cfg || {}))
      .catch(() => {});
  }, [slug]);

  const loadData = async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/leaderboard`, { headers: viewerHeaders });
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
  };

  const loadRankings = async () => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/rankings`, { headers: viewerHeaders });
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!roomId) return;
    loadData();
    loadRankings();

    const socket = getSocket();
    socket.on('score:new', (data?: { playerName?: string; score?: number; gameName?: string }) => {
      setFlash(true);
      loadData();
      loadRankings();
      setTimeout(() => setFlash(false), 1500);
      if (data?.playerName && data?.gameName) {
        setScoreToast({ player: data.playerName, score: data.score ?? 0, game: data.gameName });
        setTimeout(() => setScoreToast(null), 5000);
      }
    });
    socket.on('leaderboard:updated', () => { loadData(); loadRankings(); });
    socket.on('game:rotated', loadData);

    return () => {
      socket.off('score:new');
      socket.off('leaderboard:updated');
      socket.off('game:rotated');
    };
  }, [roomId]);

  // New style/theme config
  const newConfig = deriveScoreboardConfig(config, roomName);
  const useNewCards = !!config.SCOREBOARD_STYLE; // explicit style = new system

  // Legacy config (used when SCOREBOARD_STYLE not set)
  const legacyProps = deriveCardProps(config, roomName);
  const {
    maxScores, hideEmpty, titleHidden, titleText, titleStyle, titleSize,
    zoom, bgUrl, bgMode, logoUrl, logoPosition, logoMaxHeight,
    layout: legacyLayout, cardWidth: legacyCardWidth, rankingsPosition, requirePhoto,
    cardOpacity, bgOpacity, scoreColumns, qrMode,
    headerStyle, bgFill, bgSize, wheelScale, gameColumns, globalStyles,
    glassOpacity, gameTitleStyle, gameTitleEnhance, scoreStyle,
  } = legacyProps;
  const layout = useNewCards ? newConfig.layout : legacyLayout;

  const cardWidth = useNewCards ? getCardWidth(newConfig.style) : legacyCardWidth;
  const viewerUsername = discordUser?.username || undefined;
  const isBanner = useNewCards && newConfig.style === 'banner';

  // Effective layout: Banner always horizontal scroll; others respect setting
  // Mobile always forces vertical via CSS
  const effectiveLayout = isBanner ? 'scroll' : layout;

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;

  // When sticky is off (default), rankings render inline with game cards
  const inlineRankings = useNewCards && !newConfig.rankingsSticky && rankingGroups.length > 0;
  // QR codes above game cards add extra height — rankings card needs matching top margin
  const hasQrTop = useNewCards && (newConfig.qrMode === 'all') && newConfig.qrPosition === 'top-right';
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

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      {/* Background image layer with opacity control — offset below header unless fill-entire */}
      {bgUrl && (
        <div
          className="absolute pointer-events-none"
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

      {/* Score flash overlay */}
      {flash && (
        <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
      )}

      {/* Score toast notification */}
      {scoreToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 animate-slideDown">
          <div className="bg-surface border border-neon-cyan/40 rounded-lg shadow-lg px-6 py-3 text-sm text-primary">
            <span className="text-neon-cyan font-bold">{scoreToast.player}</span>
            {' '}posted{' '}
            <span className="text-neon-cyan font-bold">{scoreToast.score.toLocaleString()}</span>
            {' '}on{' '}
            <span className="text-neon-cyan font-bold">{scoreToast.game}</span>!
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideDown {
          from { opacity: 0; transform: translate(-50%, -100%); }
          to { opacity: 1; transform: translate(-50%, 0); }
        }
        .animate-slideDown {
          animation: slideDown 0.3s ease-out forwards;
        }
        /* Mobile: Banner scales down, horizontal scroll converts to vertical */
        @media (max-width: 640px) {
          .scoreboard-banner-scroll { zoom: 0.6; }
          .scoreboard-hscroll-layout {
            overflow-x: hidden !important;
          }
          .scoreboard-hscroll-layout > div {
            flex-direction: column !important;
            align-items: center !important;
          }
          .scoreboard-hscroll-layout > div > div {
            flex-shrink: 1 !important;
            width: 100% !important;
            max-width: 100% !important;
          }
          .scoreboard-grid-layout {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      {/* Scrollable content — zoom applied here so it doesn't break the flex height chain */}
      <div
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
        style={zoom !== 100 ? { zoom: `${zoom}%` } : undefined}
      >
      {/* Header zone — bg image starts below this unless fill-entire mode */}
      <div
        ref={headerRef}
        className="px-4 sm:px-6 pt-6 relative z-[1]"
      >
      {!titleHidden && (
        <div className="text-center mb-4 overflow-hidden">
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
        <div className="text-center mb-4">
          <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto" />
        </div>
      )}

      </div>

      {/* Game cards */}
      <div className="px-4 sm:px-6 pb-6">

      {/* Rankings: top position (only when sticky/separate) */}
      {!inlineRankings && rankingsPosition === 'top' && rankingGroups.length > 0 && (
        <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
      )}

      {/* Main content area */}
      <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row gap-6 items-stretch lg:items-start' : 'flex-col gap-6'}`}>

        {/* Rankings: left position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'left' && rankingGroups.length > 0 && (
          <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
        )}

        {/* Game leaderboards */}
        {visibleLeaderboards.length === 0 ? (
          <div className="flex-1 text-center py-24">
            <p className="text-muted font-display">Waiting for active games...</p>
          </div>
        ) : effectiveLayout === 'grid' ? (
          /* Grid layout — responsive rows, mobile forces single column via CSS */
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
                    <CardRouter
                      lb={lb} slug={slug || ''} roomId={roomId}
                      style={newConfig.style} theme={newConfig.theme}
                      maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                      showTimer={newConfig.showTimer}
                      cardBgFill={newConfig.cardBgFill}
                      titleFontSize={newConfig.titleFontSize || undefined}
                      viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry}
                      qrMode={newConfig.qrMode === 'all' ? 'all' : 'disabled'}
                      qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition}
                      gameTitleStyle={newConfig.gameTitleStyle}
                      onSubmitScore={(lb) => setSelectedGame(lb)}
                    />
                  ) : (
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                  )}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} style={{ overflow: 'visible', minWidth: 0 }}>
                  <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} qrTopPad={rankQrTopPad} />
                </div>
              ))}
            </div>
          </div>
        ) : effectiveLayout === 'vertical' ? (
          /* Vertical scroll — single column centered */
          <div className="flex-1 min-w-0">
            <div className="flex flex-col items-center" style={{ gap: useNewCards ? newConfig.cardSpacing : 20 }}>
              {visibleLeaderboards.map(lb => (
                <div key={lb.gameId} style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%' }}>
                  {useNewCards ? (
                    <CardRouter
                      lb={lb} slug={slug || ''} roomId={roomId}
                      style={newConfig.style} theme={newConfig.theme}
                      maxScores={newConfig.maxScores} minScores={newConfig.minScores}
                      showTimer={newConfig.showTimer}
                      cardBgFill={newConfig.cardBgFill}
                      titleFontSize={newConfig.titleFontSize || undefined}
                      viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry}
                      qrMode={newConfig.qrMode === 'all' ? 'all' : 'disabled'}
                      qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition}
                      gameTitleStyle={newConfig.gameTitleStyle}
                      onSubmitScore={(lb) => setSelectedGame(lb)}
                    />
                  ) : (
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                  )}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%' }}>
                  <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} qrTopPad={rankQrTopPad} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* Horizontal scroll (default for Banner, also available for others) */
          <div className="flex-1 min-w-0">
            <div className="-mx-4 sm:-mx-6 overflow-x-auto scoreboard-hscroll-layout">
              <div className={`flex pb-2 px-4 sm:px-6 ${useNewCards ? '' : 'gap-3 sm:gap-5'} ${isBanner ? 'scoreboard-banner-scroll' : ''}`} style={useNewCards ? { gap: newConfig.cardSpacing } : undefined}>
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
                        viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry}
                        qrMode={newConfig.qrMode === 'all' ? 'all' : 'disabled'}
                        qrSize={newConfig.qrSize} qrPosition={newConfig.qrPosition}
                        gameTitleStyle={newConfig.gameTitleStyle}
                        onSubmitScore={(lb) => setSelectedGame(lb)}
                      />
                    ) : (
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                    )}
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))` }}>
                    <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} qrTopPad={rankQrTopPad} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Rankings: right position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'right' && rankingGroups.length > 0 && (
          <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
        )}
      </div>

      {/* Rankings: bottom position (only when sticky/separate) */}
      {!inlineRankings && rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
        <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} />
      )}

      </div>{/* end game cards */}
      </div>{/* end scrollable */}

      {/* Score submission modal */}
      {selectedGame && roomId && (
        <ScoreSubmitModal
          gameName={selectedGame.gameName}
          roomId={roomId}
          gameStatus={selectedGame.gameStatus}
          requirePhoto={requirePhoto}
          onClose={() => setSelectedGame(null)}
          onSubmitted={() => { loadData(); loadRankings(); }}
        />
      )}
    </div>
  );
}
