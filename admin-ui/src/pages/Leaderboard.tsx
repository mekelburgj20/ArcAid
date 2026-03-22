import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { getSocket } from '../lib/websocket';
import TournamentBadge from '../components/TournamentBadge';
import LoadingState from '../components/LoadingState';
import StylePicker from '../components/StylePicker';
import NeonButton from '../components/NeonButton';
import {
  RankingsColumn,
  RankingsRow,
  getTitleStyleClass,
  getTitleSizeClass,
  getTournamentBorderColor,
  cardWidthMap,
} from '../components/ScoreboardComponents';
import type { RankingGroupData } from '../components/ScoreboardComponents';

interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
}

interface Submission {
  iscored_username: string;
  score: number;
  timestamp: string;
  photo_url: string | null;
}

interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  tournamentType: string;
  gameStatus: string;
  catalogueStyleId: string | null;
  styleHeaderDisabled: boolean;
  rankings: RankedEntry[];
}

export default function Leaderboard() {
  const room = useRoom();
  const { toast } = useToast();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [styleTarget, setStyleTarget] = useState<GameLeaderboard | null>(null);
  const [libraryHasDefault, setLibraryHasDefault] = useState(false);

  const loadData = () => {
    api.get<GameLeaderboard[]>(`/rooms/${room.roomId}/leaderboard`)
      .then(setLeaderboards)
      .catch(() => setLeaderboards([]));
  };

  const loadRankings = () => {
    api.get<RankingGroupData[]>(`/rooms/${room.roomId}/rankings`)
      .then(setRankingGroups)
      .catch(() => setRankingGroups([]))
      .finally(() => setLoading(false));
  };

  const loadConfig = () => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/scoreboard-config`)
      .then(setConfig)
      .catch(() => {});
  };

  useEffect(() => {
    loadData();
    loadRankings();
    loadConfig();

    const socket = getSocket();
    socket.on('leaderboard:updated', () => { loadData(); loadRankings(); });
    socket.on('score:new', () => { loadData(); loadRankings(); });

    return () => {
      socket.off('leaderboard:updated');
      socket.off('score:new');
    };
  }, []);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  // Config-driven values (matching public scoreboard)
  const maxScores = parseInt(config.SCOREBOARD_MAX_SCORES || '5', 10) || 5;
  const hideEmpty = config.SCOREBOARD_HIDE_EMPTY === 'true';
  const titleHidden = config.SCOREBOARD_TITLE_HIDDEN === 'true';
  const titleText = config.SCOREBOARD_TITLE || room.roomName || 'High Scores';
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

  const visibleLeaderboards = hideEmpty ? leaderboards.filter(lb => lb.rankings.length > 0) : leaderboards;
  const cardWidth = cardWidthMap[cardSize] || 288;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Leaderboards</h1>

      {/* Scoreboard Preview — matches public layout */}
      <div
        className="rounded-lg overflow-hidden border border-border/50 px-4 sm:px-6 py-6"
        style={{
          ...(zoom !== 100 ? { zoom: `${zoom}%` } : {}),
          ...(bgUrl ? {
            backgroundImage: `url(${bgUrl})`,
            backgroundSize: bgMode === 'repeat' ? 'auto' : bgMode,
            backgroundRepeat: bgMode === 'repeat' ? 'repeat' : 'no-repeat',
            backgroundPosition: 'center',
          } : {}),
        }}
      >
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
          <RankingsRow rankingGroups={rankingGroups} />
        )}

        {/* Main content area */}
        <div className={`flex ${rankingsPosition === 'left' || rankingsPosition === 'right' ? 'flex-col lg:flex-row' : 'flex-col'} gap-6 items-start`}>

          {/* Rankings: left position */}
          {rankingsPosition === 'left' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}

          {/* Game leaderboards */}
          {visibleLeaderboards.length === 0 && rankingGroups.length === 0 ? (
            <div className="flex-1 text-center py-16">
              <p className="text-muted font-display">No active games with scores yet.</p>
            </div>
          ) : visibleLeaderboards.length === 0 ? (
            <div className="flex-1 text-center py-16">
              <p className="text-muted font-display">No active games with scores yet.</p>
            </div>
          ) : layout === 'grid' ? (
            <div className="flex-1 min-w-0">
              <div
                className="grid gap-3 sm:gap-5"
                style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(${cardWidth}px, 100%), 1fr))` }}
              >
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId}>
                    <AdminGameCard lb={lb} roomId={room.roomId} maxScores={maxScores} onStyleClick={async (target) => {
                      try {
                        const libStyle = await api.get<{ catalogueStyleId: string | null }>(`/rooms/${room.roomId}/game_library/${encodeURIComponent(target.gameName)}/style`);
                        setLibraryHasDefault(!!libStyle.catalogueStyleId);
                      } catch { setLibraryHasDefault(false); }
                      setStyleTarget(target);
                    }} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex-1 min-w-0 overflow-x-auto">
              <div className="flex gap-3 sm:gap-5 pb-2">
                {visibleLeaderboards.map(lb => (
                  <div key={lb.gameId} className="flex-shrink-0" style={{ width: `min(${cardWidth}px, 75vw)` }}>
                    <AdminGameCard lb={lb} roomId={room.roomId} maxScores={maxScores} onStyleClick={async (target) => {
                      try {
                        const libStyle = await api.get<{ catalogueStyleId: string | null }>(`/rooms/${room.roomId}/game_library/${encodeURIComponent(target.gameName)}/style`);
                        setLibraryHasDefault(!!libStyle.catalogueStyleId);
                      } catch { setLibraryHasDefault(false); }
                      setStyleTarget(target);
                    }} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Rankings: right position */}
          {rankingsPosition === 'right' && rankingGroups.length > 0 && (
            <RankingsColumn rankingGroups={rankingGroups} />
          )}
        </div>

        {/* Rankings: bottom position */}
        {rankingsPosition === 'bottom' && rankingGroups.length > 0 && (
          <RankingsRow rankingGroups={rankingGroups} />
        )}
      </div>

      {/* Style Picker for leaderboard games */}
      {styleTarget && (
        <StylePicker
          currentStyleId={styleTarget.catalogueStyleId}
          headerDisabled={styleTarget.styleHeaderDisabled}
          showDefaultOption
          libraryHasDefault={libraryHasDefault}
          onClose={() => setStyleTarget(null)}
          onSelect={async (styleId, headerDisabled, setAsDefault) => {
            try {
              if (styleId) {
                await api.put(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/style`, {
                  catalogueStyleId: styleId,
                  headerDisabled,
                });
                toast('Style applied', 'success');
              } else {
                await api.delete(`/rooms/${room.roomId}/admin/games/${styleTarget.gameId}/style`);
                toast('Style removed', 'success');
              }
              if (setAsDefault) {
                try {
                  if (styleId) {
                    await api.put(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/style`, {
                      catalogueStyleId: styleId,
                      headerDisabled,
                    });
                    toast('Default style updated in library', 'success');
                  } else {
                    await api.delete(`/rooms/${room.roomId}/game_library/${encodeURIComponent(styleTarget.gameName)}/style`);
                    toast('Default style cleared in library', 'success');
                  }
                } catch {
                  toast('Failed to update library default', 'error');
                }
              }
              loadData();
            } catch (err: any) {
              toast(err.message, 'error');
            }
            setStyleTarget(null);
          }}
        />
      )}
    </div>
  );
}

