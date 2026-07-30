import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Search, Trophy, Upload, Filter, Medal } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { PlayerAvatar, playerName } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import SubmissionSheet from '../components/SubmissionSheet';
import RoomTag from '../components/RoomTag';
import UserMenu from '../components/UserMenu';
import LoginButtons from '../components/LoginButtons';
import GlobalThemeToggle from '../components/GlobalThemeToggle';
import BrandWordmark from '../components/BrandWordmark';
import { formatScore } from '../lib/format';
import { catalogueImageFor } from '../lib/catalogueImage';
import { PLATFORM_GROUPS, getPlatformShortLabel } from '../lib/platforms';

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
  /** Retained: still drives the "Top rated" sort. No longer rendered on cards
   *  (v2.50.0 removed the StarRating row); GlobalGameDetail still shows stars. */
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

/** v2.50.0 (A2): cards render the top 6 only. The API still returns 10 per
 *  game — deliberately left alone this release, so the extra rows are simply
 *  not rendered rather than the payload being narrowed. */
const CARD_ROWS = 6;

/** Sort pills replace the old <select>. Order and labels follow the design
 *  handoff; `pinned` is deliberately absent — pins are not built yet. */
const SORT_PILLS: Array<[SortMode, string]> = [
  ['popular', 'Popular'],
  ['most_recent', 'Recent activity'],
  ['highest_rated', 'Top rated'],
  ['most_scores', 'Most scores'],
  ['name_asc', 'A–Z'],
];

// S17: platform groups + short labels now come from lib/platforms.ts — this
// page's local copies were the app's THIRD divergent taxonomy, stale since
// the FX-family split (its filter sent retired tokens like 'pinball_fx3'/'vr'
// that match no post-migration-094 catalogue row, so FX games silently
// dropped out of the Virtual Pinball chip). Note one deliberate correction:
// 'atgames' now lives in the Physical group, matching the backend taxonomy.

