import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trophy, Filter } from 'lucide-react';
import { getSocket } from '../lib/websocket';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoadingState from '../components/LoadingState';
import SubmissionSheet from '../components/SubmissionSheet';
import UserMenu from '../components/UserMenu';
import LoginButtons from '../components/LoginButtons';
import GlobalThemeToggle from '../components/GlobalThemeToggle';
import BrandWordmark from '../components/BrandWordmark';
import GlobalSearchPalette, { type PaletteGame } from '../components/GlobalSearchPalette';
import PinnedCarousel, { type PinnedGame } from '../components/PinnedCarousel';
import GlobalGameCard, { type GlobalGameCardGame } from '../components/GlobalGameCard';
import { GRID_CLASS } from '../lib/globalGrid';
import { formatScore } from '../lib/format';
import { PLATFORM_GROUPS } from '../lib/platforms';

/**
 * v2.55.0: the card itself — and the row/score shapes it reads — now live in
 * `components/GlobalGameCard.tsx`, because the My Pins carousel renders the
 * very same component. This page adds only the fields IT needs on top.
 */
interface TopGame extends GlobalGameCardGame {
  type: string;
  top_score: number | null;
  last_submitted_at: string | null;
  /** Retained: still drives the "Top rated" sort. No longer rendered on cards
   *  (v2.50.0 removed the StarRating row); GlobalGameDetail still shows stars. */
  avg_rating: number;
  rating_count: number;
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

type SortMode = 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned';

const PAGE_SIZE = 30;

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
  const [pins, setPins] = useState<PinnedGame[]>([]);
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

  /**
   * v2.55.0 — unpinning from INSIDE the carousel. The card leaves the rail
   * immediately (a full refetch would make the row jump twice and re-measure
   * the marquee mid-animation); a failed request puts it back and toasts.
   */
  const unpinFromRail = useCallback(async (pin: PinnedGame) => {
    if (!playerToken) return;
    const gameId = pin.global_game_id;
    setPins(prev => prev.filter(p => p.global_game_id !== gameId));
    setGames(prev => prev.map(g => g.global_game_id === gameId ? { ...g, is_pinned: false } : g));
    try {
      const res = await fetch(`/api/global/games/${encodeURIComponent(gameId)}/pin`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      // Restore in place: pins are ordered `pinned_at DESC`, so re-inserting by
      // that key puts the card back exactly where it was rather than on the end.
      setPins(prev => [...prev, pin].sort((a, b) => b.pinned_at.localeCompare(a.pinned_at)));
      setGames(prev => prev.map(g => g.global_game_id === gameId ? { ...g, is_pinned: true } : g));
      showError('Could not unpin that game.');
    }
  }, [playerToken, authHeaders, showError]);

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
        {/* v2.55.0 — heading centred on desktop only; a centred heading on a
            narrow phone reads worse than left-aligned, so `sm:` gates it.
            Trophy + title both scaled 1.5x (24px→36px, text-3xl→text-[2.8125rem]
            = 30px→45px). The trophy takes the logo's own delta pink via
            --color-brand-delta rather than an approximate palette token. */}
        <div className="flex items-center gap-3 mb-2 sm:justify-center">
          {/* 1.5x applies from `sm:` up. At 45px the title wraps to two lines on
              a 390px phone and swallows the first screen, so mobile keeps the
              original 24px/30px pairing. */}
          <Trophy className="w-6 h-6 sm:w-9 sm:h-9 shrink-0" style={{ color: 'var(--color-brand-delta)' }} />
          <h1 className="font-display text-3xl sm:text-[2.8125rem] leading-tight font-bold">Global Scoreboard</h1>
        </div>
        {/* A0 #2/#3: provider-agnostic copy, "Arcaid" casing. */}
        <p className="text-muted mb-2 text-[12.5px] sm:text-center">
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

        {/* A4 — My Pins. Between the title block and the search field,
            logged-in only, and self-hiding when the viewer has no pins.
            v2.55.0: full grid cards in a carousel, not 220px chips. */}
        <PinnedCarousel
          pins={pins}
          onSubmit={pin => setSubmitGame({
            ...pin,
            type: 'pinball',
            last_submitted_at: null,
            avg_rating: 0,
            rating_count: 0,
          } as unknown as TopGame)}
          onAdd={() => setPaletteOpen(true)}
          onTogglePin={playerToken ? unpinFromRail : undefined}
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
            <div className={GRID_CLASS}>
              {games.map(game => (
                <GlobalGameCard
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
