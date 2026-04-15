import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy, Clock, Users } from 'lucide-react';

interface GameLeaderboardSummary {
  game_name: string;
  display_name: string | null;
  total_scores: number;
  unique_players: number;
  last_played: string;
  catalogue_image: string | null;
  top_scores: Array<{
    iscored_username: string;
    best_score: number;
  }>;
}

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diff = now - then;
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface AllGamesViewProps {
  roomId: string;
  slug: string;
}

export default function AllGamesView({ roomId, slug }: AllGamesViewProps) {
  const [games, setGames] = useState<GameLeaderboardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<'recent' | 'alpha'>('recent');
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 20;

  const fetchGames = useCallback(async (reset = false) => {
    const currentOffset = reset ? 0 : offset;
    const params = new URLSearchParams({
      sort,
      limit: String(PAGE_SIZE),
      offset: String(currentOffset),
    });
    try {
      const res = await fetch(`/api/rooms/${roomId}/community-leaderboards?${params}`);
      if (!res.ok) return;
      const data: GameLeaderboardSummary[] = await res.json();
      if (reset) {
        setGames(data);
        setOffset(data.length);
      } else {
        setGames(prev => [...prev, ...data]);
        setOffset(currentOffset + data.length);
      }
      setHasMore(data.length >= PAGE_SIZE);
    } catch { /* ignore */ }
  }, [roomId, sort, offset]);

  useEffect(() => {
    setLoading(true);
    setOffset(0);
    fetchGames(true).finally(() => setLoading(false));
  }, [roomId, sort]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (games.length === 0) {
    return (
      <div className="text-center py-16">
        <p className="text-muted">No community scores yet.</p>
        <p className="text-xs text-faint mt-1">
          Submit scores via{' '}
          <Link to={`/${slug}/freeplay`} className="text-neon-cyan hover:underline">Freeplay</Link>
          {' '}to see them here.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4">
      {/* Sort toggle */}
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setSort('recent')}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer ${
            sort === 'recent'
              ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
              : 'border-border/50 text-muted hover:text-primary'
          }`}
        >
          <Clock size={12} className="inline mr-1" />
          Recent
        </button>
        <button
          onClick={() => setSort('alpha')}
          className={`px-3 py-1.5 text-xs rounded-lg border transition-colors cursor-pointer ${
            sort === 'alpha'
              ? 'bg-neon-cyan/10 border-neon-cyan/40 text-neon-cyan'
              : 'border-border/50 text-muted hover:text-primary'
          }`}
        >
          A-Z
        </button>
      </div>

      {/* Game cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {games.map(game => (
          <Link
            key={game.game_name}
            to={`/${slug}/games/${encodeURIComponent(game.game_name)}`}
            className="no-underline block"
          >
            <div className="bg-surface border border-border/50 rounded-lg overflow-hidden hover:border-neon-cyan/30 transition-colors group">
              {/* Image header */}
              {game.catalogue_image ? (
                <div className="h-24 bg-deep overflow-hidden">
                  <img
                    src={toCatalogueUrl(game.catalogue_image)}
                    alt=""
                    className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                  />
                </div>
              ) : (
                <div className="h-12 bg-gradient-to-r from-neon-cyan/5 to-neon-magenta/5" />
              )}

              {/* Content */}
              <div className="px-3 py-2.5">
                <h3 className="text-sm font-semibold text-primary truncate">
                  {game.display_name || game.game_name}
                </h3>

                {/* Stats row */}
                <div className="flex items-center gap-3 mt-1.5 text-[10px] text-faint">
                  <span className="flex items-center gap-1">
                    <Users size={10} />
                    {game.unique_players}
                  </span>
                  <span className="flex items-center gap-1">
                    <Trophy size={10} />
                    {game.total_scores} scores
                  </span>
                  <span>{relativeTime(game.last_played)}</span>
                </div>

                {/* Top scores */}
                {game.top_scores.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {game.top_scores.slice(0, 3).map((s, i) => (
                      <div key={s.iscored_username} className="flex items-center justify-between text-[11px]">
                        <span className="text-muted truncate">
                          <span className={i === 0 ? 'text-neon-cyan' : 'text-faint'}>
                            #{i + 1}
                          </span>
                          {' '}{s.iscored_username}
                        </span>
                        <span className="text-primary font-mono ml-2">
                          {s.best_score.toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Link>
        ))}
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center pt-6">
          <button
            onClick={() => fetchGames(false)}
            className="px-4 py-2 text-xs text-muted hover:text-neon-cyan border border-border/50 rounded-lg hover:border-neon-cyan/30 transition-colors cursor-pointer"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
