import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Trophy, Filter, Circle, MapPin } from 'lucide-react';
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
import GlobalGameCard, { type GlobalGameCardGame, type Density } from '../components/GlobalGameCard';
import GlobalHeroCard from '../components/GlobalHeroCard';
import GlobalScoreboardTitle from '../components/GlobalScoreboardTitle';
import RAGameSearch, { type RAImportResult } from '../components/RAGameSearch';
import { GRID_CLASS } from '../lib/globalGrid';
import { formatScore } from '../lib/format';
import { CARD_CATEGORY_ORDER, getCardCategoryLabel, engineCardCategory } from '../lib/scoreProvenance';

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

/**
 * v2.57.0 (A5a) — the hero card's game. Same row shape as any other, plus the
 * two fields the hero adds. `hero` rides on the page-1 payload only.
 */
interface HeroGame extends TopGame {
  is_hot: boolean;
  weekly_score_count: number;
}

interface Room {
  id: string;
  slug: string;
  name: string;
  is_public: boolean;
}

type SortMode = 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned';

const PAGE_SIZE = 30;

/**
 * §4 — "no (or few) catalogue matches". Below this many cards a search reads as
 * a miss even when it technically returned something, so the RetroAchievements
 * offer still appears (under the grid rather than instead of it).
 */
const FEW_RESULTS = 4;

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

/**
 * v2.57.0 (A5a) — where the density choice lives.
 *
 * `localStorage` paints instantly on the next visit; the server preference is
 * the source of truth across devices, and reconciles on mount. Same two-tier
 * pattern `ThemeProvider` uses.
 *
 * The server half MUST be `/api/me/scoreboard-preferences` with a NAMESPACED
 * key — `/api/me/preferences` is theme-only, admin-scoped, and rejects extra
 * keys with a 400.
 */
/**
 * v2.59.0 (ADR 0016 P4) — the filter chips.
 *
 * These REPLACE the old platform-group chips (`Physical` · `Virtual Pinball` ·
 * `Video Games`), which filtered GAMES by catalogue availability. The page no
 * longer lists games, it lists per-category boards, so a filter on a different
 * taxonomy than the one the cards are cut by would have been two competing
 * answers to "what am I looking at". Labels come from the shared taxonomy, so
 * a band rename lands here for free.
 */
const CATEGORY_CHIPS: Array<[string, string]> = [
  ['all', 'All'],
  ...CARD_CATEGORY_ORDER.map(id => [id, getCardCategoryLabel(id) as string] as [string, string]),
];

const DENSITY_STORAGE_KEY = 'arcaid-scoreboard-density';
const DENSITY_PREF_KEY = 'global_density';

function readStoredDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_STORAGE_KEY) === 'mine' ? 'mine' : 'top6';
  } catch { return 'top6'; }
}

/**
 * A card's stable identity — v2.59.0 (P4).
 *
 * The server always sends `card_id`; the game-id fallback exists so a payload
 * from an older server (or a fixture) still renders one card per game instead
 * of a grid keyed on `undefined`, which React collapses into a single row.
 */
function cardKeyOf(game: { card_id?: string; global_game_id: string }): string {
  return game.card_id ?? game.global_game_id;
}

