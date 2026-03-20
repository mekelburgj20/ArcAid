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

interface RankingGroupData {
  group: {
    id: string;
    name: string;
    description: string;
    rank_method: string;
    best_n: number;
    min_games: number;
  };
  rankings: Array<{
    rank: number;
    iscored_username: string;
    total_points: number;
    games_played: number;
  }>;
}

const METHOD_LABELS: Record<string, { label: string; scoreLabel: string }> = {
  max_10: { label: 'Max 10', scoreLabel: 'Points' },
  average_rank: { label: 'Average Rank', scoreLabel: 'Avg Rank' },
  best_game_papa: { label: 'Best Game (PAPA)', scoreLabel: 'Points' },
  best_game_linear: { label: 'Best Game (Linear)', scoreLabel: 'Points' },
};

const RANKINGS_TOP_N = 10;
const TOP_N = 10;
const CARDS_PER_ROW = 8;

export default function Leaderboard() {
  const room = useRoom();
  const { toast } = useToast();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [loading, setLoading] = useState(true);
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

  useEffect(() => {
    loadData();
    loadRankings();

    const socket = getSocket();
    socket.on('leaderboard:updated', () => { loadData(); loadRankings(); });
    socket.on('score:new', () => { loadData(); loadRankings(); });

    return () => {
      socket.off('leaderboard:updated');
      socket.off('score:new');
    };
  }, []);

  if (loading) return <LoadingState message="Loading leaderboards..." />;

  // Build rows: each row has up to CARDS_PER_ROW slots.
  // Rankings take the first column of every row, game cards fill the rest.
  const hasRankings = rankingGroups.length > 0;
  const gameSlots = hasRankings ? CARDS_PER_ROW - 1 : CARDS_PER_ROW;

  // Split games into rows
  const gameRows: GameLeaderboard[][] = [];
  for (let i = 0; i < leaderboards.length; i += gameSlots) {
    gameRows.push(leaderboards.slice(i, i + gameSlots));
  }

  // Ensure at least one row if we have rankings
  if (gameRows.length === 0 && hasRankings) {
    gameRows.push([]);
  }

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Leaderboards</h1>

      {leaderboards.length === 0 && !hasRankings ? (
        <div className="text-center py-16">
          <p className="text-muted font-display">No active games with scores yet.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {gameRows.map((row, rowIdx) => (
            <div key={rowIdx} className="flex gap-3">
              {/* Rankings column — only on first column of each row */}
              {hasRankings && (
                <div className="w-[calc((100%-1.75rem*7)/8)] flex-shrink-0">
                  {rowIdx < rankingGroups.length ? (
                    <RankingGroupCard
                      group={rankingGroups[rowIdx].group}
                      rankings={rankingGroups[rowIdx].rankings}
                    />
                  ) : (
                    <div /> /* empty placeholder to maintain grid alignment */
                  )}
                </div>
              )}

              {/* Game cards */}
              {row.map(lb => (
                <div key={lb.gameId} className="w-[calc((100%-1.75rem*7)/8)] flex-shrink-0">
                  <GameCard lb={lb} roomId={room.roomId} onStyleClick={async (target) => {
                    // Check if library has a default style for this game
                    try {
                      const libStyle = await api.get<{ catalogueStyleId: string | null }>(`/rooms/${room.roomId}/game_library/${encodeURIComponent(target.gameName)}/style`);
                      setLibraryHasDefault(!!libStyle.catalogueStyleId);
                    } catch {
                      setLibraryHasDefault(false);
                    }
                    setStyleTarget(target);
                  }} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

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
              // Also update library default if requested
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

function GameCard({ lb, roomId, onStyleClick }: { lb: GameLeaderboard; roomId: string; onStyleClick: (lb: GameLeaderboard) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loadingSubs, setLoadingSubs] = useState(false);

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

  const bgUrl = lb.catalogueStyleId ? `/api/styles/images/backgrounds/${lb.catalogueStyleId}.png` : null;
  const headerUrl = lb.catalogueStyleId && !lb.styleHeaderDisabled ? `/api/styles/images/headers/${lb.catalogueStyleId}.png` : null;

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden flex flex-col h-full">
      {/* Style header (background + optional header image) */}
      {bgUrl && (
        <div
          className="h-24 bg-cover bg-center relative"
          style={{ backgroundImage: `url(${bgUrl})` }}
        >
          {headerUrl && (
            <img src={headerUrl} alt="" className="absolute inset-0 w-full h-full object-contain" />
          )}
        </div>
      )}

      {/* Header */}
      <div className="px-3 py-2.5 border-b border-border/50">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display font-bold text-sm text-primary truncate">{lb.gameName}</h3>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <TournamentBadge type={lb.tournamentType || lb.tournamentName} />
            {lb.gameStatus === 'COMPLETED' && (
              <span title="Completed"><Lock size={12} className="text-faint" /></span>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between">
          <p className="text-[11px] text-muted truncate">{lb.tournamentName}</p>
          <NeonButton
            variant={lb.catalogueStyleId ? 'secondary' : 'ghost'}
            onClick={() => onStyleClick(lb)}
            className="text-[10px] px-1.5 py-0.5 flex-shrink-0"
          >
            Style
          </NeonButton>
        </div>
      </div>

      {/* Scores */}
      <div className="flex-1 text-sm">
        {lb.rankings.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-faint text-xs">No scores yet</p>
          </div>
        ) : (
          <>
            {lb.rankings.slice(0, TOP_N).map((entry) => {
              const isExpanded = expanded === entry.iscored_username;
              const playerSubs = isExpanded ? getPlayerSubmissions(entry.iscored_username) : [];

              return (
                <div key={entry.discord_user_id}>
                  <div
                    className={`flex items-center justify-between px-3 py-1.5 border-b border-border/20 last:border-0 cursor-pointer hover:bg-raised/30 transition-colors ${
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

function RankingGroupCard({ group, rankings }: { group: RankingGroupData['group']; rankings: RankingGroupData['rankings'] }) {
  const methodInfo = METHOD_LABELS[group.rank_method] || { label: group.rank_method, scoreLabel: 'Score' };

  return (
    <div className="bg-neon-purple/5 border border-neon-purple/20 rounded-lg overflow-hidden h-full flex flex-col">
      {/* Header */}
      <div className="px-3 py-2.5 border-b border-neon-purple/15 bg-neon-purple/10">
        <h3 className="font-display font-bold text-sm text-primary">{group.name}</h3>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-muted uppercase tracking-wider">{methodInfo.label}</span>
          {group.description && (
            <span className="text-[10px] text-faint">{group.description}</span>
          )}
        </div>
      </div>

      {/* Rankings */}
      <div className="flex-1 text-sm">
        {rankings.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-faint text-xs">No qualified players yet</p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-neon-purple/10 text-[10px] text-faint uppercase tracking-wider">
              <span>Player</span>
              <div className="flex gap-4">
                <span className="w-8 text-right">GP</span>
                <span className="w-12 text-right">{methodInfo.scoreLabel}</span>
              </div>
            </div>
            {rankings.slice(0, RANKINGS_TOP_N).map((entry) => (
              <div
                key={entry.iscored_username}
                className={`flex items-center justify-between px-3 py-1.5 border-b border-neon-purple/10 last:border-0 ${
                  entry.rank === 1 ? 'bg-neon-amber/8' : ''
                }`}
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
                <div className="flex gap-4">
                  <span className="text-xs text-muted w-8 text-right">{entry.games_played}</span>
                  <span className={`font-display font-bold text-xs w-12 text-right ${
                    entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                  }`}>
                    {group.rank_method === 'average_rank'
                      ? entry.total_points.toFixed(2)
                      : entry.total_points.toLocaleString()}
                  </span>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
