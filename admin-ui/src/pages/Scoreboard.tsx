import { useEffect, useState, useRef } from 'react';
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
  rankings: RankedEntry[];
}

const ROTATE_INTERVAL = 10000; // 10 seconds per game

export default function Scoreboard() {
  const [leaderboards, setLeaderboards] = useState<GameLeaderboard[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [flash, setFlash] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

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

  // Auto-rotate between games
  useEffect(() => {
    if (leaderboards.length <= 1) return;
    timerRef.current = setInterval(() => {
      setActiveIndex(prev => (prev + 1) % leaderboards.length);
    }, ROTATE_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [leaderboards.length]);

  const current = leaderboards[activeIndex];

  return (
    <div className="flex flex-col items-center justify-center p-4 sm:p-8 relative min-h-[calc(100vh-57px)]">
      {/* Ambient glow background */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 rounded-full bg-neon-cyan/5 blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 w-64 h-64 rounded-full bg-neon-purple/5 blur-3xl" />
      </div>

      {/* Header */}
      <div className="text-center mb-8 relative z-10">
        <p className="font-display text-muted text-sm uppercase tracking-widest">Live Scoreboard</p>
      </div>

      {/* Score flash overlay */}
      {flash && (
        <div className="fixed inset-0 bg-neon-cyan/5 pointer-events-none z-40 animate-pulse" />
      )}

      {/* Main scoreboard */}
      {!current ? (
        <div className="text-center relative z-10">
          <p className="text-muted font-display">Waiting for active games...</p>
        </div>
      ) : (
        <div className="w-full max-w-2xl relative z-10">
          {/* Game title */}
          <div className="text-center mb-6">
            <h2 className="font-display text-xl sm:text-3xl font-bold text-primary mb-1">{current.gameName}</h2>
            <p className="text-neon-cyan font-display text-sm uppercase tracking-wider">{current.tournamentName}</p>
          </div>

          {/* Rankings */}
          <div className="bg-surface/80 border border-border rounded-lg overflow-hidden backdrop-blur-sm">
            {current.rankings.length === 0 ? (
              <div className="py-12 text-center">
                <p className="text-muted font-display">No scores yet</p>
              </div>
            ) : (
              current.rankings.slice(0, 10).map((entry) => (
                <div
                  key={entry.discord_user_id}
                  className={`flex items-center justify-between px-3 sm:px-6 py-3 sm:py-4 border-b border-border/30 last:border-0 transition-all ${
                    entry.rank === 1 ? 'bg-neon-amber/10' :
                    entry.rank === 2 ? 'bg-neon-cyan/5' :
                    entry.rank === 3 ? 'bg-neon-green/5' : ''
                  }`}
                >
                  <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                    <span className={`font-display font-bold text-base sm:text-xl w-8 sm:w-10 text-center flex-shrink-0 ${
                      entry.rank === 1 ? 'text-neon-amber' :
                      entry.rank === 2 ? 'text-neon-cyan' :
                      entry.rank === 3 ? 'text-neon-green' :
                      'text-faint'
                    }`}>
                      {entry.rank === 1 ? '1ST' : entry.rank === 2 ? '2ND' : entry.rank === 3 ? '3RD' : entry.rank}
                    </span>
                    <span className="font-medium text-sm sm:text-lg truncate">{entry.iscored_username}</span>
                  </div>
                  <span className="font-display font-bold text-lg sm:text-2xl text-neon-amber flex-shrink-0 ml-2">
                    {entry.score.toLocaleString()}
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Game rotation indicators */}
          {leaderboards.length > 1 && (
            <div className="flex justify-center gap-2 mt-6">
              {leaderboards.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setActiveIndex(i)}
                  className={`w-2 h-2 rounded-full transition-all border-none cursor-pointer ${
                    i === activeIndex ? 'bg-neon-cyan w-6' : 'bg-border hover:bg-muted'
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
