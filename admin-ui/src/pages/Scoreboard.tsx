import { useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Search, Plus } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useViewerAuth, useViewerHeaders } from '../contexts/ViewerAuthContext';
import { useTheme } from '../components/ThemeProvider';
import type { ThemeId } from '../components/ThemeProvider';
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
import GamesTabView from '../components/GamesTabView';
import SubmissionSheet from '../components/SubmissionSheet';
import ScoreboardPreferencesModal from '../components/ScoreboardPreferencesModal';
import { deriveCardProps } from '../lib/scoreboardConfig';
import { deriveScoreboardConfig, getCardWidth, qrBottomMetrics } from '../lib/scoreboardConfig';


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
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [roomConfig, setRoomConfig] = useState<Record<string, string>>({});
  const [tournamentSearch, setTournamentSearch] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get('tab');
    // Legacy: `games` → `all-games`
    if (t === 'all-games' || t === 'games') return 'all-games';
    return 'tournaments';
  })();
  const [tab, setTab] = useState<'tournaments' | 'all-games'>(initialTab);

  const selectTab = (next: 'tournaments' | 'all-games') => {
    setTab(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'all-games') params.set('tab', 'all-games');
    else params.delete('tab');
    setSearchParams(params, { replace: true });
  };
  const viewerHeaders = useViewerHeaders();
  const { discordUser, playerToken } = useViewerAuth();
  const { setPublicTheme } = useTheme();

  const deviceType = window.innerWidth <= 640 ? 'mobile' : 'desktop';

  /** Fetch user prefs for current device, merge with room config, apply theme */
  const applyUserPrefs = async (cfg: Record<string, string>, token: string) => {
    try {
      const prefsRes = await fetch(`/api/me/scoreboard-preferences?device=${deviceType}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (prefsRes.ok) {
        const prefs = await prefsRes.json();
        if (prefs.UI_THEME) {
          setPublicTheme(prefs.UI_THEME as ThemeId);
        }
        setConfig({ ...cfg, ...prefs });
        return true;
      }
    } catch { /* fall through */ }
    return false;
  };

  // Resolve room and fetch scoreboard config (merged with user prefs if logged in)
  useEffect(() => {
    if (!slug) return;
    (async () => {
      try {
        const portalRes = await fetch(`/api/portal?slug=${encodeURIComponent(slug)}`);
        if (!portalRes.ok) return;
        const portal: { id: string; name: string } = await portalRes.json();
        setRoomName(portal.name);
        setRoomId(portal.id);
        const cfgRes = await fetch(`/api/rooms/${portal.id}/scoreboard-config`, { headers: viewerHeaders });
        const cfg = cfgRes.ok ? await cfgRes.json() : {};
        setRoomConfig(cfg || {});
        if (playerToken) {
          if (await applyUserPrefs(cfg || {}, playerToken)) return;
        }
        setConfig(cfg || {});
      } catch { /* ignore */ }
    })();
  }, [slug, playerToken]);

  // Listen for prefs-open event from PublicLayout nav gear button
  useEffect(() => {
    const handler = () => setPrefsOpen(true);
    window.addEventListener('open-scoreboard-prefs', handler);
    return () => window.removeEventListener('open-scoreboard-prefs', handler);
  }, []);

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

  const trimmedTournamentSearch = tournamentSearch.trim().toLowerCase();
  const visibleLeaderboards = leaderboards
    .filter(lb => !hideEmpty || lb.rankings.length > 0)
    .filter(lb => !trimmedTournamentSearch || (lb.displayName || lb.gameName).toLowerCase().includes(trimmedTournamentSearch));

  // When sticky is off (default), rankings render inline with game cards
  const inlineRankings = useNewCards && !newConfig.rankingsSticky && rankingGroups.length > 0;
  // QR codes above game cards add extra height — rankings card needs matching top margin
  const hasQrTop = useNewCards && (newConfig.qrMode === 'all') && newConfig.qrPosition === 'top-right';
  const rankQrTopPad = hasQrTop ? newConfig.qrSize + 4 : 0;
  // v2.13.3: bottom-center QR overhangs below the card. The reservation must
  // live on the LAYOUT ITEM (flex/grid wrapper), not the card's inner div —
  // marginBottom on a height:100% child escapes its parent's border-box, so
  // the QR's overhang area was rendered outside the scrollable region and
  // unreachable even at max scroll. Moving the margin up one level makes flex
  // line cross-size and grid track sizing include the QR space.
  const cardMarginBottom = useNewCards
    ? qrBottomMetrics(newConfig.qrSize, newConfig.qrMode !== 'disabled', newConfig.qrPosition).overhang
    : 0;

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

  // Plan §10 / Sprint 3: Tournament-tab cards now link to game detail like All Games.
  const linkForTournamentCard = (lb: GameLeaderboard) =>
    lb.globalGameId
      ? `/games/${lb.globalGameId}?from=${encodeURIComponent(slug || '')}`
      : `/${slug || ''}/games/${encodeURIComponent(lb.gameName)}`;

  return (
    <div className={`h-full flex flex-col overflow-hidden relative ${newConfig.mobileVertical ? 'scoreboard-mobile-vertical' : ''}`}>
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
        /* Scrollbar styling for horizontal scroll layout */
        .scoreboard-hscroll-layout {
          scrollbar-width: thin;
          scrollbar-color: var(--color-border) transparent;
          overscroll-behavior-x: contain;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar {
          height: 8px;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar-track {
          background: rgba(255,255,255,0.05);
          border-radius: 4px;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar-thumb {
          background: var(--color-border);
          border-radius: 4px;
        }
        .scoreboard-hscroll-layout::-webkit-scrollbar-thumb:hover {
          background: var(--color-muted);
        }
        /* Mobile: scale + vertical mode */
        @media (max-width: 640px) {
          .scoreboard-mobile-scale { zoom: var(--mobile-scale, 0.6); }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout {
            overflow-x: hidden !important;
          }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div {
            flex-direction: column !important;
            align-items: center !important;
          }
          .scoreboard-mobile-vertical .scoreboard-hscroll-layout > div > div {
            flex-shrink: 1 !important;
            max-width: 100% !important;
          }
          .scoreboard-mobile-vertical .scoreboard-grid-layout {
            grid-template-columns: 1fr !important;
            justify-items: center;
          }
          .scoreboard-mobile-vertical .scoreboard-grid-layout > div {
            max-width: 100%;
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
        <div className="text-center mb-4 overflow-hidden">
          <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain mx-auto max-w-full" />
        </div>
      )}

      {/* Tab toggle */}
      <div className="flex justify-center gap-1 pb-3" role="tablist" aria-label="Scoreboard tabs">
        <button
          role="tab"
          aria-selected={tab === 'tournaments'}
          onClick={() => selectTab('tournaments')}
          className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer ${
            tab === 'tournaments'
              ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
              : 'border-border/50 text-muted hover:text-primary'
          }`}
        >
          Tournaments
        </button>
        <button
          role="tab"
          aria-selected={tab === 'all-games'}
          onClick={() => selectTab('all-games')}
          className={`px-3 py-1 text-xs rounded-lg border transition-colors cursor-pointer ${
            tab === 'all-games'
              ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
              : 'border-border/50 text-muted hover:text-primary'
          }`}
        >
          All Games
        </button>
      </div>

      </div>

      {tab === 'all-games' ? (
        <GamesTabView roomId={roomId} slug={slug || ''} config={config} roomName={roomName} viewerUsername={viewerUsername} />
      ) : (
      <>
      {/* Tournament search (reserved slot matches All Games tab for layout stability) */}
      <div className="px-4 sm:px-6">
        <div className="max-w-md mx-auto mb-4">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search active games..."
              value={tournamentSearch}
              onChange={e => setTournamentSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 rounded-lg border border-border/50 bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan/40 text-sm"
              aria-label="Search active games"
            />
          </div>
        </div>
      </div>

      {/* Game cards */}
      <div className="px-4 sm:px-6 pb-6 scoreboard-mobile-scale" style={{ '--mobile-scale': newConfig.mobileScale } as React.CSSProperties}>

      {/* Rankings: top position (only when sticky/separate) */}
      {!inlineRankings && rankingsPosition === 'top' && rankingGroups.length > 0 && (
        <RankingsRow rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} />
      )}

      {/* Main content area */}
      <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row gap-6 items-stretch lg:items-start' : 'flex-col gap-6'}`}>

        {/* Rankings: left position (only when sticky/separate) */}
        {!inlineRankings && rankingsPosition === 'left' && rankingGroups.length > 0 && (
          <RankingsColumn rankingGroups={rankingGroups} cardOpacity={cardOpacity} scoreboardStyle={useNewCards ? newConfig.style : undefined} showcaseThemeName={useNewCards ? newConfig.theme : undefined} rankingsStyle={useNewCards ? newConfig.rankingsStyle : undefined} sticky={useNewCards && newConfig.rankingsSticky} />
        )}

        {/* Game leaderboards */}
        {visibleLeaderboards.length === 0 ? (
          <div className="flex-1 text-center py-24">
            <p className="text-muted font-display">
              {trimmedTournamentSearch
                ? `No active games match "${tournamentSearch.trim()}".`
                : 'Waiting for active games...'}
            </p>
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
                <div key={lb.gameId} className="relative group/card" style={{ ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}), overflow: 'visible', minWidth: 0, marginBottom: cardMarginBottom || undefined }}>
                  {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                  <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedGame(lb); }} aria-label={`Submit score for ${lb.displayName || lb.gameName}`} title="Submit score" className="absolute top-0 right-0 z-20 w-11 h-11 inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-full group/submit focus:outline-none">
                    <span className="w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan group-hover/submit:bg-neon-cyan/20 group-focus/submit:bg-neon-cyan/20 flex items-center justify-center transition-colors backdrop-blur-sm">
                      <Plus size={16} />
                    </span>
                  </button>
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
                      titleLinkTo={linkForTournamentCard(lb)}
                    />
                  ) : (
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                  )}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} style={{ overflow: 'visible', minWidth: 0, marginBottom: cardMarginBottom || undefined }}>
                  <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />
                </div>
              ))}
            </div>
          </div>
        ) : effectiveLayout === 'vertical' ? (
          /* Vertical scroll — single column centered */
          <div className="flex-1 min-w-0">
            <div className="flex flex-col items-center" style={{ gap: useNewCards ? newConfig.cardSpacing : 20 }}>
              {visibleLeaderboards.map(lb => (
                <div key={lb.gameId} className="relative group/card" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%', marginBottom: cardMarginBottom || undefined }}>
                  {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                  <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedGame(lb); }} aria-label={`Submit score for ${lb.displayName || lb.gameName}`} title="Submit score" className="absolute top-0 right-0 z-20 w-11 h-11 inline-flex items-center justify-center bg-transparent border-0 cursor-pointer rounded-full group/submit focus:outline-none">
                    <span className="w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan group-hover/submit:bg-neon-cyan/20 group-focus/submit:bg-neon-cyan/20 flex items-center justify-center transition-colors backdrop-blur-sm">
                      <Plus size={16} />
                    </span>
                  </button>
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
                      titleLinkTo={linkForTournamentCard(lb)}
                    />
                  ) : (
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                  )}
                </div>
              ))}
              {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                <div key={`rank-${group.id}`} style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, maxWidth: '100%', marginBottom: cardMarginBottom || undefined }}>
                  <RankingGroupCard group={group} rankings={rankings} cardOpacity={cardOpacity} scoreboardStyle={newConfig.style} showcaseThemeName={newConfig.theme} rankingsStyle={newConfig.rankingsStyle} qrTopPad={rankQrTopPad} />
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
                  <div key={lb.gameId} className="flex-shrink-0 relative group/card" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, ...(!useNewCards && headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : {}), marginBottom: cardMarginBottom || undefined }}>
                    {/* v2.2.8: overlay Link removed — title is a Link inside CardRouter instead. */}
                    <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSelectedGame(lb); }} aria-label={`Submit score for ${lb.displayName || lb.gameName}`} title="Submit score" className="absolute top-2 right-2 z-20 w-9 h-9 rounded-full bg-surface/90 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/20 focus:bg-neon-cyan/20 flex items-center justify-center transition-colors cursor-pointer backdrop-blur-sm">
                      <Plus size={16} />
                    </button>
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
                        titleLinkTo={linkForTournamentCard(lb)}
                      />
                    ) : (
                      <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} glassOpacity={glassOpacity} gameTitleStyle={gameTitleStyle} gameTitleEnhance={gameTitleEnhance} scoreStyle={scoreStyle} />
                    )}
                  </div>
                ))}
                {inlineRankings && rankingGroups.map(({ group, rankings }) => (
                  <div key={`rank-${group.id}`} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))`, marginBottom: cardMarginBottom || undefined }}>
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

      </div>{/* end game cards */}
      </>
      )}
      </div>{/* end scrollable */}

      {/* Score submission — SubmissionSheet (Sprint 10) handles anonymous flow.
          v2.0.1 — requireLogin short-circuits the form when the room gates submissions. */}
      {selectedGame && roomId && (
        <SubmissionSheet
          target={{ kind: 'tournament', roomId, gameName: selectedGame.gameName, gameStatus: selectedGame.gameStatus, requirePhoto }}
          roomSlug={slug}
          requireLogin={config.REQUIRE_DISCORD_LOGIN === 'true'}
          onClose={() => setSelectedGame(null)}
          onSubmitted={() => { loadData(); loadRankings(); setSelectedGame(null); }}
        />
      )}

      {/* Player display preferences modal */}
      {playerToken && (
        <ScoreboardPreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          playerToken={playerToken}
          roomConfig={roomConfig}
          onSaved={() => {
            // Re-fetch config with updated prefs
            if (!roomId) return;
            (async () => {
              const cfgRes = await fetch(`/api/rooms/${roomId}/scoreboard-config`, { headers: viewerHeaders });
              const cfg = cfgRes.ok ? await cfgRes.json() : {};
              setRoomConfig(cfg || {});
              if (!(await applyUserPrefs(cfg || {}, playerToken))) {
                setConfig(cfg || {});
              }
            })();
          }}
        />
      )}
    </div>
  );
}
