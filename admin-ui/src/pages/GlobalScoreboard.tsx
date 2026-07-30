import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trophy, Upload, Filter, Medal, Pin } from 'lucide-react';
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
import GlobalSearchPalette, { type PaletteGame } from '../components/GlobalSearchPalette';
import PinnedRail, { type PinnedGameChip } from '../components/PinnedRail';
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
  /** v2.52.0 (A4): present on `neighbors` entries only — the card's own rows
   *  derive rank from their index, but a neighbour row can start at any rank. */
  rank?: number;
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
  /** v2.52.0 (A4) — per-viewer context. Present ONLY on authenticated
   *  responses; an anonymous payload omits these keys entirely, so every
   *  consumer must treat `undefined` as "logged out", not as "no rank". */
  is_pinned?: boolean;
  my_rank?: number | null;
  my_score?: number | null;
  /** Ranks my_rank-1 … my_rank+1. Shipped now for A5's density toggle; this
   *  release reads only the entry at `my_rank` (the "YOU" row). */
  neighbors?: TopScoreEntry[];
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

type SortMode = 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned';

const PAGE_SIZE = 30;

/** v2.50.0 (A2): cards render the top 6 only. The API still returns 10 per
 *  game — deliberately left alone this release, so the extra rows are simply
 *  not rendered rather than the payload being narrowed. */
const CARD_ROWS = 6;

/** Sort pills replace the old <select>. Order and labels follow the design
 *  handoff. `Pinned first` leads the list but only exists for authenticated
 *  viewers — the server degrades `sort=pinned` to `popular` anonymously, so a
 *  pill that did nothing would be worse than no pill. */
