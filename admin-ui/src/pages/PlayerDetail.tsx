import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';

interface PlayerStats {
  discordUserId: string;
  iscoredUsername: string | null;
  totalGamesPlayed: number;
  totalWins: number;
  winPercentage: number;
  averageScore: number;
  bestScore: number;
  bestGame: string | null;
  recentScores: Array<{ game_name: string; score: number; date: string }>;
}

export default function PlayerDetail() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/stats/player/${encodeURIComponent(id)}`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center py-24 text-muted">
        Player not found.
      </div>
    );
  }

  const displayName = stats.iscoredUsername || `Player ${stats.discordUserId.slice(-4)}`;

  return (
    <div>
      {/* Page Header */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        <Link to={`/${slug}/players`} className="text-faint text-xs hover:text-muted no-underline transition-colors">
          &larr; All Players
        </Link>
        <h2 className="font-display text-xl font-bold mt-1">{displayName}</h2>
        {stats.iscoredUsername && (
          <p className="text-faint text-xs mt-0.5">iScored: {stats.iscoredUsername}</p>
        )}
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
          <StatCard label="Games Played" value={stats.totalGamesPlayed.toString()} color="text-neon-cyan" />
          <StatCard label="Wins" value={stats.totalWins.toString()} color="text-neon-green" />
          <StatCard label="Win %" value={`${stats.winPercentage}%`} color="text-neon-amber" />
          <StatCard label="Avg Score" value={stats.averageScore.toLocaleString()} color="text-muted" />
          <StatCard label="Best Score" value={stats.bestScore.toLocaleString()} color="text-neon-magenta" />
          <StatCard label="Best Game" value={stats.bestGame || 'N/A'} color="text-primary" small />
        </div>

        {/* Recent Scores */}
        {stats.recentScores.length > 0 && (
          <div>
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Recent Scores</h2>
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {stats.recentScores.map((s, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-5 py-3 border-b border-border/30 last:border-0"
                >
                  <div>
                    <Link
                      to={`/${slug}/games/${encodeURIComponent(s.game_name)}`}
                      className="text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
                    >
                      {s.game_name}
                    </Link>
                    <p className="text-faint text-xs">{new Date(s.date).toLocaleDateString()}</p>
                  </div>
                  <span className="font-display font-bold text-neon-amber">{s.score.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, color, small }: { label: string; value: string; color: string; small?: boolean }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display font-bold ${small ? 'text-sm' : 'text-2xl'} ${color}`}>{value}</p>
    </div>
  );
}
