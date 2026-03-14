import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSocket } from '../lib/websocket';

interface RankedEntry {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  score: number;
}

interface GameLeaderboard {
  gameId: string;
  gameName: string;
  tournamentName: string;
  imageUrl: string | null;
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

const TOP_N = 5;
const RANKINGS_TOP_N = 10;

export default function Scoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [rankingGroups, setRankingGroups] = useState<RankingGroupData[]>([]);
  const [flash, setFlash] = useState(false);

  const loadData = async () => {
    try {
      const res = await fetch('/api/leaderboard');
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
  };

  const loadRankings = async () => {
    try {
      const res = await fetch('/api/rankings');
      if (res.ok) setRankingGroups(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
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
  }, []);

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto">
      {/* Score flash overlay */}
      {flash && (
        <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
      )}

      {/* Header */}
      <div className="text-center mb-8">
        <p className="font-display text-muted text-sm uppercase tracking-widest">High Scores</p>
      </div>

      {leaderboards.length === 0 ? (
        <div className="text-center py-24">
          <p className="text-muted font-display">Waiting for active games...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {leaderboards.map(lb => (
            <GameCard key={lb.gameId} lb={lb} slug={slug || ''} />
          ))}
        </div>
      )}

      {/* Overall Rankings */}
      {rankingGroups.length > 0 && (
        <div className="mt-10">
          <div className="text-center mb-6">
            <p className="font-display text-muted text-sm uppercase tracking-widest">Overall Rankings</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {rankingGroups.map(({ group, rankings }) => (
              <RankingGroupCard key={group.id} group={group} rankings={rankings} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function GameCard({ lb, slug }: { lb: GameLeaderboard; slug: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden flex flex-col">
      {/* Image / Header area */}
      <div
        className="relative h-32 bg-raised flex items-end"
        style={lb.imageUrl ? {
          backgroundImage: `url(${lb.imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : undefined}
      >
        {/* Dark gradient overlay for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/10" />
        <div className="relative z-10 px-4 pb-3 w-full">
          <h3 className="font-display font-bold text-base text-white leading-tight truncate">{lb.gameName}</h3>
          <p className="text-[11px] text-white/60 uppercase tracking-wider">{lb.tournamentName}</p>
        </div>
      </div>

      {/* Scores */}
      <div className="flex-1">
        {lb.rankings.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-faint text-sm">No scores yet</p>
          </div>
        ) : (
          <div>
            {/* Header row */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span>Player</span>
              <span>Score</span>
            </div>
            {lb.rankings.slice(0, TOP_N).map((entry) => (
              <div
                key={entry.discord_user_id}
                className={`flex items-center justify-between px-4 py-2.5 border-b border-border/20 last:border-0 ${
                  entry.rank === 1 ? 'bg-neon-amber/8' : ''
                }`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                    entry.rank === 1 ? 'text-neon-amber' :
                    entry.rank === 2 ? 'text-neon-cyan' :
                    entry.rank === 3 ? 'text-neon-green' :
                    'text-faint'
                  }`}>
                    {entry.rank}
                  </span>
                  <span className="text-sm truncate">{entry.iscored_username}</span>
                </div>
                <span className={`font-display font-bold text-sm flex-shrink-0 ml-2 ${
                  entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                }`}>
                  {entry.score.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer link */}
      <div className="border-t border-border/50 px-4 py-2.5">
        <Link
          to={`/${slug}/games/${encodeURIComponent(lb.gameName)}`}
          className="text-xs text-neon-cyan hover:text-neon-cyan/80 no-underline transition-colors"
        >
          Full Leaderboard &rarr;
        </Link>
      </div>
    </div>
  );
}

const METHOD_LABELS: Record<string, { label: string; scoreLabel: string }> = {
  max_10: { label: 'Max 10', scoreLabel: 'Points' },
  average_rank: { label: 'Average Rank', scoreLabel: 'Avg Rank' },
  best_game_papa: { label: 'Best Game (PAPA)', scoreLabel: 'Points' },
  best_game_linear: { label: 'Best Game (Linear)', scoreLabel: 'Points' },
};

function RankingGroupCard({ group, rankings }: { group: RankingGroupData['group']; rankings: RankingGroupData['rankings'] }) {
  const methodInfo = METHOD_LABELS[group.rank_method] || { label: group.rank_method, scoreLabel: 'Score' };

  return (
    <div className="bg-surface border border-border rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/50 bg-raised/30">
        <h3 className="font-display font-bold text-base text-primary">{group.name}</h3>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[11px] text-muted uppercase tracking-wider">{methodInfo.label}</span>
          {group.description && (
            <span className="text-[11px] text-faint">{group.description}</span>
          )}
        </div>
      </div>

      {/* Rankings */}
      {rankings.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-faint text-sm">No qualified players yet</p>
        </div>
      ) : (
        <div>
          <div className="flex items-center justify-between px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
            <span>Player</span>
            <div className="flex gap-6">
              <span className="w-12 text-right">Games</span>
              <span className="w-16 text-right">{methodInfo.scoreLabel}</span>
            </div>
          </div>
          {rankings.slice(0, RANKINGS_TOP_N).map((entry) => (
            <div
              key={entry.iscored_username}
              className={`flex items-center justify-between px-4 py-2.5 border-b border-border/20 last:border-0 ${
                entry.rank === 1 ? 'bg-neon-amber/8' : ''
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${
                  entry.rank === 1 ? 'text-neon-amber' :
                  entry.rank === 2 ? 'text-neon-cyan' :
                  entry.rank === 3 ? 'text-neon-green' :
                  'text-faint'
                }`}>
                  {entry.rank}
                </span>
                <span className="text-sm truncate">{entry.iscored_username}</span>
              </div>
              <div className="flex gap-6">
                <span className="text-sm text-muted w-12 text-right">{entry.games_played}</span>
                <span className={`font-display font-bold text-sm w-16 text-right ${
                  entry.rank === 1 ? 'text-neon-amber' : 'text-primary'
                }`}>
                  {group.rank_method === 'average_rank'
                    ? entry.total_points.toFixed(2)
                    : entry.total_points.toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