const SORT_PILLS: Array<[SortMode, string]> = [
  ['popular', 'Popular'],
  ['most_recent', 'Recent activity'],
  ['highest_rated', 'Top rated'],
  ['most_scores', 'Most scores'],
  ['name_asc', 'A–Z'],
];
const PINNED_PILL: [SortMode, string] = ['pinned', 'Pinned first'];

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
  /** A4: authenticated viewers land on `Pinned first`; anonymous stay on
   *  `popular`. `playerToken` is hydrated synchronously from localStorage by
   *  ViewerAuthProvider, so this lazy initialiser sees the real value on the
   *  first render and the page never fetches `popular` then immediately
   *  re-fetches `pinned`. */
  const [sort, setSort] = useState<SortMode>(() => (playerToken ? 'pinned' : 'popular'));
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
  /** A3 — ⌘K palette. Open state lives here because the grid behind dims. */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** A4 — the My Pins rail. Empty for anonymous viewers (never fetched). */
  const [pins, setPins] = useState<PinnedGameChip[]>([]);
  /** A4 — a failed pin toggle surfaces here after the optimistic revert. */
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorTimerRef = useRef<number | null>(null);

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

  /**
   * A4: the scoreboard request now carries the player token when there is one,
   * which is what makes `is_pinned`/`my_rank`/`my_score`/`neighbors` appear.
   * Built from the raw token string via useMemo rather than `usePlayerHeaders()`
   * — that hook returns a NEW object every render, and depending on it from a
   * fetch effect is the exact shape of the v2.18.1 infinite-fetch-loop bug.
   */
  const authHeaders = useMemo<Record<string, string>>(
    () => (playerToken ? { Authorization: `Bearer ${playerToken}` } : {} as Record<string, string>),
    [playerToken],
  );

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
    fetch(`/api/global/scoreboard?${buildQuery(0)}`, { headers: authHeaders })
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
  }, [buildQuery, authHeaders]);

  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    fetch(`/api/global/scoreboard?${buildQuery(games.length)}`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : { data: [], hasMore: false })
      .then(payload => {
        setGames(prev => [...prev, ...(payload.data || [])]);
        setHasMore(Boolean(payload.hasMore));
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [buildQuery, authHeaders, games.length, hasMore, loadingMore]);

  // A4 — the rail's data. Only fetched for logged-in viewers; logging out
  // clears it so a stale rail can't outlive the session.
  const refreshPins = useCallback(() => {
    if (!playerToken) { setPins([]); return; }
    fetch('/api/global/pins', { headers: authHeaders })
      .then(r => r.ok ? r.json() : { pins: [] })
      .then(payload => setPins(payload.pins || []))
      .catch(() => {});
  }, [playerToken, authHeaders]);

  useEffect(() => { refreshPins(); }, [refreshPins]);

  const showError = useCallback((message: string) => {
    setErrorToast(message);
    if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    errorTimerRef.current = window.setTimeout(() => setErrorToast(null), 4000);
  }, []);

  /**
   * A4 — optimistic pin toggle. The card flips immediately, the request goes
   * out, and a failure reverts the card AND toasts. Reverting silently would
   * read as "the button doesn't work"; not reverting would leave the UI lying
   * about server state until the next fetch.
   */
  const togglePin = useCallback(async (game: TopGame) => {
    if (!playerToken) return;
    const nextPinned = !game.is_pinned;
    const gameId = game.global_game_id;
    setGames(prev => prev.map(g => g.global_game_id === gameId ? { ...g, is_pinned: nextPinned } : g));
    try {
      const res = await fetch(`/api/global/games/${encodeURIComponent(gameId)}/pin`, {
        method: nextPinned ? 'POST' : 'DELETE',
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(String(res.status));
      refreshPins();
    } catch {
      setGames(prev => prev.map(g => g.global_game_id === gameId ? { ...g, is_pinned: !nextPinned } : g));
      showError(nextPinned ? 'Could not pin that game.' : 'Could not unpin that game.');
    }
  }, [playerToken, authHeaders, refreshPins, showError]);

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
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  const handleLogin = () => {
    loginWithDiscord('__global__', '/scoreboard');
  };

  const handleGoogleLogin = () => {
    loginWithGoogle('__global__', '/scoreboard');
  };

  /**
   * A3 — the palette's Submit / ↵ path. Unlike the card path (which redirects
   * straight into OAuth), a logged-out palette user is bounced to the page's
   * own provider-agnostic login affordance: Google is a full IdP, so the
   * palette must never imply Discord is the only way in.
   */
  const handlePaletteSubmit = (game: PaletteGame) => {
    if (!playerToken) {
      setShowSubheadLogin(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const full = games.find(g => g.global_game_id === game.global_game_id);
    // The palette result carries everything SubmissionSheet needs, so a game
    // that isn't on the current page of the grid still submits fine.
    setSubmitGame(full ?? ({ ...game, top_scores: game.top_scores ?? [] } as TopGame));
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

        {/* A4 — My Pins rail. Between the title block and the search field,
            logged-in only, and self-hiding when the viewer has no pins. */}
        <PinnedRail
          pins={pins}
          onSubmit={pin => setSubmitGame({
            ...pin,
            type: 'pinball',
            platforms: '[]',
            last_submitted_at: null,
            avg_rating: 0,
            rating_count: 0,
            top_scores: [],
          } as unknown as TopGame)}
          onAdd={() => setPaletteOpen(true)}
        />

        {/* Search + room scope. The field itself is owned by the ⌘K palette
            (A3) — one input that gains a focused treatment when the palette is
            open, rather than a second, competing search box. */}
        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <GlobalSearchPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            value={searchInput}
            onValueChange={setSearchInput}
            debouncedQuery={search}
            scope={scope}
            platformGroup={platformGroup}
            loggedIn={Boolean(playerToken)}
            onSubmitGame={handlePaletteSubmit}
          />
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

        {/* A3 — while the palette is open the page behind recedes: 25% opacity
            and inert, so the only live thing on screen is the palette. */}
        <div
          className={`transition-opacity duration-150 ${paletteOpen ? 'pointer-events-none opacity-25' : ''}`}
          aria-hidden={paletteOpen || undefined}
        >
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
            {(playerToken ? [PINNED_PILL, ...SORT_PILLS] : SORT_PILLS).map(([value, label]) => (
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
                  onTogglePin={playerToken ? () => togglePin(game) : undefined}
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

      {/* A4 — pin-toggle failure. The card has already reverted by the time
          this shows; the toast explains why it snapped back. */}
      {errorToast && (
        <div
          role="status"
          className="fixed top-20 left-1/2 z-30 -translate-x-1/2 rounded border border-neon-coral bg-surface px-5 py-3 text-sm shadow-lg animate-slide-down"
        >
          {errorToast}
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

function LeaderboardRow({ entry, rank, isYou = false }: { entry: TopScoreEntry; rank: number; isYou?: boolean }) {
  const tint = RANK_TINTS[rank];
  const name = playerName(entry);
  const abbreviated = formatScore(entry.score);
  // A4: the viewer's own row wins the tint even at rank 1-3 — "this is me" is
  // the more useful signal on a card the viewer opened to find themselves on.
  const bg = isYou ? 'var(--sb-row-you-bg)' : (tint?.bg ?? 'transparent');
  const border = isYou ? 'var(--sb-row-you-border)' : (tint?.border ?? 'transparent');

  return (
    <div
      className="flex items-center gap-2 rounded-[5px] border px-2 py-[5px]"
      style={{ background: bg, borderColor: border }}
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
      {/* Name and room badge travel together, hard left. Previously the name
          span carried `flex-1`, which pushed the badge to the far right edge
          and visually detached it from the player it belongs to. The group
          takes the slack instead, so the badge sits immediately after the
          username and the score still right-aligns. */}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={`min-w-0 truncate text-[11px] ${isYou ? 'font-bold' : 'font-medium'}`}>
          {name}
          {isYou && (
            <span className="ml-1.5 rounded-[2px] px-1 py-px align-middle text-[8px] font-bold uppercase tracking-[0.5px] text-neon-cyan"
              style={{ background: 'var(--sb-row-you-bg)' }}>
              You
            </span>
          )}
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
      </span>
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
function GameCard({ game, onSubmit, onTogglePin }: {
  game: TopGame;
  onSubmit: () => void;
  /** Undefined for anonymous viewers — the hotspot is not rendered at all. */
  onTogglePin?: () => void;
}) {
  const img = catalogueImageFor(game);
  const displayName = game.display_name || game.name;
  const rows = (game.top_scores || []).slice(0, CARD_ROWS);
  const platforms = parsePlatforms(game.platforms);
  const primaryPlatform = platforms[0];

  /**
   * A4 — the "YOU" row. Appended only when the viewer has a rank AND that rank
   * falls outside the rows already rendered; inside the top 6 they are already
   * on the card and a duplicate row would be worse than none.
   *
   * The row itself comes from `neighbors` (which carries the full entry shape
   * including avatar and origin room), not from a synthesised stub.
   */
  const myRank = game.my_rank ?? null;
  const youEntry = (myRank != null && myRank > rows.length)
    ? (game.neighbors || []).find(n => n.rank === myRank) ?? null
    : null;

  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-[10px] border border-border bg-surface transition-colors duration-150 hover:border-[var(--sb-card-hover-border)]">
      {/* A4 — pin hotspot. A SIBLING of the art <Link>, not a child: a button
          nested inside an anchor is invalid and swallows the anchor's
          activation on some browsers.

          The button is a transparent 44×44 hit target anchored at the card's
          top-left corner, with the 22px visual chip inset 6px inside it. That
          is how the design's 22px control gets a ≥44px touch target WITHOUT a
          negative-inset wrapper, which the card's `overflow-hidden` would clip
          away exactly where the extra area was needed. */}
      {onTogglePin && (
        <button
          type="button"
          onClick={onTogglePin}
          aria-pressed={Boolean(game.is_pinned)}
          aria-label={game.is_pinned ? `Unpin ${displayName}` : `Pin ${displayName}`}
          title={game.is_pinned ? 'Unpin this game' : 'Pin this game'}
          className="absolute left-0 top-0 z-10 h-11 w-11"
        >
          <span
            className="absolute left-1.5 top-1.5 flex h-[22px] w-[22px] items-center justify-center rounded border transition-colors"
            style={{ background: 'var(--sb-art-btn-bg)', borderColor: 'var(--sb-art-btn-border)' }}
          >
            <Pin
              className={`h-[11px] w-[11px] ${game.is_pinned ? 'fill-current text-neon-amber' : 'text-primary'}`}
              aria-hidden="true"
            />
          </span>
        </button>
      )}

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
            {/* A4 — the viewer's own row, appended when they rank below the
                rows above. No break line / neighbour block: that's A5's
                density toggle, and `neighbors` is already on the payload for
                it. */}
            {youEntry && (
              <LeaderboardRow entry={youEntry} rank={myRank as number} isYou />
            )}
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
