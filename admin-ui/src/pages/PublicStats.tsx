import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Trophy, Flame } from 'lucide-react';

interface EnhancedPlayerSummary {
  discord_user_id: string;
  iscored_username: string | null;
  games_played: number;
  wins: number;
  avg_finish_position: number;
  top5_rate: number;
  champion_streak: number;
}

export default function PublicStats() {
  const { slug } = useParams<{ slug: string }>();
  const [players, setPlayers] = useState<EnhancedPlayerSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (!found) { setLoading(false); return; }
        return fetch(`/api/rooms/${found.id}/stats/enhanced/players`);
      })
      .then(r => r?.json())
      .then(data => { if (data) setPlayers(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  return (
    <div>
      {/* Page Header */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        <h2 className="font-display text-xl font-bold">Player Stats</h2>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : players.length === 0 ? (
          <p className="text-muted text-center py-12">No player stats available yet.</p>
        ) : (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Table Header */}
            <div className="hidden sm:grid grid-cols-[40px_1fr_80px_80px_70px_70px_60px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
              <span className="text-center">#</span>
              <span>Player</span>
              <span className="text-center">Games</span>
              <span className="text-center">Avg Finish</span>
              <span className="text-center">Top 5 %</span>
              <span className="text-center">Streak</span>
              <span className="text-center">Wins</span>
            </div>

            {players.map((player, i) => {
              const displayName = player.iscored_username || `User ${player.discord_user_id.slice(-4)}`;
              return (
                <Link
                  key={player.iscored_username || player.discord_user_id}
                  to={`/${slug}/players/${encodeURIComponent(player.iscored_username || player.discord_user_id)}`}
                  className="grid grid-cols-[40px_1fr_auto] sm:grid-cols-[40px_1fr_80px_80px_70px_70px_60px] gap-2 px-4 py-3 border-b border-border/20 last:border-0 items-center hover:bg-raised/50 transition-colors no-underline group"
                >
                  {/* Rank */}
                  <span className="text-faint font-display font-bold text-center">{i + 1}</span>

                  {/* Player name */}
                  <span className="font-medium text-sm text-primary group-hover:text-neon-cyan transition-colors truncate">
                    {displayName}
                  </span>

                  {/* Games Played */}
                  <span className="hidden sm:block text-center text-sm text-muted">{player.games_played}</span>

                  {/* Avg Finish */}
                  <span className="hidden sm:block text-center text-sm text-muted">{player.avg_finish_position.toFixed(1)}</span>

                  {/* Top 5 % */}
                  <span className="hidden sm:block text-center text-sm text-muted">{Math.round(player.top5_rate * 100)}%</span>

                  {/* Streak */}
                  <span className="hidden sm:flex items-center justify-center gap-1 text-sm">
                    {player.champion_streak > 0 ? (
                      <>
                        <Flame size={14} className="text-neon-amber" />
                        <span className="text-neon-amber font-medium">{player.champion_streak}</span>
                      </>
                    ) : (
                      <span className="text-faint">0</span>
                    )}
                  </span>

                  {/* Wins */}
                  <span className="flex items-center justify-end sm:justify-center gap-1 text-sm">
                    <Trophy size={14} className="text-neon-green sm:hidden" />
                    <span className="font-display font-bold text-neon-green">{player.wins}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
