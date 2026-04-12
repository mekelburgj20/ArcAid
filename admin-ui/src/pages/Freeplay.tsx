import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Search, Upload, Camera, Trash2, X, Filter } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

interface CatalogueGame {
  id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  local_image_path: string | null;
  wheel_image_path: string | null;
  image_url: string | null;
  platforms: string;
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

export default function Freeplay() {
  const { slug } = useParams<{ slug: string }>();
  const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
  const [roomId, setRoomId] = useState<string | null>(null);

  // Resolve roomId from slug via portal endpoint (same pattern as Scoreboard)
  useEffect(() => {
    if (!slug) return;
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.roomId) setRoomId(data.roomId); })
      .catch(() => {});
  }, [slug]);
  const [games, setGames] = useState<CatalogueGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [submitGame, setSubmitGame] = useState<CatalogueGame | null>(null);

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

  const handleSubmitClick = (game: CatalogueGame) => {
    if (!playerToken) {
      loginWithDiscord(slug || '', `/${slug}/freeplay`);
      return;
    }
    setSubmitGame(game);
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-6">
      <h2 className="font-display text-xl font-bold mb-1">Freeplay</h2>
      <p className="text-sm text-muted mb-4">
        Submit a score for any game in the catalogue — no active tournament required.
      </p>

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
                  <div className="relative h-24 bg-deep border-b border-border">
                    {img ? (
                      <img src={img} alt={name} className="absolute inset-0 w-full h-full object-cover opacity-80" loading="lazy" />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-muted text-[10px]">No image</div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/50 to-transparent" />
                  </div>
                  <div className="p-2 flex-1 flex flex-col justify-between gap-1">
                    <div>
                      <div className="font-display font-semibold text-sm text-primary truncate">{name}</div>
                      <div className="text-[10px] text-muted truncate">
                        {game.manufacturer || 'Unknown'}{game.year ? ` · ${game.year}` : ''}
                      </div>
                    </div>
                    <button
                      onClick={() => handleSubmitClick(game)}
                      className="mt-1 flex items-center justify-center gap-1 w-full py-1.5 text-xs rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10"
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
                className="px-5 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
              >
                {loadingMore ? 'Loading...' : 'Load More'}
              </button>
            </div>
          )}
        </>
      )}

      {submitGame && playerToken && roomId && (
        <FreeplaySubmitModal
          game={submitGame}
          roomId={roomId}
          playerToken={playerToken}
          discordUsername={discordUser?.username}
          onClose={() => setSubmitGame(null)}
          onSubmitted={() => setSubmitGame(null)}
        />
      )}
    </div>
  );
}

function FreeplaySubmitModal({ game, roomId, playerToken, discordUsername, onClose, onSubmitted }: {
  game: CatalogueGame;
  roomId: string;
  playerToken: string;
  discordUsername?: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [username, setUsername] = useState(discordUsername || localStorage.getItem('arcaid-player-name') || '');
  const [score, setScore] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backdropMouseDown = useRef(false);

  useEffect(() => {
    return () => { if (photoPreview) URL.revokeObjectURL(photoPreview); };
  }, [photoPreview]);

  const displayName = game.display_name || game.name;

  const handleSubmit = async () => {
    const trimmedName = username.trim();
    const scoreNum = parseInt(score.replace(/[^0-9]/g, ''), 10);
    if (!trimmedName) { setMessage({ text: 'Enter your name.', type: 'error' }); return; }
    if (!Number.isFinite(scoreNum) || scoreNum <= 0) { setMessage({ text: 'Enter a valid score.', type: 'error' }); return; }
    if (!photoFile) { setMessage({ text: 'A photo is required for freeplay submissions.', type: 'error' }); return; }

    setSubmitting(true);
    setMessage(null);
    try {
      const formData = new FormData();
      formData.append('globalGameId', game.id);
      formData.append('username', trimmedName);
      formData.append('score', String(scoreNum));
      formData.append('photo', photoFile);
      if (excludeFromGlobal) formData.append('excludeGlobal', 'true');

      const res = await fetch(`/api/rooms/${roomId}/freeplay-score`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Submission failed' }));
        throw new Error(err.error || 'Submission failed');
      }
      localStorage.setItem('arcaid-player-name', trimmedName);
      setMessage({ text: 'Score submitted!', type: 'success' });
      setTimeout(() => onSubmitted(), 900);
    } catch (err) {
      setMessage({ text: err instanceof Error ? err.message : 'Submission failed', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
      onMouseUp={e => { if (backdropMouseDown.current && e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <button onClick={onClose} className="absolute top-3 right-3 text-muted hover:text-primary" aria-label="Close">
          <X className="w-5 h-5" />
        </button>

        <h2 className="font-display text-xl font-bold mb-1 pr-8">Submit Freeplay Score</h2>
        <div className="text-sm text-muted mb-4">
          {displayName}
          {game.manufacturer ? ` · ${game.manufacturer}` : ''}
          {game.year ? ` · ${game.year}` : ''}
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-muted mb-1">Player name</label>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              maxLength={100}
              placeholder="Your name"
              className="w-full px-3 py-2 rounded border border-border bg-deep text-primary focus:outline-none focus:border-neon-cyan"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Score</label>
            <input
              type="text"
              inputMode="numeric"
              value={score}
              onChange={e => setScore(e.target.value)}
              placeholder="1,000,000"
              className="w-full px-3 py-2 rounded border border-border bg-deep text-primary font-mono focus:outline-none focus:border-neon-cyan"
            />
          </div>

          <div>
            <label className="block text-xs text-muted mb-1">Photo proof <span className="text-neon-amber">(required)</span></label>
            {photoPreview ? (
              <div className="relative rounded border border-border overflow-hidden">
                <img src={photoPreview} alt="Score proof" className="w-full h-48 object-cover" />
                <button
                  onClick={() => { if (photoPreview) URL.revokeObjectURL(photoPreview); setPhotoFile(null); setPhotoPreview(null); }}
                  className="absolute top-2 right-2 p-1.5 rounded bg-black/70 text-white hover:bg-black"
                  aria-label="Remove photo"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 py-8 rounded border border-dashed border-border text-muted hover:border-neon-cyan hover:text-neon-cyan"
              >
                <Camera className="w-5 h-5" />
                Upload or take photo
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (photoPreview) URL.revokeObjectURL(photoPreview);
                setPhotoFile(file);
                setPhotoPreview(URL.createObjectURL(file));
              }}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={excludeFromGlobal}
              onChange={e => setExcludeFromGlobal(e.target.checked)}
              className="rounded border-border"
            />
            Don't post this score to the global ArcAid scoreboard
          </label>

          {message && (
            <div className={`text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>
              {message.text}
            </div>
          )}

          <NeonButton onClick={handleSubmit} disabled={submitting} className="w-full">
            {submitting ? 'Submitting...' : 'Submit Score'}
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
