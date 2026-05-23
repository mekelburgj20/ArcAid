import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Trophy, Upload, Filter } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import SubmissionSheet from '../components/SubmissionSheet';
import StarRating from '../components/StarRating';
import RoomTag from '../components/RoomTag';
import UserMenu from '../components/UserMenu';
import DiscordLoginButton from '../components/DiscordLoginButton';

interface TopScoreEntry {
  iscored_username: string;
  /** v2.8.0: user-chosen global display name. Renders in place of iscored_username when set. */
  display_name?: string | null;
  score: number;
  avatar_hash: string | null;
  discord_user_id: string;
  origin_room_slug: string | null;
  origin_room_logo_url: string | null;
  /** Sprint 13 — admin-set short label; falls back to slug-derived when null. */
  origin_room_short_tag: string | null;
}

interface TopGame {
  global_game_id: string;
  name: string;
  display_name: string | null;
  manufacturer: string | null;
  year: number | null;
  type: string;
  image_url: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  platforms: string; // JSON string
  score_count: number;
  top_score: number | null;
  last_submitted_at: string | null;
  avg_rating: number;
  rating_count: number;
  top_scores: TopScoreEntry[];
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

type SortMode = 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc';

const PAGE_SIZE = 30;

const PLATFORM_GROUPS: Record<string, { label: string; platforms: string[] }> = {
  physical: { label: 'Physical', platforms: ['real'] },
  vpin: { label: 'Virtual Pinball', platforms: ['vpx', 'vp9', 'vpxs', 'fp', 'bam', 'pinball_fx', 'pinball_fx3', 'atgames', 'vr'] },
  video: { label: 'Arcade & Video', platforms: ['arcade', 'nes', 'snes', 'genesis', 'saturn', 'n64', 'ps1', 'ps2', 'dreamcast', 'gba', 'gb', 'gbc', 'sms', 'sega_cd', 'game_gear', 'tg16', 'atari_2600', 'atari_7800', 'jaguar', '3do', 'switch', 'wii', 'pc'] },
};

/* Short display labels for platform IDs */
const PLATFORM_LABELS: Record<string, string> = {
  real: 'Real', atgames: 'AtGames', atgames_hd: 'AtGames HD', atgames_4k: 'AtGames 4K',
  vpx: 'VPX', vp9: 'VP9', vpxs: 'VPXS', fp: 'Future Pinball', bam: 'BAM',
  pinball_fx: 'Pinball FX', pinball_fx3: 'Pinball FX3', vr: 'VR',
  arcade: 'Arcade', nes: 'NES', snes: 'SNES', genesis: 'Genesis', saturn: 'Saturn',
  n64: 'N64', ps1: 'PS1', ps2: 'PS2', dreamcast: 'Dreamcast',
  gba: 'GBA', gb: 'Game Boy', gbc: 'GBC', sms: 'SMS', sega_cd: 'Sega CD',
  game_gear: 'Game Gear', tg16: 'TG-16', atari_2600: 'Atari 2600', atari_7800: 'Atari 7800',
  jaguar: 'Jaguar', '3do': '3DO', switch: 'Switch', wii: 'Wii', pc: 'PC',
};

function parsePlatforms(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function formatScore(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  return n.toLocaleString();
}

function toCatalogueUrl(path: string): string {
  // Absolute URLs pass through unchanged
  if (/^https?:\/\//i.test(path)) return path;
  // DB stores filesystem paths like "data/catalogue-images/opdb/foo.jpg".
  // The server mounts the catalogue-images directory at /api/catalogue-images/.
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function imageFor(game: TopGame): string | null {
  if (game.local_image_path) return toCatalogueUrl(game.local_image_path);
  if (game.wheel_image_path) return toCatalogueUrl(game.wheel_image_path);
  if (game.image_url) return game.image_url;
  return null;
}

export default function GlobalScoreboard() {
  const { discordUser, playerToken, loginWithDiscord, logoutPlayer } = useViewerAuth();
  const [games, setGames] = useState<TopGame[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sort, setSort] = useState<SortMode>('popular');
  const [scope, setScope] = useState<string>('global'); // 'global' or a roomId
  const [platformGroup, setPlatformGroup] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState(''); // debounced value actually sent to API
  const [rooms, setRooms] = useState<Room[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [submitGame, setSubmitGame] = useState<TopGame | null>(null);
  const [toast, setToast] = useState<{ player: string; game: string; score: number } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [userRatings, setUserRatings] = useState<Record<string, number>>({});

  // Debounce search input (300ms) so we don't hammer the backend on every keystroke
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // Load rooms for the scope filter, and bulk user ratings
  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.ok ? r.json() : [])
      .then((data: Room[]) => setRooms((data || []).filter(r => r.is_public)))
      .catch(() => {});
  }, []);

  // Sprint 12 — sync scope with ?room=<slug>. When the URL names a slug that
  // resolves to a known room, scope points at that room's id; otherwise fall
  // back to global. Scope changes push back onto the URL for shareability.
  useEffect(() => {
    const slug = searchParams.get('room');
    if (!slug) {
      if (scope !== 'global') setScope('global');
      return;
    }
    if (rooms.length === 0) return; // wait for rooms to load
    const match = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
    if (match && scope !== match.id) setScope(match.id);
  }, [searchParams, rooms]);

  const setScopeFromSlug = (slug: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (slug) next.set('room', slug);
    else next.delete('room');
    setSearchParams(next, { replace: true });
  };
  const setScopeToRoomId = (roomId: string) => {
    const room = rooms.find(r => r.id === roomId);
    if (!room) { setScope(roomId); return; }
    setScopeFromSlug(room.slug);
  };

  // Fetch user's own ratings (needs token)
  useEffect(() => {
    const headers: HeadersInit = {};
    if (playerToken) headers['Authorization'] = `Bearer ${playerToken}`;
    fetch('/api/global/ratings', { headers })
      .then(r => r.ok ? r.json() : { userRatings: {} })
      .then(data => setUserRatings(data.userRatings || {}))
      .catch(() => {});
  }, [playerToken]);

  const handleRate = async (gameId: string, rating: number) => {
    if (!playerToken) return;
    try {
      const res = await fetch(`/api/global/games/${gameId}/rating`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify({ rating }),
      });
      if (res.ok) {
        const info = await res.json();
        setUserRatings(prev => ({ ...prev, [gameId]: rating }));
        setGames(prev => prev.map(g =>
          g.global_game_id === gameId
            ? { ...g, avg_rating: info.avg_rating, rating_count: info.rating_count }
            : g
        ));
      }
    } catch { /* silent */ }
  };

  const buildQuery = useCallback((offset: number): string => {
    const params = new URLSearchParams({
      sort,
      scope,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (search) params.set('search', search);
    if (platformGroup !== 'all') {
      const plats = PLATFORM_GROUPS[platformGroup]?.platforms || [];
      if (plats.length > 0) params.set('platforms', plats.join(','));
    }
    return params.toString();
  }, [sort, scope, search, platformGroup]);

  // Load first page whenever filters change
  useEffect(() => {
    setLoading(true);
    fetch(`/api/global/scoreboard?${buildQuery(0)}`)
      .then(r => r.ok ? r.json() : { data: [], total: 0, hasMore: false })
      .then(payload => {
        setGames(payload.data || []);
        setTotal(payload.total || 0);
        setHasMore(Boolean(payload.hasMore));
      })
      .catch(() => {
        setGames([]);
        setTotal(0);
        setHasMore(false);
      })
      .finally(() => setLoading(false));
  }, [buildQuery]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetch(`/api/global/scoreboard?${buildQuery(games.length)}`)
      .then(r => r.ok ? r.json() : { data: [], hasMore: false })
      .then(payload => {
        setGames(prev => [...prev, ...(payload.data || [])]);
        setHasMore(Boolean(payload.hasMore));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [buildQuery, games.length, hasMore, loadingMore]);

  // WebSocket — show a toast and bump the matching card's stats optimistically
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: { globalGameId: string; gameName: string; playerName: string; score: number }) => {
      setToast({ player: data.playerName, game: data.gameName, score: data.score });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);

      setGames(prev => prev.map(g => g.global_game_id === data.globalGameId
        ? { ...g, score_count: g.score_count + 1, top_score: Math.max(g.top_score || 0, data.score), last_submitted_at: new Date().toISOString() }
        : g));
    };
    socket.on('score:new:global', handler);
    return () => {
      socket.off('score:new:global', handler);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleLogin = () => {
    loginWithDiscord('__global__', '/scoreboard');
  };

  const handleSubmitClick = (game: TopGame) => {
    if (!playerToken) {
      handleLogin();
      return;
    }
    setSubmitGame(game);
  };

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="px-4 sm:px-6 lg:px-10 py-4 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-3 no-underline">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-10 h-10" />
            <span className="font-pixel text-neon-cyan text-sm tracking-wider">ARCAID</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/" className="text-xs text-muted hover:text-neon-cyan no-underline hidden sm:inline">
              Rooms
            </Link>
            {localStorage.getItem('arcaid_token') && (
              <Link to="/admin" className="text-xs text-muted hover:text-neon-amber no-underline hidden sm:inline">
                Admin
              </Link>
            )}
            {discordUser ? (
              /* v2.2.6: shared UserMenu so My Rooms / Friends are reachable here too. */
              <UserMenu user={discordUser} onLogout={logoutPlayer} />
            ) : (
              /* v2.2.7: shared Discord-brand Login button, matches PublicLayout. */
              <DiscordLoginButton onClick={handleLogin} />
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 sm:px-6 lg:px-10 py-10">
        <div className="flex items-center gap-3 mb-2">
          <Trophy className="w-6 h-6 text-neon-cyan" />
          <h1 className="font-display text-3xl font-bold">Global Scoreboard</h1>
        </div>
        <p className="text-muted mb-8">
          High scores from every ArcAid room, all in one place. Submit your own scores with Discord login.
        </p>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="w-full pl-10 pr-3 py-2 rounded border border-border bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortMode)}
            className="px-3 py-2 rounded border border-border bg-surface text-primary text-sm"
          >
            <option value="popular">Popular</option>
            <option value="most_scores">Most scores</option>
            <option value="highest_rated">Highest rated</option>
            <option value="most_recent">Most recent</option>
            <option value="name_asc">Name (A–Z)</option>
          </select>
          <select
            value={scope}
            onChange={e => {
              if (e.target.value === 'global') setScopeFromSlug(null);
              else setScopeToRoomId(e.target.value);
            }}
            className="px-3 py-2 rounded border border-border bg-surface text-primary text-sm"
          >
            <option value="global">All rooms (global)</option>
            {rooms.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>

        {/* Platform group chips */}
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <Filter className="w-4 h-4 text-muted" />
          {[['all', 'All platforms'], ...Object.entries(PLATFORM_GROUPS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
            <button
              key={k}
              onClick={() => setPlatformGroup(k)}
              className={`px-3 py-1 text-xs rounded-full border ${
                platformGroup === k
                  ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                  : 'border-border text-muted hover:text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Results summary */}
        {!loading && (
          <div className="text-xs text-muted mb-4">
            Showing {games.length.toLocaleString()} of {total.toLocaleString()} games
          </div>
        )}

        {/* Game grid */}
        {loading ? (
          <LoadingState message="Loading global scoreboard..." />
        ) : games.length === 0 ? (
          <div className="text-center py-16 text-muted">
            No games found. Try adjusting your filters.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
              {games.map(game => (
                <GameCard
                  key={game.global_game_id}
                  game={game}
                  userRating={userRatings[game.global_game_id] || 0}
                  loggedIn={!!playerToken}
                  onRate={(r) => handleRate(game.global_game_id, r)}
                  onSubmit={() => handleSubmitClick(game)}
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-6 flex justify-center">
                <button
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-5 py-2 rounded border border-neon-cyan/40 text-sm text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50"
                >
                  {loadingMore ? 'Loading...' : `Load More (${(total - games.length).toLocaleString()} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Score toast */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-surface border border-neon-cyan px-5 py-3 rounded shadow-lg z-30 animate-slide-down">
          <div className="text-xs text-muted">New global score</div>
          <div className="font-display text-sm">
            <span className="text-neon-cyan">{toast.player}</span>
            {' scored '}
            <span className="font-mono">{formatScore(toast.score)}</span>
            {' on '}
            <span className="font-semibold">{toast.game}</span>
          </div>
        </div>
      )}

      {/* Sprint 10 — SubmissionSheet handles the global submit flow. Discord auth
          already required upstream (handleSubmitClick short-circuits to login). */}
      {submitGame && playerToken && (
        <SubmissionSheet
          target={{
            kind: 'global',
            globalGameId: submitGame.global_game_id,
            gameName: submitGame.display_name || submitGame.name,
          }}
          onClose={() => setSubmitGame(null)}
          onSubmitted={() => {
            setSubmitGame(null);
            const params = new URLSearchParams({ sort, scope, limit: '60' });
            fetch(`/api/global/scoreboard?${params}`)
              .then(r => r.ok ? r.json() : { data: [] })
              .then(payload => setGames(payload.data || []))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}

/* ── Podium rank colors (Tailwind classes) ── */
const RANK_STYLES: Record<number, { bg: string; border: string; rank: string; score: string; label: string }> = {
  1: { bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', rank: 'text-yellow-400', score: 'text-yellow-300', label: '1st' },
  2: { bg: 'bg-gray-300/10', border: 'border-gray-400/30', rank: 'text-gray-300', score: 'text-gray-200', label: '2nd' },
  3: { bg: 'bg-amber-700/10', border: 'border-amber-600/30', rank: 'text-amber-500', score: 'text-amber-400', label: '3rd' },
};

function PodiumSlot({ entry, rank, large }: { entry?: TopScoreEntry; rank: number; large?: boolean }) {
  const s = RANK_STYLES[rank] || RANK_STYLES[3];
  const avatarSize = large ? 26 : 20;
  return (
    <div className={`flex-1 min-w-0 rounded-lg border ${s.border} ${s.bg} flex flex-col items-center justify-center gap-0.5 ${large ? 'py-2.5 px-1.5' : 'py-1.5 px-1'}`}>
      <span className={`text-[10px] font-bold ${s.rank}`}>{s.label}</span>
      {entry ? (
        <>
          <div className="flex items-center gap-1 max-w-full">
            <PlayerAvatar
              username={entry.display_name || entry.iscored_username}
              discordUserId={entry.discord_user_id}
              avatarHash={entry.avatar_hash}
              size={avatarSize}
            />
            <span className={`font-semibold truncate ${large ? 'text-xs' : 'text-[11px]'}`}>
              {entry.display_name || entry.iscored_username}
            </span>
            {entry.origin_room_slug && (
              <RoomTag
                shortTag={entry.origin_room_short_tag || entry.origin_room_slug}
                size={16}
                logoUrl={entry.origin_room_logo_url}
                href={`/scoreboard?room=${encodeURIComponent(entry.origin_room_slug)}`}
                title={`Filter to ${entry.origin_room_short_tag || entry.origin_room_slug}`}
              />
            )}
          </div>
          <span
            className={`font-mono font-bold ${s.score} ${large ? 'text-xs' : 'text-[11px]'}`}
            title={entry.score >= 1e12 ? entry.score.toLocaleString() : undefined}
          >
            {formatScore(entry.score)}
          </span>
        </>
      ) : (
        <span className="text-[11px] text-muted/30 italic">—</span>
      )}
    </div>
  );
}

function GameCard({ game, userRating, loggedIn, onRate, onSubmit }: {
  game: TopGame;
  userRating: number;
  loggedIn: boolean;
  onRate: (rating: number) => void;
  onSubmit: () => void;
}) {
  const img = imageFor(game);
  const displayName = game.display_name || game.name;
  const scores = game.top_scores || [];
  const podium = [scores[0], scores[1], scores[2]]; // always 3 slots
  const list = scores.slice(3, 10); // 4th–10th

  return (
    <div className="group relative rounded-xl border border-border bg-surface overflow-hidden hover:border-neon-cyan/60 transition-colors flex flex-col">
      {/* Game title — top of card, centered */}
      <Link to={`/games/${game.global_game_id}`} className="block no-underline">
        <div className="px-3 pt-3 pb-1 text-center">
          <h3 className="font-display font-bold text-xl leading-tight text-primary line-clamp-2">{displayName}</h3>
          <div className="text-sm text-muted/80 mt-0.5">
            {game.manufacturer || 'Unknown'}
            {game.year ? ` · ${game.year}` : ''}
            {game.score_count > 0 && ` · ${game.score_count} score${game.score_count !== 1 ? 's' : ''}`}
          </div>
        </div>
      </Link>

      {/* Game image */}
      <Link to={`/games/${game.global_game_id}`} className="block no-underline">
        <div className="relative h-28 bg-deep mx-3 rounded-lg overflow-hidden">
          {img ? (
            <img src={img} alt={displayName} className="absolute inset-0 w-full h-full object-cover opacity-70" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">No image</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-surface/40 to-transparent" />
        </div>
      </Link>

      {/* Podium — always shows all 3 slots */}
      <div className="px-3 pt-2 pb-1">
        <div className="flex justify-center mb-1.5">
          <div className="w-[60%] min-w-[100px]">
            <PodiumSlot entry={podium[0]} rank={1} large />
          </div>
        </div>
        <div className="flex gap-1.5">
          <PodiumSlot entry={podium[1]} rank={2} />
          <PodiumSlot entry={podium[2]} rank={3} />
        </div>
      </div>

      {/* 4th–10th in a list */}
      <div className="px-3 pt-1 pb-1 flex-1">
        {list.length > 0 ? (
          <div className="border-t border-border/40 pt-1.5 space-y-0.5">
            {list.map((e, i) => (
              <div key={e.discord_user_id + e.iscored_username} className="flex items-center gap-1.5 text-[11px]">
                <span className="text-muted w-4 text-right font-mono">{i + 4}.</span>
                <PlayerAvatar
                  username={e.display_name || e.iscored_username}
                  discordUserId={e.discord_user_id}
                  avatarHash={e.avatar_hash}
                  size={16}
                />
                <span className="truncate flex-1">{e.display_name || e.iscored_username}</span>
                {e.origin_room_slug && (
                  <RoomTag
                    shortTag={e.origin_room_short_tag || e.origin_room_slug}
                    size={16}
                    logoUrl={e.origin_room_logo_url}
                    href={`/scoreboard?room=${encodeURIComponent(e.origin_room_slug)}`}
                    title={`Filter to ${e.origin_room_short_tag || e.origin_room_slug}`}
                  />
                )}
                <span className="font-mono text-muted">{formatScore(e.score)}</span>
              </div>
            ))}
          </div>
        ) : (
          !podium[0] && (
            <div className="text-center py-2 text-muted text-[11px] italic">
              No scores yet
            </div>
          )
        )}
      </div>

      {/* Footer: rating (left) + platforms (center) + submit (right) — pinned to bottom */}
      <div className="px-3 pb-2.5 pt-1.5 flex items-center justify-between gap-2 border-t border-border/30 mt-auto">
        <div className="flex items-center gap-1.5 shrink-0">
          <StarRating
            rating={userRating || Math.round(game.avg_rating)}
            onRate={loggedIn ? onRate : undefined}
            size="sm"
          />
          {game.rating_count > 0 && (
            <span className="text-[10px] text-muted">
              {game.avg_rating.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap justify-center gap-1 min-w-0">
          {parsePlatforms(game.platforms).map(p => (
            <span key={p} className="px-1.5 py-0.5 text-[9px] rounded bg-border/30 text-muted/80">
              {PLATFORM_LABELS[p] || p}
            </span>
          ))}
        </div>
        <button
          onClick={(e) => { e.preventDefault(); onSubmit(); }}
          className="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10 transition-colors shrink-0"
          title="Submit your score"
        >
          <Upload className="w-3 h-3" />
          Submit
        </button>
      </div>
    </div>
  );
}
