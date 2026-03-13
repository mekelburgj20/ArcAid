import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import StarRating from '../components/StarRating';
import { api } from '../lib/api';

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
  const [leaderboard, setLeaderboard] = useState<GameLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [ratingInfo, setRatingInfo] = useState<{ avg_rating: number; rating_count: number; user_rating: number | null } | null>(null);

  useEffect(() => {
    if (!name) return;

    // Load game stats
    fetch(`/api/stats/game/${encodeURIComponent(name)}`)
      .then(r => r.json())
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));

    // Load ratings
    api.get<{ avg_rating: number; rating_count: number; user_rating: number | null }>(`/ratings/${encodeURIComponent(name)}`)
      .then(setRatingInfo)
      .catch(() => {});

    // Load active leaderboard for this game (find matching game from active leaderboards)
    fetch('/api/leaderboard')
      .then(r => r.json())
      .then((boards: GameLeaderboard[]) => {
        const match = boards.find(b => b.gameName.toLowerCase() === name.toLowerCase());
        if (match) setLeaderboard(match);
      })
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

  const imageUrl = leaderboard?.imageUrl;

  return (
    <div>
      {/* Hero header with image */}
      <div
        className="relative h-40 sm:h-48 bg-raised flex items-end"
        style={imageUrl ? {
          backgroundImage: `url(${imageUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : undefined}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/50 to-black/20" />
        <div className="relative z-10 max-w-4xl mx-auto w-full px-4 sm:px-6 pb-4">
          <Link to={`/${slug}`} className="text-white/50 text-xs hover:text-white/70 no-underline transition-colors">
            &larr; Scoreboard
          </Link>
          <h2 className="font-display text-2xl font-bold text-white mt-1">{stats.gameName}</h2>
          {leaderboard && (
            <p className="text-white/50 text-xs uppercase tracking-wider">{leaderboard.tournamentName}</p>
          )}
          {ratingInfo && (
            <div className="flex items-center gap-2 mt-1">
              <StarRating rating={ratingInfo.user_rating || 0} onRate={handleRate} size="md" />
              {ratingInfo.rating_count > 0 && (
                <span className="text-sm text-white/60">{ratingInfo.avg_rating} avg ({ratingInfo.rating_count} rating{ratingInfo.rating_count !== 1 ? 's' : ''})</span>
              )}
            </div>
          )}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {/* Stat Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <StatCard label="Times Played" value={stats.timesPlayed.toString()} color="text-neon-cyan" />
          <StatCard label="Unique Players" value={stats.uniquePlayers.toString()} color="text-neon-green" />
          <StatCard label="Avg Score" value={stats.avgScore.toLocaleString()} color="text-muted" />
          <StatCard label="All-Time High" value={stats.allTimeHigh.toLocaleString()} color="text-neon-amber" />
        </div>

        {/* Active Leaderboard - Full scores */}
        {leaderboard && leaderboard.rankings.length > 0 && (
          <div className="mb-8">
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Current Leaderboard</h2>
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {/* Header row */}
              <div className="flex items-center justify-between px-5 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                <div className="flex items-center gap-3">
                  <span className="w-8 text-center">Rank</span>
                  <span>Player</span>
                </div>
                <span>Score</span>
              </div>
              {leaderboard.rankings.map((entry) => (
                <div
                  key={entry.discord_user_id}
                  className={`flex items-center justify-between px-5 py-3 border-b border-border/20 last:border-0 ${
                    entry.rank === 1 ? 'bg-neon-amber/8' : ''
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className={`font-display font-bold w-8 text-center flex-shrink-0 ${
                      entry.rank === 1 ? 'text-neon-amber text-lg' :
                      entry.rank === 2 ? 'text-neon-cyan' :
                      entry.rank === 3 ? 'text-neon-green' :
                      'text-faint'
                    }`}>
                      {entry.rank}
                    </span>
                    <span className="font-medium truncate">{entry.iscored_username}</span>
                  </div>
                  <span className={`font-display font-bold flex-shrink-0 ml-2 ${
                    entry.rank === 1 ? 'text-neon-amber text-lg' : 'text-primary'
                  }`}>
                    {entry.score.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Record Holder */}
        {stats.allTimeHighPlayer && (
          <div className="bg-surface border border-neon-amber/30 rounded-lg p-5 mb-8 text-center">
            <p className="text-faint text-xs uppercase tracking-wider mb-1">All-Time Record Holder</p>
            <p className="font-display text-xl font-bold text-neon-amber">{stats.allTimeHighPlayer}</p>
            <p className="text-muted text-sm">{stats.allTimeHigh.toLocaleString()} points</p>
          </div>
        )}

        {/* Recent Results */}
        {stats.recentResults.length > 0 && (
          <div>
            <h2 className="font-display text-sm text-muted uppercase tracking-wider mb-3">Past Results</h2>
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
                          {r.winner_score?.toLocaleString() ?? '--'}
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
