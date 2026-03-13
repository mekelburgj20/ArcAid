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

const TOP_N = 5;

export default function Scoreboard() {
  const { slug } = useParams<{ slug: string }>();
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [flash, setFlash] = useState(false);

  const loadData = async () => {
    try {
      const res = await fetch('/api/leaderboard');
      if (res.ok) setLeaderboards(await res.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    loadData();

    const socket = getSocket();
    socket.on('score:new', () => {
      setFlash(true);
      loadData();
      setTimeout(() => setFlash(false), 1500);
    });
    socket.on('leaderboard:updated', loadData);
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