function AdminGameCard({ lb, roomId, maxScores, onStyleClick }: {
  lb: GameLeaderboard;
  roomId: string;
  maxScores: number;
  onStyleClick: (lb: GameLeaderboard) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);
  const borderColor = getTournamentBorderColor(lb.tournamentType);

  const toggleExpand = async (username: string) => {
    if (expanded === username) {
      setExpanded(null);
      return;
    }
    if (submissions.length === 0) {
      setLoadingSubs(true);
      try {
        const subs = await api.get<Submission[]>(`/rooms/${roomId}/leaderboard/${lb.gameId}/submissions`);
        setSubmissions(subs);
      } catch {
        setSubmissions([]);
      } finally {
        setLoadingSubs(false);
      }
    }
    setExpanded(username);
  };

  const getPlayerSubmissions = (username: string): Submission[] =>
    submissions
      .filter(s => s.iscored_username.toLowerCase() === username.toLowerCase())
      .sort((a, b) => b.score - a.score);

  const styleBgUrl = lb.catalogueStyleId ? `/api/styles/images/backgrounds/${lb.catalogueStyleId}.png` : null;
  const styleHeaderUrl = lb.catalogueStyleId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${lb.catalogueStyleId}.png` : null;
  const bgImage = styleBgUrl || null;

  return (
    <div className={`bg-surface border-2 ${borderColor} rounded-lg overflow-hidden flex flex-col`}>
      {/* Title area */}
      <div className="px-3 py-2.5 text-center border-b border-border/30">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display font-bold text-sm leading-tight truncate flex items-center gap-1.5">
            {lb.gameName}
            {lb.gameStatus === 'COMPLETED' && <span title="Completed"><Lock size={14} className="text-faint flex-shrink-0" /></span>}
          </h3>
          <NeonButton
            variant={lb.catalogueStyleId ? 'secondary' : 'ghost'}
            onClick={() => onStyleClick(lb)}
            className="text-[10px] px-1.5 py-0.5 flex-shrink-0"
          >
            Style
          </NeonButton>
        </div>
        <div className="flex items-center justify-center gap-2 mt-0.5">
          <TournamentBadge type={lb.tournamentType || lb.tournamentName} />
          <p className="text-[11px] text-muted uppercase tracking-wider">{lb.tournamentName}</p>
        </div>
      </div>

      {/* Background image area */}
      {bgImage && (
        <div className="relative h-28 bg-raised">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${bgImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            }}
          />
          {styleHeaderUrl && (
            <img src={styleHeaderUrl} alt="" className="absolute inset-0 w-full h-full object-contain z-[1]" />
          )}
        </div>
      )}

      {/* Scores */}
      <div className="flex-1 text-sm">
        {lb.rankings.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-faint text-xs">No scores yet</p>
          </div>
        ) : (
          <>
            {/* Header row */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span>Player</span>
              <span>Score</span>
            </div>
            {lb.rankings.slice(0, maxScores).map((entry) => {
              const isExpanded = expanded === entry.iscored_username;
              const playerSubs = isExpanded ? getPlayerSubmissions(entry.iscored_username) : [];

              return (
                <div key={entry.discord_user_id}>
                  <div
                    className={`flex items-center justify-between px-3 py-2 border-b border-border/20 last:border-0 cursor-pointer hover:bg-raised/30 transition-colors ${
                      entry.rank === 1 ? 'bg-neon-amber/8' : ''
                    }`}
                    onClick={() => toggleExpand(entry.iscored_username)}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`font-display font-bold text-xs w-5 text-center flex-shrink-0 ${
                        entry.rank === 1 ? 'text-neon-amber' :
                        entry.rank === 2 ? 'text-neon-cyan' :
                        entry.rank === 3 ? 'text-neon-green' :
                        'text-faint'
                      }`}>
                        {entry.rank}
                      </span>
                      <span className="text-xs truncate">{entry.iscored_username}</span>
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <span className={`font-display font-bold text-xs ${
                        entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                      }`}>
                        {entry.score.toLocaleString()}
                      </span>
                      <span className={`text-faint text-[10px] transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▼</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="bg-raised/20 border-b border-border/20 px-3 py-1">
                      {loadingSubs ? (
                        <p className="text-faint text-[10px] py-1">Loading...</p>
                      ) : playerSubs.length <= 1 ? (
                        <p className="text-faint text-[10px] py-1">No additional submissions</p>
                      ) : (
                        playerSubs.slice(1).map((sub, i) => (
                          <div key={i} className="flex items-center justify-between py-0.5 text-[11px]">
                            <span className="text-faint">{new Date(sub.timestamp).toLocaleDateString()}</span>
                            <span className="text-muted font-display">{sub.score.toLocaleString()}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
