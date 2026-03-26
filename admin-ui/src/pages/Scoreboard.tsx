import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getSocket } from '../lib/websocket';
import { useViewerHeaders } from '../contexts/ViewerAuthContext';
import type { GameLeaderboard, RankingGroupData } from '../components/ScoreboardComponents';
import {
  GameCard,
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
  cardWidthMap,
} from '../components/ScoreboardComponents';
import ScoreSubmitModal from '../components/ScoreSubmitModal';


export default function Scoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [flash, setFlash] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [roomName, setRoomName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [selectedGame, setSelectedGame] = useState<GameLeaderboard | null>(null);
  const viewerHeaders = useViewerHeaders();

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
    socket.on('score:new', () => {
      setFlash(true);
      loadData();
      loadRankings();
      setTimeout(() => setFlash(false), 1500);
    });
    socket.on('leaderboard:updated', () => { loadData(); loadRankings(); });
    socket.on('game:rotated', loadData);

    return () => {
      socket.off('score:new');
      socket.off('leaderboard:updated');
      socket.off('game:rotated');
    };
  }, [roomId]);

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
  const requirePhoto = config.REQUIRE_SCORE_PHOTO === 'true';
  const cardOpacity = config.SCOREBOARD_CARD_OPACITY ? parseFloat(config.SCOREBOARD_CARD_OPACITY) : undefined;

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;
  const cardWidth = cardWidthMap[cardSize] || 288;

  return (
    <div
      className="px-4 sm:px-6 py-6 overflow-hidden"
      style={{
        ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
        ...(bgUrl ? {
          backgroundImage: `url(${bgUrl})`,
          backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
          backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
          backgroundPosition: 'center',
          minHeight: '100vh',
        } : {}),
      }}
    >
      {/* Score flash overlay */}
      {flash && (
        <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
      )}

      {/* Header */}
      {!titleHidden && (
        <div className="text-center mb-8">
          <div className={`inline-flex items-center gap-4 ${
            logoPosition === 'above' || logoPosition === 'below' ? 'flex-col' : 'flex-row'
          }`}>
            {logoUrl && (logoPosition === 'left' || logoPosition === 'above') && (
              <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
            )}
            <p className={`font-display text-muted ${getTitleSizeClass(titleSize)} uppercase tracking-widest ${getTitleStyleClass(titleStyle)}`}>
              {titleText}
            </p>
            {logoUrl && (logoPosition === 'right' || logoPosition === 'below') && (
              <img src={logoUrl} alt="" style={{ maxHeight: `${logoMaxHeight}px` }} className="object-contain" />
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
      <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-start`}>

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
              className="grid gap-3 sm:gap-5"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${cardWidth}px, 100%), 1fr))` }}
            >
              {visibleLeaderboards.map(lb => (
                <div key={lb.gameId}>
                  <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-w-0">
            <div className="-mx-4 sm:-mx-6 overflow-x-auto">
              <div className="flex gap-3 sm:gap-5 pb-2 px-4 sm:px-6">
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, calc(100vw - 2rem))` }}>
                    <GameCard lb={lb} slug={slug || ''} maxScores={maxScores} roomId={roomId} onSubmitScore={(lb) => setSelectedGame(lb)} cardOpacity={cardOpacity} />
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

      {/* Score submission modal */}
      {selectedGame && roomId && (
        <ScoreSubmitModal
          gameName={selectedGame.gameName}
          roomId={roomId}
          requirePhoto={requirePhoto}
          onClose={() => setSelectedGame(null)}
          onSubmitted={() => { loadData(); loadRankings(); }}
        />
      )}
    </div>
  );
}
