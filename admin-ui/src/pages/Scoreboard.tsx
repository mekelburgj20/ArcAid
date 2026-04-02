import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getSocket } from '../lib/websocket';
import { useViewerAuth, useViewerHeaders } from '../contexts/ViewerAuthContext';
import type { GameLeaderboard, RankingGroupData, RankedEntry } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
} from '../components/ScoreboardComponents';
import ScoreSubmitModal from '../components/ScoreSubmitModal';
import { deriveCardProps } from '../lib/scoreboardConfig';


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

  // Config-driven values (shared derivation)
  const {
    maxScores, hideEmpty, titleHidden, titleText, titleStyle, titleSize,
    zoom, bgUrl, bgMode, logoUrl, logoPosition, logoMaxHeight,
    layout, cardWidth, rankingsPosition, requirePhoto,
    cardOpacity, bgOpacity, scoreColumns, qrMode,
    headerStyle, bgFill, bgSize, wheelScale, gameColumns, globalStyles,
  } = deriveCardProps(config, roomName);
  const viewerUsername = discordUser?.username || undefined;

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;

  return (
    <div
      className="h-full flex flex-col overflow-hidden relative"
      style={zoom !== 100 ? { zoom: `${zoom}%` } : undefined}
    >
      {/* Background image layer with opacity control */}
      {bgUrl && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
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
      `}</style>

      {/* Header — non-scrolling */}
      <div className="flex-shrink-0 px-4 sm:px-6 pt-6">
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

      {/* Scrollable content area */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 sm:px-6 pb-6">

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
                <div key={lb.gameId} className="grid" style={headerStyle === 'wheel' ? { paddingTop: '2.5rem' } : undefined}>
                  <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} />
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
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} scoreColumns={scoreColumns} viewerUsername={viewerUsername} viewerEntry={lb.viewerEntry} qrMode={qrMode === 'all' ? 'all' : 'disabled'} headerStyle={headerStyle} globalStyles={globalStyles} wheelScale={wheelScale} bgFill={bgFill} bgSize={bgSize} cardWidth={cardWidth} />
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
