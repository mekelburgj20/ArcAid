import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Upload, Filter } from 'lucide-react';
import LoadingState from './LoadingState';
import type { CatalogueGame } from './FreeplaySubmitModal';

interface CatalogueBrowseProps {
  slug: string;
  onSubmitGame: (game: CatalogueGame) => void;
}

const PAGE_SIZE = 24;

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'pinball', label: 'Pinball' },
  { value: 'arcade', label: 'Arcade' },
  { value: 'video_game', label: 'Video Game' },
];

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function imageFor(game: CatalogueGame): string | null {
  if (game.local_image_path) return toCatalogueUrl(game.local_image_path);
  if (game.wheel_image_path) return toCatalogueUrl(game.wheel_image_path);
  if (game.image_url) return game.image_url;
  return null;
}

export default function CatalogueBrowse({ slug, onSubmitGame }: CatalogueBrowseProps) {
  const [games, setGames] = useState<CatalogueGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  const buildQuery = useCallback((cursor?: string): string => {
    const params = new URLSearchParams({ status: 'approved', limit: String(PAGE_SIZE) });
    if (search) params.set('search', search);
    if (type) params.set('type', type);
    if (cursor) params.set('cursor', cursor);
    return params.toString();
  }, [search, type]);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/global/games?${buildQuery()}`)
      .then(r => r.ok ? r.json() : { data: [], hasMore: false })
      .then(payload => {
        setGames(payload.data || []);
        setHasMore(Boolean(payload.hasMore));
      })
      .catch(() => { setGames([]); setHasMore(false); })
      .finally(() => setLoading(false));
  }, [buildQuery]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || games.length === 0) return;
    const last = games[games.length - 1];
    setLoadingMore(true);
    fetch(`/api/global/games?${buildQuery(last.id)}`)
      .then(r => r.ok ? r.json() : { data: [], hasMore: false })
      .then(payload => {
        setGames(prev => [...prev, ...(payload.data || [])]);
        setHasMore(Boolean(payload.hasMore));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [buildQuery, games, hasMore, loadingMore]);

  return (
    <div>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="flex-1 relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search games..."
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            className="w-full pl-10 pr-3 py-2 rounded border border-border bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted flex-shrink-0" />
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className="px-3 py-2 rounded border border-border bg-surface text-primary text-sm"
          >
            {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <LoadingState message="Loading catalogue..." />
      ) : games.length === 0 ? (
        <div className="text-center py-16 text-muted">
          No games found. Try a different search.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {games.map(game => {
              const img = imageFor(game);
              const name = game.display_name || game.name;
              return (
                <div key={game.id} className="rounded-lg border border-border bg-surface overflow-hidden hover:border-neon-cyan/60 transition-colors flex flex-col">
                  <Link
                    to={`/games/${game.id}?from=${encodeURIComponent(slug)}`}
                    className="no-underline block"
                  >
                    <div className="relative h-24 bg-deep border-b border-border">
                      {img ? (
                        <img src={img} alt={name} className="absolute inset-0 w-full h-full object-cover opacity-80" loading="lazy" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-muted text-[10px]">No image</div>
                      )}
                      <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/50 to-transparent" />
                    </div>
                    <div className="p-2">
                      <div className="font-display font-semibold text-sm text-primary truncate">{name}</div>
                      <div className="text-[10px] text-muted truncate">
                        {game.manufacturer || 'Unknown'}{game.year ? ` · ${game.year}` : ''}
                      </div>
                    </div>
                  </Link>
                  <div className="px-2 pb-2 mt-auto">
                    <button
                      onClick={() => onSubmitGame(game)}
                      className="flex items-center justify-center gap-1 w-full py-1.5 text-xs rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10 cursor-pointer"
                    >
                      <Upload className="w-3 h-3" />
                      Submit Score
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {hasMore && (
            <div className="mt-4 flex justify-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-5 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50 cursor-pointer"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