function parsePlatforms(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export default function GlobalScoreboard() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
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
  /** Subhead "Log in" reveals the provider buttons inline. Provider-agnostic
   *  on purpose — Google is a full IdP, so the copy never says "Discord". */
  const [showSubheadLogin, setShowSubheadLogin] = useState(false);

  // Debounce search input (300ms) so we don't hammer the backend on every keystroke
  useEffect(() => {
    const t = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // Load rooms for the scope filter
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

  const buildQuery = useCallback((offset: number): string => {
    const params = new URLSearchParams({
      sort,
      scope,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (search) params.set('search', search);
    if (platformGroup !== 'all') {
      // A0 #9: PLATFORM_GROUPS is keyed by id (physical/vpin/video); the chip
      // state stores the KEY, never the human label.
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

  const handleGoogleLogin = () => {
    loginWithGoogle('__global__', '/scoreboard');
  };

  const handleSubmitClick = (game: TopGame) => {
    if (!playerToken) {
      // Unchanged from pre-v2.50.0: submitting while logged out kicks straight
      // into the OAuth redirect rather than revealing the (off-screen) subhead
      // buttons. Provider choice for this path is a separate concern.
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
            <BrandWordmark />
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
            {/* v2.50.0 (A1): per-visitor light/dark, left of the login/user area. */}
            <GlobalThemeToggle />
            {discordUser ? (
              /* v2.2.6: shared UserMenu so My Rooms / Friends are reachable here too. */
              <UserMenu user={discordUser} onLogout={logoutPlayer} />
            ) : (
              /* v2.2.7: shared Discord-brand Login button, matches PublicLayout. v2.35.0: + Google. */
              <LoginButtons onDiscordLogin={handleLogin} onGoogleLogin={handleGoogleLogin} />
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
        {/* A0 #2/#3: provider-agnostic copy, "Arcaid" casing. */}
        <p className="text-muted mb-2 text-[12.5px]">
          High scores from every Arcaid room.{' '}
          {playerToken ? null : (
            <>
              <button
                type="button"
                onClick={() => setShowSubheadLogin(v => !v)}
                className="text-neon-cyan underline underline-offset-2 hover:brightness-110"
              >
                Log in
              </button>
              {' to submit your own scores.'}
            </>
          )}
        </p>
        {showSubheadLogin && !playerToken && (
          <LoginButtons
            className="mb-6"
            onDiscordLogin={handleLogin}
            onGoogleLogin={handleGoogleLogin}
          />
        )}
        {!showSubheadLogin && <div className="mb-6" />}

        {/* Search + room scope */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <div className="flex-1 relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="w-full pl-10 pr-3 py-2 rounded-lg border border-border bg-surface text-primary placeholder:text-muted focus:outline-none focus:border-neon-cyan"
            />
          </div>
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

        {/* Platform group chips (left) + sort pills (right) */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-4 h-4 text-muted" />
            {[['all', 'All platforms'], ...Object.entries(PLATFORM_GROUPS).map(([k, v]) => [k, v.label])].map(([k, label]) => (
              <button
                key={k}
                onClick={() => setPlatformGroup(k)}
                aria-pressed={platformGroup === k}
                className={`px-3 py-1 text-[10px] rounded-full border ${
                  platformGroup === k
                    ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                    : 'border-border text-muted hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Narrow screens scroll this row horizontally rather than wrapping —
              wrapping put "Recent activity"/"Most scores" onto two lines each
              and turned one control into a four-line block (handoff: "Sort pills
              become a horizontally scrollable row on narrow screens"). */}
          <div className="flex items-center gap-1 self-start lg:self-auto rounded-md border border-border bg-surface p-[3px] max-w-full overflow-x-auto scrollbar-thin">
            {SORT_PILLS.map(([value, label]) => (
              <button
                key={value}
                onClick={() => setSort(value)}
                aria-pressed={sort === value}
                className={`shrink-0 whitespace-nowrap px-2.5 py-[5px] text-[11px] rounded-[3px] transition-colors ${
                  sort === value
                    ? 'bg-neon-cyan/20 text-neon-cyan font-semibold'
                    : 'text-muted font-medium hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
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
            {/* A0 #12: no grid-auto-rows — row height is content-driven and
                cards stretch to match the tallest in their row. */}
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3.5 items-stretch">
              {games.map(game => (
                <GameCard
                  key={game.global_game_id}
                  game={game}
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

      {/* Sprint 10 — SubmissionSheet handles the global submit flow. Login
          already required upstream (handleSubmitClick reveals the providers). */}
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

/**
 * Per-rank row tint/border + medal color. Every value is an A1 `--sb-*` /
 * `--color-medal-*` token so the card works under both polarities — never a
 * literal rgba(). Ranks 4+ have no entry (transparent row, `#n` rank cell).
 */
const RANK_TINTS: Record<number, { bg: string; border: string; medal: string; label: string }> = {
  1: { bg: 'var(--sb-row-gold-bg)', border: 'var(--sb-row-gold-border)', medal: 'text-neon-amber', label: '1st place' },
  2: { bg: 'var(--sb-row-silver-bg)', border: 'var(--sb-row-silver-border)', medal: 'text-medal-silver', label: '2nd place' },
  3: { bg: 'var(--sb-row-bronze-bg)', border: 'var(--sb-row-bronze-border)', medal: 'text-medal-bronze', label: '3rd place' },
};

function LeaderboardRow({ entry, rank }: { entry: TopScoreEntry; rank: number }) {
  const tint = RANK_TINTS[rank];
  const name = playerName(entry);
  const abbreviated = formatScore(entry.score);

  return (
    <div
      className="flex items-center gap-2 rounded-[5px] border px-2 py-[5px]"
      style={{ background: tint?.bg ?? 'transparent', borderColor: tint?.border ?? 'transparent' }}
    >
      <span className="flex w-5 shrink-0 items-center justify-center">
        {tint ? (
          <Medal className={`w-3 h-3 ${tint.medal}`} aria-label={tint.label} />
        ) : (
          <span className="font-mono text-[10px] font-bold text-muted">#{rank}</span>
        )}
      </span>
      <PlayerAvatar
        username={name}
        discordUserId={entry.discord_user_id}
        avatarHash={entry.avatar_hash}
        size={18}
      />
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{name}</span>
      {entry.origin_room_slug && (
        <RoomTag
          shortTag={entry.origin_room_short_tag || entry.origin_room_slug}
          size={16}
          logoUrl={entry.origin_room_logo_url}
          href={`/scoreboard?room=${encodeURIComponent(entry.origin_room_slug)}`}
          title={`Filter to ${entry.origin_room_short_tag || entry.origin_room_slug}`}
        />
      )}
      <span
        className={`shrink-0 font-mono text-[11px] font-bold ${rank === 1 ? 'text-neon-amber' : 'text-primary'}`}
        title={abbreviated.endsWith('T') ? entry.score.toLocaleString() : undefined}
      >
        {abbreviated}
      </span>
    </div>
  );
}

/**
 * v2.50.0 (A2) — art-first card. Structure: art block (110px) with the title
 * on a scrim, then ranks 1-6, then a footer with the score count and a solid
 * Submit. No podium, no placeholder rows, no star row.
 */
function GameCard({ game, onSubmit }: { game: TopGame; onSubmit: () => void }) {
  const img = catalogueImageFor(game);
  const displayName = game.display_name || game.name;
  const rows = (game.top_scores || []).slice(0, CARD_ROWS);
  const platforms = parsePlatforms(game.platforms);
  const primaryPlatform = platforms[0];

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-surface transition-colors duration-150 hover:border-[var(--sb-card-hover-border)]">
      {/* 1. Art block — the whole thing links to the game detail page. */}
      <Link
        to={`/games/${game.global_game_id}`}
        className="relative block h-[110px] shrink-0 no-underline"
      >
        {img ? (
          <img
            src={img}
            alt=""
            loading="lazy"
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center bg-deep text-[11px] text-muted">
            No image
          </div>
        )}
        <div className="absolute inset-0" style={{ background: 'var(--sb-art-scrim)' }} />
        {primaryPlatform && (
          /* One pill only (design: the full list lives on the detail page). */
          <span
            className="absolute right-1.5 top-1.5 rounded-[3px] border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.4px] text-neon-cyan"
            style={{ background: 'var(--sb-pill-bg)', borderColor: 'var(--sb-pill-border)' }}
            title={platforms.map(getPlatformShortLabel).join(' · ')}
          >
            {getPlatformShortLabel(primaryPlatform)}
          </span>
        )}
        <div className="absolute inset-x-2.5 bottom-1.5">
          <h3
            className="font-display text-[13px] font-bold leading-[1.15] [text-wrap:pretty]"
            style={{ color: 'var(--sb-art-title)', textShadow: 'var(--sb-title-shadow)' }}
          >
            {displayName}
          </h3>
          <div className="mt-px text-[9.5px]" style={{ color: 'var(--sb-art-meta)' }}>
            {game.manufacturer || 'Unknown'}{game.year ? ` · ${game.year}` : ''}
          </div>
        </div>
      </Link>

      {/* 2. Leaderboard — exactly as many rows as there are scores, max 6.
             3. Empty state — dashed "Claim 1st" CTA, no placeholder podium. */}
      <div className="flex-1 px-3 py-2.5">
        {rows.length > 0 ? (
          <div className="space-y-0.5">
            {rows.map((entry, i) => (
              <LeaderboardRow
                key={`${entry.discord_user_id}-${entry.iscored_username}`}
                entry={entry}
                rank={i + 1}
              />
            ))}
          </div>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            className="w-full rounded-md border border-dashed border-neon-cyan/35 px-1 py-2 text-[11px] text-neon-cyan hover:bg-neon-cyan/10 transition-colors"
          >
            Claim 1st →
          </button>
        )}
      </div>

      {/* 4. Footer */}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 px-3 py-[7px]">
        <span className="text-[10px] text-muted">
          {game.score_count.toLocaleString()} {game.score_count === 1 ? 'score' : 'scores'}
        </span>
        <button
          type="button"
          onClick={onSubmit}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-neon-cyan px-2.5 py-1 text-[10px] font-bold text-deep transition hover:brightness-110"
          title="Submit your score"
        >
          <Upload className="w-3 h-3" />
          Submit
        </button>
      </div>
    </div>
  );
}