/** `LIVE · updated {n} ago` — seconds while it still reads as "just now". */
function formatAgo(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

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
  /** P4 — `all` or a `CARD_CATEGORY_ORDER` id. Filters CARDS, not games. */
  const [category, setCategory] = useState<string>('all');
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
  /** A5a — the hero card. Page-1 content: `loadMore` never touches it. */
  const [hero, setHero] = useState<HeroGame | null>(null);
  /** A5a — Top 6 / My Score. Seeded from localStorage so the first paint is
   *  already the viewer's choice; the server preference reconciles on mount. */
  const [density, setDensity] = useState<Density>(readStoredDensity);
  /** A5a — the live indicator. `lastUpdate` is the timestamp of the newest
   *  thing we know about (a `score:new:global` event, else the last fetch);
   *  `nowTs` ticks once a second purely so the rendered age advances. */
  const [lastUpdate, setLastUpdate] = useState(() => Date.now());
  const [nowTs, setNowTs] = useState(() => Date.now());
  /**
   * §4 — the card key of a game the viewer just added from RetroAchievements.
   * Held only long enough to scroll to it and ring it once; a permanent marker
   * would still be glowing three searches later.
   */
  const [raHighlightKey, setRaHighlightKey] = useState<string | null>(null);
  const raHighlightRef = useRef<HTMLDivElement | null>(null);
  /** Success line under the RA panel — the page's toasts are score events. */
  const [raNotice, setRaNotice] = useState<string | null>(null);
  const raNoticeTimerRef = useRef<number | null>(null);

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
    // P4: the chip state stores the category ID, never the human label.
    if (category !== 'all') params.set('category', category);
    return params.toString();
  }, [sort, scope, search, category]);

  // Load first page whenever filters change
  useEffect(() => {
    setLoading(true);
    fetch(`/api/global/scoreboard?${buildQuery(0)}`, { headers: authHeaders })
      .then(r => r.ok ? r.json() : { data: [], total: 0, hasMore: false })
      .then(payload => {
        setGames(payload.data || []);
        setTotal(payload.total || 0);
        setHasMore(Boolean(payload.hasMore));
        // A5a: `hero` is page-1-only and may legitimately be null (nothing in
        // this filtered view has a score yet).
        setHero((payload.hero as HeroGame | null) ?? null);
        setLastUpdate(Date.now());
      })
      .catch(() => {
        setGames([]);
        setTotal(0);
        setHasMore(false);
        setHero(null);
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
  /**
   * A5a — the hero is the same game as one of the grid rows (or a game that
   * fell off the page entirely), so a pin flip has to land on both surfaces or
   * the two disagree on screen.
   */
  const applyPinned = useCallback((gameId: string, value: boolean) => {
    setGames(prev => prev.map(g => g.global_game_id === gameId ? { ...g, is_pinned: value } : g));
    setHero(prev => (prev && prev.global_game_id === gameId ? { ...prev, is_pinned: value } : prev));
  }, []);

  const togglePin = useCallback(async (game: TopGame) => {
    if (!playerToken) return;
    const nextPinned = !game.is_pinned;
    const gameId = game.global_game_id;
    applyPinned(gameId, nextPinned);
    try {
      const res = await fetch(`/api/global/games/${encodeURIComponent(gameId)}/pin`, {
        method: nextPinned ? 'POST' : 'DELETE',
        headers: authHeaders,
      });
      if (!res.ok) throw new Error(String(res.status));
      refreshPins();
    } catch {
      applyPinned(gameId, !nextPinned);
      showError(nextPinned ? 'Could not pin that game.' : 'Could not unpin that game.');
    }
  }, [playerToken, authHeaders, refreshPins, showError, applyPinned]);

  /**
   * v2.55.0 — unpinning from INSIDE the carousel. The card leaves the rail
   * immediately (a full refetch would make the row jump twice and re-measure
   * the marquee mid-animation); a failed request puts it back and toasts.
   */
  const unpinFromRail = useCallback(async (pin: PinnedGame) => {
    if (!playerToken) return;
    const gameId = pin.global_game_id;
    setPins(prev => prev.filter(p => p.global_game_id !== gameId));
    applyPinned(gameId, false);
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
      applyPinned(gameId, true);
      showError('Could not unpin that game.');
    }
  }, [playerToken, authHeaders, showError, applyPinned]);

  // WebSocket — show a toast and bump the matching card's stats optimistically
  useEffect(() => {
    const socket = getSocket();
    const handler = (data: { globalGameId: string; gameName: string; playerName: string; score: number; engine?: string | null }) => {
      setToast({ player: data.playerName, game: data.gameName, score: data.score });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5000);

      // P4 made rows per-category boards, so a game can hold several cards.
      // Target the bump at the ONE card whose category matches the score's
      // engine. A card with no category yet (zero-score claim card) takes the
      // bump — this score is what opens its board. No engine on the event
      // (older server mid-deploy) falls back to bumping every card of the
      // game; the next fetch corrects it.
      const scoreCategory = data.engine ? engineCardCategory(data.engine) : null;
      setGames(prev => prev.map(g => {
        if (g.global_game_id !== data.globalGameId) return g;
        if (scoreCategory && g.category && g.category !== scoreCategory) return g;
        return { ...g, score_count: g.score_count + 1, top_score: Math.max(g.top_score || 0, data.score), last_submitted_at: new Date().toISOString() };
      }));
      // A5a — this is what the live indicator counts from. A score landing
      // anywhere on the global board resets the clock, which is the honest
      // reading of "updated Ns ago" for a page that shows every room.
      setLastUpdate(Date.now());
    };
    socket.on('score:new:global', handler);
    return () => {
      socket.off('score:new:global', handler);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      if (errorTimerRef.current) window.clearTimeout(errorTimerRef.current);
    };
  }, []);

  /**
   * A5a — the live indicator's clock. One interval for the whole page; the
   * rendered value is derived, so this never triggers a fetch.
   */
  useEffect(() => {
    const id = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * A5a — reconcile the density choice with the server preference on mount.
   * localStorage already painted; this only corrects it when another device
   * disagrees. Anonymous viewers never see the toggle, so they never fetch.
   */
  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    fetch('/api/me/scoreboard-preferences', { headers: authHeaders })
      .then(r => r.ok ? r.json() : null)
      .then(prefs => {
        if (cancelled || !prefs) return;
        const stored = prefs[DENSITY_PREF_KEY];
        if (stored === 'mine' || stored === 'top6') setDensity(stored);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [playerToken, authHeaders]);

  /**
   * A5a — flipping density is PURE CLIENT STATE. `neighbors` already shipped
   * with the page's data (A4), so nothing is refetched: the cards re-plan their
   * rows from what they already hold. The only request this makes is the
   * fire-and-forget preference write, and it is deliberately not awaited — the
   * UI must not wait on the network to change what it draws.
   */
  const changeDensity = useCallback((next: Density) => {
    setDensity(next);
    try { localStorage.setItem(DENSITY_STORAGE_KEY, next); } catch { /* private mode */ }
    if (!playerToken) return;
    fetch('/api/me/scoreboard-preferences', {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ [DENSITY_PREF_KEY]: next }),
    }).catch(() => {});
  }, [playerToken, authHeaders]);

  const handleLogin = () => {
    loginWithDiscord('__global__', '/scoreboard');
  };

  const handleGoogleLogin = () => {
    loginWithGoogle('__global__', '/scoreboard');
  };

  /**
   * §4 — a player added a game from RetroAchievements.
   *
   * The refetch is driven by narrowing the search to the imported title rather
   * than by calling a bespoke reload: the page's one fetch effect is keyed on
   * `search`, so re-running it through the same door keeps `hero`, `total` and
   * `hasMore` consistent (the ad-hoc post-submission refetch further down does
   * not, and that is a wart, not a pattern to copy). The imported game is
   * brand new and therefore scoreless, so it arrives as a `::none` claim card
   * — which is exactly the card the player needs in order to post the first
   * score they came here to post.
   */
  const handleRAImported = useCallback((result: RAImportResult) => {
    const name = result.game?.name || 'That game';
    setRaHighlightKey(`${result.game.id}::none`);
    setSearchInput(name);
    setCategory('all');
    setRaNotice(`${name} is on Arcaid now — claim the first score.`);
    if (raNoticeTimerRef.current) window.clearTimeout(raNoticeTimerRef.current);
    raNoticeTimerRef.current = window.setTimeout(() => setRaNotice(null), 6000);
  }, []);

  /**
   * Scroll to the freshly-imported card once the refetch has actually put it on
   * screen, then drop the marker. Keyed on `games` (not on a timer) because the
   * card does not exist until that response lands.
   */
  useEffect(() => {
    if (!raHighlightKey) return;
    if (!games.some(g => cardKeyOf(g) === raHighlightKey)) return;
    raHighlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = window.setTimeout(() => setRaHighlightKey(null), 4000);
    return () => window.clearTimeout(t);
  }, [raHighlightKey, games]);

  useEffect(() => () => {
    if (raNoticeTimerRef.current) window.clearTimeout(raNoticeTimerRef.current);
  }, []);

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

  /**
   * §4 — built once and rendered in one of two slots (above an empty grid,
   * below a thin one) so the two branches can never drift apart.
   *
   * `showEligibility` is deliberately false here: the RA verdict is a
   * moderation signal for admins (§5), not a label to hang on a game in front
   * of the player deciding whether to add it.
   */
  const raSearch = (variant: 'card' | 'bare') => (
    <RAGameSearch
      basePath="/global/ra-catalogue"
      authMode="player"
      playerToken={playerToken}
      query={search}
      /* The page already debounced this value; debouncing it again would
         just add 300ms to every keystroke. */
      debounceMs={0}
      variant={variant}
      canImport={Boolean(playerToken)}
      loginPrompt={
        <button
          type="button"
          onClick={handleLogin}
          className="text-neon-cyan hover:underline"
        >
          Log in to add this game
        </button>
      }
      inCatalogueHref={id => `/games/${id}`}
      onImported={handleRAImported}
    />
  );

  /**
   * The page-level copy of the offer. Suppressed while the palette is open:
   * the palette carries its own copy (see `emptySlot`) and dims everything
   * behind it, so rendering both at once just puts a ghost of the same panel
   * behind the live one.
   */
  const raPanel = paletteOpen ? null : raSearch('card');

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="px-4 sm:px-6 lg:px-10 py-4 flex items-center justify-between gap-3">
          <BrandWordmark />
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
        {/* v2.60.0 — the flat Trophy-icon + <h1> pairing is replaced by the
            design pack's neon-trophy lockup (see GlobalScoreboardTitle). The
            v2.55.0 alignment behaviour is preserved by different means: the
            lockup caps at its 902px native width, so `mx-auto` centres the
            whole block once the viewport can hold it and is a no-op below
            that, leaving a phone with the same left-aligned reading order.
            The status line and the subtitle ride inside the lockup so they
            stay indented to the wordmark's left edge, as the pack specifies. */}
        <GlobalScoreboardTitle className="mb-2 mx-auto">
          {/* A0 #2/#3: provider-agnostic copy, "Arcaid" casing. The copy already
              matches the pack's subtitle, so it simply takes the `gs-sub`
              treatment rather than being duplicated as static art.

              This is the FIRST thing under the lockup, and deliberately so: the
              pack specifies lockup → subtitle adjacency, and a page's
              description has to reach the reader before its telemetry does.
              Pre-v2.63 the live line sat between the two and pushed the
              description down a row for no editorial reason. */}
          <p className="gs-sub mb-1">
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
          {/* A5a — the live line + dot, now the LAST line of the header block.
              Driven off the last `score:new:global` event, falling back to the
              last fetch. Deliberately NOT accompanied by the design's
              "{total} games · {n} players" line: there is no player-count API
              and inventing one is out of scope. `.pulse` is already nulled
              under prefers-reduced-motion by index.css's global guard, so no
              extra media query is needed. */}
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] text-muted" role="status">
            <Circle
              className="pulse h-2 w-2 shrink-0 fill-current text-neon-magenta"
              strokeWidth={0}
              aria-hidden="true"
              data-testid="live-dot"
            />
            <span>LIVE · updated {formatAgo(Math.floor((nowTs - lastUpdate) / 1000))} ago</span>
          </div>
        </GlobalScoreboardTitle>
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
            category={category}
            loggedIn={Boolean(playerToken)}
            onSubmitGame={handlePaletteSubmit}
            /* §4 — the palette is where a missed search actually lands, and
               while it is open the page behind it is inert. The offer has to
               be here too, or it is unreachable at the one moment it matters. */
            emptySlot={raSearch('bare')}
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
        {/* Category chips (left) + sort pills (right) */}
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 mb-6">
          <div className="flex items-center gap-2 flex-wrap">
            <Filter className="w-4 h-4 text-muted" />
            {CATEGORY_CHIPS.map(([k, label]) => (
              <button
                key={k}
                onClick={() => setCategory(k)}
                aria-pressed={category === k}
                className={`px-3 py-1 text-[10px] rounded-full border ${
                  category === k
                    ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                    : 'border-border text-muted hover:text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* v2.78.0 — `w-full` (was `self-start`) is load-bearing on mobile.
              This div is a flex-column CHILD of the category-chips/controls row
              above below `lg`, so `self-start` opted it out of the default
              stretch-to-container width and let it size itself via
              shrink-to-fit. Shrink-to-fit still takes the MAX-CONTENT
              contribution of the sort-pills strip's `overflow-x-auto`
              descendant (below) into account, so the row ballooned to the
              pills' full unwrapped width — 89px past a 390px viewport, 159px
              past 320px logged in — even though that inner div already
              declared `max-w-full overflow-x-auto`: `max-w-full` was resolving
              against this now-unbounded parent, not the viewport. An explicit
              `w-full` here gives the parent a definite width again (bounded by
              the page's own padding container), which is what lets the inner
              `overflow-x-auto` actually contain the strip instead of the whole
              page scrolling sideways. `lg:w-auto` restores the original
              fit-content sizing at desktop, where `lg:ml-auto` still needs to
              push a content-sized block to the row's right edge. */}
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:ml-auto">
            {/* A5a — Top 6 / My Score. Hidden entirely when logged out: there is
                no "my score" for an anonymous visitor, and a control that can
                only ever mean one thing is worse than no control. Flips with no
                refetch — every card already holds its `neighbors`. */}
            {playerToken && (
              <div
                className="flex items-center gap-1 rounded-[5px] border border-border bg-surface p-[2px]"
                role="group"
                aria-label="Leaderboard density"
              >
                {([['top6', 'Top 6', Trophy], ['mine', 'My Score', MapPin]] as const).map(([value, label, Icon]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => changeDensity(value)}
                    aria-pressed={density === value}
                    className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[3px] px-3.5 py-1.5 text-[11px] font-bold transition-colors ${
                      density === value
                        ? 'bg-neon-cyan/20 text-neon-cyan'
                        : 'text-muted hover:text-primary'
                    }`}
                  >
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>
            )}
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
        </div>

        {/* Results summary. P4: a row is a per-category leaderboard now, not a
            game — one game can contribute several — so the copy counts what it
            actually counts. */}
        {!loading && (
          <div className="text-xs text-muted mb-4">
            Showing {games.length.toLocaleString()} of {total.toLocaleString()} leaderboards
          </div>
        )}

        {/* §4 — the import confirmation sits ABOVE the results, not with the RA
            panel: the panel moves between two slots depending on how many cards
            came back, and a success message that jumps around the page with it
            is worse than no message. */}
        {raNotice && (
          <div
            className="mb-4 rounded-md border border-neon-green/40 bg-neon-green/10 px-3 py-2 text-sm text-neon-green"
            role="status"
            data-testid="ra-import-notice"
          >
            {raNotice}
          </div>
        )}

        {/* §4 — the demand-driven catalogue's player entry point.
            Placed ABOVE the grid when the search came up empty (it is then the
            only answer on screen) and below it otherwise; either way it only
            appears for a search that the catalogue could barely answer, so it
            never competes with a healthy result set. */}
        {!loading && raPanel && search.trim().length >= 2 && games.length === 0 && (
          <div className="mb-6">{raPanel}</div>
        )}

        {/* Card grid */}
        {loading ? (
          <LoadingState message="Loading global scoreboard..." />
        ) : games.length === 0 ? (
          <div className="text-center py-16 text-muted">
            No leaderboards found. Try adjusting your filters.
          </div>
        ) : (
          <>
            {/* A0 #12: no grid-auto-rows — row height is content-driven and
                cards stretch to match the tallest in their row. */}
            <div className={GRID_CLASS}>
              {/* A5a — the hero occupies grid position 1. Its game is filtered
                  out of the rest of the grid: the same card twice on one
                  screen reads as a bug, not as emphasis. */}
              {hero && (
                <GlobalHeroCard
                  key={`hero-${hero.global_game_id}`}
                  game={hero}
                  /* v2.70.0 — WIDE, NOT TALL, and full-bleed on a phone.
                     `lg:row-span-2` is gone: two columns by two rows made the
                     hero four card-tiles of desktop real estate, which read as
                     oversized rather than as important. It now takes two
                     columns of ONE row, so it is a header strip across the top
                     of the grid at exactly the row height its neighbours set.
                     (`sm:col-span-2` is unchanged and is already the full
                     width of the 2-column band.)

                     Below `sm` it breaks the page's own `px-4` gutter while
                     the grid cards stay inset — the phone's version of "this
                     one is different", since at one column it cannot be wider
                     than its neighbours. `-mx-[14px]` rather than `-mx-4`
                     leaves 2px so the marquee's left/right lamp strips stay on
                     screen; see `.gg-hero` in index.css. */
                  className="-mx-[14px] sm:mx-0 sm:col-span-2"
                  onSubmit={() => handleSubmitClick(hero)}
                  onTogglePin={playerToken ? () => togglePin(hero) : undefined}
                />
              )}
              {/* P4 — filter by CARD, not by game. The hero renders one
                  category's board; the game's OTHER category cards are
                  different leaderboards and must stay in the grid, or those
                  scores would have nowhere on the page to appear. */}
              {games
                .filter(game => !hero || cardKeyOf(game) !== cardKeyOf(hero))
                .map(game => {
                  const key = cardKeyOf(game);
                  const card = (
                    <GlobalGameCard
                      game={game}
                      density={density}
                      onSubmit={() => handleSubmitClick(game)}
                      onTogglePin={playerToken ? () => togglePin(game) : undefined}
                    />
                  );
                  // §4 — the just-imported card gets a temporary ring from a
                  // WRAPPER, not from a card prop: the highlight is a property
                  // of this page's flow, and GlobalGameCard is shared with the
                  // pins carousel, where it would mean nothing.
                  if (key !== raHighlightKey) {
                    return <div key={key} className="contents">{card}</div>;
                  }
                  return (
                    <div
                      key={key}
                      ref={raHighlightRef}
                      data-testid="ra-imported-card"
                      className="h-full rounded-xl ring-2 ring-neon-cyan/70 shadow-[0_0_18px_rgba(0,229,255,0.25)]"
                    >
                      {card}
                    </div>
                  );
                })}
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

        {/* Thin result sets get the same offer, under the grid — "few matches"
            is the other half of the contract's trigger, and a player searching
            "donkey kong" who gets one unrelated hit is in the same bind as one
            who gets none. */}
        {!loading && raPanel && search.trim().length >= 2 && games.length > 0 && games.length < FEW_RESULTS && (
          <div className="mt-6">{raPanel}</div>
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
