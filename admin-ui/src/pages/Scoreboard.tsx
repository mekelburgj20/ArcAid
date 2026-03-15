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
  tournamentType: string;
  imageUrl: string | null;
  rankings: RankedEntry[];
}

const TOURNAMENT_COLORS: Record<string, string> = {
  DG:       'border-neon-magenta/50',
  'WG-VPXS': 'border-neon-blue/50',
  'WG-VR':  'border-neon-purple/50',
  MG:       'border-neon-coral/50',
};

function getTournamentBorderColor(type: string): string {
  if (!type) return 'border-border';
  const upper = type.toUpperCase();
  return TOURNAMENT_COLORS[upper] ?? 'border-border';
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
    <div className="px-4 sm:px-6 py-6">
      {/* Score flash overlay */}
      {flash && (
        <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
      )}

      {/* Header */}
      <div className="text-center mb-8">
        <p className="font-display text-muted text-sm uppercase tracking-widest">High Scores</p>
      </div>

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Overall Rankings — left column */}
        {rankingGroups.length > 0 && (
          <div className="w-full lg:w-80 flex-shrink-0 lg:sticky lg:top-6">
            <p className="font-display text-muted text-sm uppercase tracking-widest mb-4">Overall Rankings</p>
            <div className="flex flex-col gap-5">
              {rankingGroups.map(({ group, rankings }) => (
                <RankingGroupCard key={group.id} group={group} rankings={rankings} />
              ))}
            </div>
          </div>
        )}

        {/* Game leaderboards — horizontal scroll */}
        {leaderboards.length === 0 ? (
          <div className="flex-1 text-center py-24">
            <p className="text-muted font-display">Waiting for active games...</p>
          </div>
        ) : (
          <div className="flex-1 min-w-0 overflow-x-auto">
            <div className="flex gap-5 pb-2">
              {leaderboards.map(lb => (
                <div key={lb.gameId} className="w-72 flex-shrink-0">
                  <GameCard lb={lb} slug={slug || ''} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function GameCard({ lb, slug }: { lb: GameLeaderboard; slug: string }) {
  const borderColor = getTournamentBorderColor(lb.tournamentType);
  return (
    <div className={`bg-surface border-2 ${borderColor} rounded-lg overflow-hidden flex flex-col`}>
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
    <div className="bg-neon-purple/5 border border-neon-purple/20 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-neon-purple/15 bg-neon-purple/10">
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
          <div className="flex items-center justify-between px-4 py-2 border-b border-neon-purple/10 text-[10px] text-faint uppercase tracking-wider">
            <span>Player</span>
            <div className="flex gap-6">
              <span className="w-12 text-right">Games</span>
              <span className="w-16 text-right">{methodInfo.scoreLabel}</span>
            </div>
          </div>
          {rankings.slice(0, RANKINGS_TOP_N).map((entry) => (
            <div
              key={entry.iscored_username}
              className={`flex items-center justify-between px-4 py-2.5 border-b border-neon-purple/10 last:border-0 ${
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
