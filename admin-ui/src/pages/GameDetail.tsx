import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import StarRating from '../components/StarRating';
import { api } from '../lib/api';

interface GameStats {
  gameName: string;
  timesPlayed: number;
  avgScore: number;
  uniquePlayers: number;
  allTimeHigh: number;
  allTimeHighPlayer: string | null;
  recentResults: Array<{
    tournament_name: string;
    winner_name: string;
    winner_score: number;
    end_date: string;
  }>;
}

export default function GameDetail() {
  const { slug, name } = useParams<{ slug: string; name: string }>();
  const [stats, setStats] = useState<GameStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [ratingInfo, setRatingInfo] = useState<{ avg_rating: number; rating_count: number; user_rating: number | null } | null>(null);

  useEffect(() => {
    if (!name) return;
    fetch(`/api/stats/game/${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
    api.get<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`/ratings/${encodeURIComponent(name)}`)
      .then(setRatingInfo)
      .catch(() => {});
  }, [name]);

  const handleRate = async (rating: number) => {
    if (!name) return;
    try {
      const info = await api.post<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`/ratings/${encodeURIComponent(name)}`, { rating });
      setRatingInfo(info);
    } catch {}
  };

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
        Game not found.
      </div>
    );
  }

  return (
    <div>
      {/* Page Header */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        <Link to={`/${slug}`} className="text-faint text-xs hover:text-muted no-underline transition-colors">
          &larr; Scoreboard
        </Link>
        <h2 className="font-display text-xl font-bold mt-1">{stats.gameName}</h2>
        {ratingInfo && (
          <div className="flex items-center gap-2 mt-1">
            <StarRating rating={ratingInfo.user_rating || 0} onRate={handleRate} size="md" />
            {ratingInfo.rating_count > 0 && (
              <span className="text-sm text-muted">{ratingInfo.avg_rating} avg ({ratingInfo.rating_count} rating{ratingInfo.rating_count !== 1 ? 's' : ''})</span>
            )}
          </div>
        )}
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Times Played" value={stats.timesPlayed.toString()} color="text-neon-cyan" />
          <StatCard label="Unique Players" value={stats.uniquePlayers.toString()} color="text-neon-green" />
          <StatCard label="Avg Score" value={stats.avgScore.toLocaleString()} color="text-muted" />
          <StatCard label="All-Time High" value={stats.allTimeHigh.toLocaleString()} color="text-neon-amber" />
        </div>

        {/* Record Holder */}
        {stats.allTimeHighPlayer && (
          <div className="bg-surface border border-neon-amber/30 rounded-lg p-5 mb-8 text-center">
            <p className="text-faint text-xs uppercase tracking-wider mb-1">Record Holder</p>
            <p className="font-display text-xl font-bold text-neon-amber">{stats.allTimeHighPlayer}</p>
            <p className="text-muted text-sm">{stats.allTimeHigh.toLocaleString()} points</p>
          </div>
        )}

        {/* Recent Results */}
        {stats.recentResults.length > 0 && (
          <div>
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Recent Results</h2>
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {stats.recentResults.map((r, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between px-5 py-3 border-b border-border/30 last:border-0"
                >
                  <div>
                    <p className="font-medium">{r.tournament_name}</p>
                    <p className="text-faint text-xs">
                      {r.end_date ? new Date(r.end_date).toLocaleDateString() : 'In progress'}
                    </p>
                  </div>
                  <div className="text-right">
                    {r.winner_name ? (
                      <>
                        <p className="text-neon-green text-sm font-medium">{r.winner_name}</p>
                        <p className="font-display font-bold text-neon-amber">
                          {r.winner_score?.toLocaleString() ?? '—'}
                        </p>
                      </>
                    ) : (
                      <p className="text-faint text-sm">No winner</p>
                    )}
                  </div>
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
