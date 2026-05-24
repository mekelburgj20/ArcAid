import { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { Flame } from 'lucide-react';

interface PlayerStats {
  discordUserId: string;
  iscoredUsername: string | null;
  totalGamesPlayed: number;
  totalWins: number;
  winPercentage: number;
  avg_finish_position: number;
  top5_rate: number;
  champion_streak: number;
  bestGame: string | null;
  recentScores: Array<{ game_name: string; score: number; date: string }>;
}

export default function PlayerDetail() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  // v2.13.16 — read ?from + ?tab so the back link can return to the
  // originating leaderboard view instead of always defaulting to All Players.
  const [searchParams] = useSearchParams();
  const fromSlug = searchParams.get('from');
  const fromTab = searchParams.get('tab');
  const backToLeaderboardHref = fromSlug
    ? `/${fromSlug}${fromTab === 'all-games' ? '?tab=all-games' : ''}`
    : null;
  const [stats, setStats] = useState<PlayerStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id || !slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug!.toLowerCase());
        if (!found) { setLoading(false); return; }
        return fetch(`/api/rooms/${found.id}/stats/enhanced/player/${encodeURIComponent(id!)}`);
      })
      .then(r => r?.json())
      .then(data => { if (data) setStats(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug, id]);

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
        {/* v2.13.16 — primary back link returns to the originating leaderboard
            when ?from is present (set by PlayerNameLink); secondary "All
            Players" link is always available. */}
        <div className="flex items-center gap-4 text-xs">
          {backToLeaderboardHref ? (
            <>
              <Link to={backToLeaderboardHref} className="text-faint hover:text-muted no-underline transition-colors">
                &larr; Back to Leaderboard
              </Link>
              <Link to={`/${slug}/players`} className="text-faint hover:text-muted no-underline transition-colors">
                All Players
              </Link>
            </>
          ) : (
            <Link to={`/${slug}/players`} className="text-faint hover:text-muted no-underline transition-colors">
              &larr; All Players
            </Link>
          )}
        </div>
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
          <StatCard label="Avg Finish" value={stats.avg_finish_position.toFixed(1)} color="text-muted" />
          <StatCard label="Top 5 %" value={`${Math.round(stats.top5_rate * 100)}%`} color="text-neon-magenta" />
          <div className="bg-surface border border-border rounded-lg p-4 text-center">
            <p className="text-faint text-xs uppercase tracking-wider mb-1">Streak</p>
            <div className="flex items-center justify-center gap-1">
              {stats.champion_streak > 0 && <Flame size={18} className="text-neon-amber" />}
              <p className={`font-display font-bold text-2xl ${stats.champion_streak > 0 ? 'text-neon-amber' : 'text-faint'}`}>
                {stats.champion_streak}
              </p>
            </div>
          </div>
        </div>

        {/* Best Game */}
        {stats.bestGame && (
          <div className="mb-8">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Best Game</h2>
            <Link
              to={`/${slug}/games/${encodeURIComponent(stats.bestGame)}`}
              className="inline-block bg-surface border border-border rounded-lg px-5 py-3 text-primary hover:text-neon-cyan no-underline transition-colors font-medium"
            >
              {stats.bestGame}
            </Link>
          </div>
        )}

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

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 text-center">
      <p className="text-faint text-xs uppercase tracking-wider mb-1">{label}</p>
      <p className={`font-display font-bold text-2xl ${color}`}>{value}</p>
    </div>
  );
}
