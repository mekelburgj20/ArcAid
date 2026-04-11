import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Trophy, Upload, LogIn, LogOut, Filter } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoadingState from '../components/LoadingState';
import GlobalScoreSubmitModal from '../components/GlobalScoreSubmitModal';

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
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

type SortMode = 'most_scores' | 'highest_score' | 'most_recent';

const PLATFORM_GROUPS: Record<string, { label: string; platforms: string[] }> = {
  physical: { label: 'Physical', platforms: ['real'] },
  vpin: { label: 'Virtual Pinball', platforms: ['vpx', 'vp9', 'vpxs', 'fp', 'bam', 'pinball_fx', 'pinball_fx3', 'atgames', 'atgames_hd', 'atgames_4k', 'vr'] },
  video: { label: 'Arcade & Video', platforms: ['arcade', 'nes', 'snes', 'genesis', 'saturn', 'n64', 'ps1', 'ps2', 'dreamcast', 'gba', 'gb', 'gbc', 'sms', 'sega_cd', 'game_gear', 'tg16', 'atari_2600', 'atari_7800', 'jaguar', '3do', 'switch', 'wii', 'pc'] },
};

function formatScore(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  return n.toLocaleString();
}

function imageFor(game: TopGame): string | null {
  if (game.local_image_path) return game.local_image_path.startsWith('/') ? game.local_image_path : `/${game.local_image_path}`;
  if (game.wheel_image_path) return game.wheel_image_path.startsWith('/') ? game.wheel_image_path : `/${game.wheel_image_path}`;
  if (game.image_url) return game.image_url;
  return null;
}

export default function GlobalScoreboard() {
  const { discordUser, playerToken, loginWithDiscord, logoutPlayer } = useViewerAuth();
  const [games, setGames] = useState<TopGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortMode>('most_scores');
  const [scope, setScope] = useState<string>('global'); // 'global' or a roomId
  const [platformGroup, setPlatformGroup] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [submitGame, setSubmitGame] = useState<TopGame | null>(null);
  const [toast, setToast] = useState<{ player: string; game: string; score: number } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  // Load rooms for the scope filter
  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.ok ? r.json() : [])
      .then((data: Room[]) => setRooms((data || []).filter(r => r.is_public)))
      .catch(() => {});
  }, []);

  // Load scoreboard whenever filters change
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ sort, scope, limit: '60' });
    fetch(`/api/global/scoreboard?${params}`)
      .then(r => r.ok ? r.json() : { data: [] })
      .then(payload => setGames(payload.data || []))
      .catch(() => setGames([]))
      .finally(() => setLoading(false));
  }, [sort, scope]);

  // WebSocket — show a toast and refresh the game row on new global scores
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: { globalGameId: string; gameName: string; playerName: string; score: number }) => {
      setToast({ player: data.playerName, game: data.gameName, score: data.score });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);

      // Bump the row's count/top_score optimistically so the card re-sorts on next fetch
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

  // Client-side platform + search filtering (catalogue search is separate; this filters the loaded top list)
  const filteredGames = useMemo(() => {
    return games.filter(g => {
      if (search) {
        const needle = search.toLowerCase();
        const hay = `${g.name} ${g.display_name || ''} ${g.manufacturer || ''}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      if (platformGroup !== 'all') {
        const allowed = PLATFORM_GROUPS[platformGroup]?.platforms || [];
        try {
          const plats: string[] = JSON.parse(g.platforms || '[]');
          if (!plats.some(p => allowed.includes(p))) return false;
        } catch { /* malformed platforms — skip */ }
      }
      return true;
    });
  }, [games, search, platformGroup]);

  const handleLogin = () => {
    loginWithDiscord('__global__', '/scoreboard');
  };

  const handleSubmitClick = (game: TopGame) => {
    if (!playerToken) {
      // Must be logged in
      handleLogin();
      return;
    }
    setSubmitGame(game);
  };

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-3">
          <Link to="/" className="flex items-center gap-3 no-underline">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-10 h-10" />
            <span className="font-pixel text-neon-cyan text-sm tracking-wider">ARCAID</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/" className="text-xs text-muted hover:text-neon-cyan no-underline hidden sm:inline">
              Rooms
            </Link>
            {discordUser ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted hidden sm:inline">{discordUser.username}</span>
                <button
                  onClick={logoutPlayer}
                  className="flex items-center gap-1 px-3 py-1.5 rounded border border-border text-xs text-muted hover:text-primary hover:border-neon-cyan"
                >
                  <LogOut className="w-3 h-3" />
                  Logout
                </button>
              </div>
            ) : (
              <button
                onClick={handleLogin}
                className="flex items-center gap-1 px-3 py-1.5 rounded border border-neon-cyan/40 text-xs text-neon-cyan hover:bg-neon-cyan/10"
              >
                <LogIn className="w-3 h-3" />
                Login with Discord
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
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
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-10 pr-3 py-2 rounded border border-border bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as SortMode)}
            className="px-3 py-2 rounded border border-border bg-surface text-primary text-sm"
          >
            <option value="most_scores">Most active</option>
            <option value="highest_score">Highest scores</option>
            <option value="most_recent">Most recent</option>
          </select>
          <select
            value={scope}
            onChange={e => setScope(e.target.value)}
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

        {/* Game grid */}
        {loading ? (
          <LoadingState message="Loading global scoreboard..." />
        ) : filteredGames.length === 0 ? (
          <div className="text-center py-16 text-muted">
            No scores found yet. Be the first to submit!
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredGames.map(game => (
              <GameCard
                key={game.global_game_id}
                game={game}
                onSubmit={() => handleSubmitClick(game)}
              />
            ))}
          </div>
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

      {/* Submit modal */}
      {submitGame && playerToken && (
        <GlobalScoreSubmitModal
          game={submitGame}
          playerToken={playerToken}
          onClose={() => setSubmitGame(null)}
          onSubmitted={() => {
            setSubmitGame(null);
            // Refetch scoreboard
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

function GameCard({ game, onSubmit }: { game: TopGame; onSubmit: () => void }) {
  const img = imageFor(game);
  const displayName = game.display_name || game.name;

  return (
    <div className="group relative rounded-lg border border-border bg-surface overflow-hidden hover:border-neon-cyan/60 transition-colors">
      {/* Game image or placeholder */}
      <Link to={`/games/${game.global_game_id}`} className="block no-underline">
        <div className="relative h-32 bg-deep border-b border-border">
          {img ? (
            <img src={img} alt={displayName} className="absolute inset-0 w-full h-full object-cover opacity-80" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-muted text-xs">No image</div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/60 to-transparent" />
        </div>
        {/* Title + meta */}
        <div className="p-3">
          <h3 className="font-display font-semibold text-base text-primary truncate">{displayName}</h3>
          <div className="text-xs text-muted mt-0.5 truncate">
            {game.manufacturer || 'Unknown'}
            {game.year ? ` · ${game.year}` : ''}
          </div>
        </div>
      </Link>

      {/* Stats + CTA */}
      <div className="px-3 pb-3 flex items-center justify-between gap-2">
        <div className="text-xs">
          <div className="text-muted">Top score</div>
          <div className="font-mono font-semibold text-neon-cyan">{formatScore(game.top_score)}</div>
        </div>
        <div className="text-xs">
          <div className="text-muted">Entries</div>
          <div className="font-mono font-semibold">{game.score_count}</div>
        </div>
        <button
          onClick={(e) => { e.preventDefault(); onSubmit(); }}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10"
          title="Submit your score"
        >
          <Upload className="w-3 h-3" />
          Submit
        </button>
      </div>
    </div>
  );
}
