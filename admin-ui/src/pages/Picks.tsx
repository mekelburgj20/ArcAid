import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle, Clock, Trophy, Calendar, ChevronDown, ChevronUp, Star, Crosshair, X, Search } from 'lucide-react';
import MysteryAward from '../components/MysteryAward';
import PickGameModal from '../components/PickGameModal';
import LoginButtons from '../components/LoginButtons';
import PlatformChips from '../components/PlatformChips';
import GameQuickView from '../components/GameQuickView';
import MemberAdminPicker, { type PickableMember } from '../components/MemberAdminPicker';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import { MysteryAwardIcon } from '../assets/icons/ThemedIcons';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { useToast } from '../components/Toast';
import { getPortal } from '../lib/portal';
import { getPlatformDisplay, normalizePlatformList } from '../lib/platforms';
import {
  UNKNOWN,
  enginesFromLegacyPlatforms,
  getEngineShortLabel,
  getLegacyPlatformLabel,
  isCanonicalEngine,
} from '../lib/scoreProvenance';
import { compareByRank } from '../lib/searchRank';

interface GameAvailabilityEntry {
  name: string;
  available: boolean;
  daysUntilAvailable: number;
  lastPlayedDate: string | null;
  lastEndDate: string | null;
  lastStatus: string | null;
  winnerName: string | null;
  winnerScore: number | null;
  allTimeHigh: number | null;
  allTimeHighPlayer: string | null;
  /** Catalogue metadata (v2.84.0) — additive, absent on responses from an older server. */
  manufacturer?: string | null;
  year?: number | null;
  /** Catalogue engine ids (post-v2.62 taxonomy; legacy ids still possible on old rows). */
  platforms?: string[];
  /** Availability facts (`atgames`, `vr`, `vpxs`, …) — carried but not rendered, see note below. */
  features?: string[];
  /** This room's per-game tags (ADR 0008). */
  room_tags?: string[];
  /** Catalogue identity — powers the quick-view popup's metadata fetch + Global Scoreboard link. */
  global_game_id?: string | null;
  /** Catalogue artwork, already normalized server-side. */
  image_url?: string | null;
}

/**
 * The engine ids a game denotes, over catalogue platforms ∪ room tags.
 *
 * Canonical engine ids pass through untouched (ADR 0016 hazard H-B: running
 * `fx` through the LEGACY alias table would re-legacy it to `pinball_fx`);
 * anything else folds through the legacy map. Tokens that denote no engine —
 * device-only ids like `atgames`, and room-invented tags — contribute nothing,
 * which is correct for a filter that is explicitly on the ENGINE axis.
 */
function engineIdsFor(g: GameAvailabilityEntry): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(g.platforms ?? []), ...(g.room_tags ?? [])]) {
    const token = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!token) continue;
    const engines = isCanonicalEngine(token) ? [token] : enginesFromLegacyPlatforms([token]);
    for (const e of engines) {
      if (!e || e === UNKNOWN || seen.has(e)) continue;
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

/**
 * The chip labels a row renders — so search matches what the eye sees.
 *
 * Tags contribute BOTH spellings: the short form the uniform-style chip
 * actually renders (`getLegacyPlatformLabel`) and the long catalogue name
 * (`getPlatformDisplay`), so a player typing either "VPX" or "Visual Pinball X"
 * lands on the same rows. For an unrecognised free-form tag the two agree.
 */
function chipLabelsFor(g: GameAvailabilityEntry): string[] {
  return [
    ...normalizePlatformList(g.platforms ?? []).map(p => getLegacyPlatformLabel(p)),
    ...(g.room_tags ?? []).filter(Boolean).flatMap(t => [getLegacyPlatformLabel(t), getPlatformDisplay(t)]),
  ];
}

interface TournamentInfo {
  id: string;
  name: string;
  type: string;
  mode: string;
}

interface TournamentOption {
  id: string;
  name: string;
  type: string;
  mode?: string;
}

interface AvailabilityData {
  tournament: TournamentInfo;
  eligibilityDays: number;
  games: GameAvailabilityEntry[];
}

interface PendingPick {
  /** Unique id of the picker placeholder row — needed for React keys when
   *  one user holds multiple pending picks for the same tournament. */
  pick_slot_id: string;
  tournament_id: string;
  tournament_name: string;
  picker_type: string;
  picker_designated_at: string;
  /** The COMPLETED game row this pick is the reward for. NULL only on legacy
   *  rows from before per-slot DMs (pre-fix collapsed multi-slot wins). */
  won_game_id?: string | null;
  won_game_name?: string | null;
}

interface QueuedGame {
  id: string;
  game_name: string;
  tournament_id: string;
  tournament_name: string;
  queue_order: number;
  /** v2.126.0 — the rotation reached this pick during its cooldown and parked
   *  it at the FRONT of the queue rather than dropping it. Its position is
   *  governed by the hold, so the move buttons are disabled while it lasts. */
  held?: boolean;
  /** Days left on that cooldown; only sent for held rows. */
  daysUntilAvailable?: number | null;
}

interface PickStatusData {
  pendingPicks: PendingPick[];
  queuedGames: QueuedGame[];
  /** Server-owned queue cap (PICK_QUEUE_MAX). */
  queueMax?: number;
  tournaments: Array<{ id: string; name: string; type: string; mode: string; max_active_games: number; platform_rules: string }>;
}

/**
 * v2.77.0 — the Picks page reads the SAME endpoint the nav badge reads.
 *
 * The badge counted three states; the page rendered one of them. A player
 * whose queue was empty in two gated tournaments got a count-2 badge and a
 * page with nothing on it — an unclearable number. Rather than re-derive the
 * states client-side (which is how they drifted apart in the first place), the
 * page consumes `/pick-alerts` verbatim: every state the badge counts has a
 * matching thing to look at here. Agreement by construction.
 */
interface PickAlertTournamentRef {
  tournamentId: string;
  tournamentName: string;
}
interface PickAlertIneligible extends PickAlertTournamentRef {
  gameId: string;
  gameName: string;
  reason: 'cooldown';
}
interface PickAlertsData {
  pendingPickCount: number;
  emptyQueue: PickAlertTournamentRef[];
  ineligible: PickAlertIneligible[];
  count: number;
  urgent: boolean;
}

/**
 * v2.2.10: URL param is a human-readable slug derived from the tournament
 * name (e.g. "Daily Grind" → "daily_grind"), not the UUID. The raw id is
 * still used internally for API calls — the slug is resolved to an id once
 * tournaments have loaded. Back-compat: if the URL still has a UUID (from
 * bookmarks etc.), it's kept as-is.
 */
function tournamentSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** `GET /:roomId/guild-members/search` result row (nominee typeahead, v2.99.0). */
interface NomineeSuggestion {
  discordUserId: string;
  displayName: string;
  username: string;
  avatarHash: string | null;
}

export default function Picks() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  // URL param is tournament slug (or UUID for back-compat). The resolved id
  // lives in state and is used for all API calls.
  const urlTournament = searchParams.get('t');
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(
    urlTournament && isUuid(urlTournament) ? urlTournament : null,
  );
  const [data, setData] = useState<AvailabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomName, setRoomName] = useState<string>('');
  const [roomLogoUrl, setRoomLogoUrl] = useState<string>('');
  const [filter, setFilter] = useState<'all' | 'available' | 'cooldown'>('all');
  const [search, setSearch] = useState('');
  /** Engine-axis pill filter. `'all'` = no engine restriction. */
  const [engineFilter, setEngineFilter] = useState<string>('all');
  const [showPicker, setShowPicker] = useState(false);
  /**
   * Quick-view popup subject. Same idiom as Scoreboard/RoomScoresView: the
   * title stays a real <Link> (focusable, Enter-activatable, ctrl/middle-click
   * still opens the full page in a new tab) and only a plain left-click is
   * intercepted. Because it's a popup rather than a navigation, closing it
   * leaves scroll position and every active filter exactly as they were.
   */
  const [quickView, setQuickView] = useState<GameAvailabilityEntry | null>(null);
  const handleTitleClick = (game: GameAvailabilityEntry) => (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      setQuickView(game);
    }
  };

  // Pick game state
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const { toast } = useToast();
  const [pickStatus, setPickStatus] = useState<PickStatusData | null>(null);
  const [pickTarget, setPickTarget] = useState<string | null>(null);
  // Pick-award gate (plan §5) — when false the whole pick + Mystery Award flow is disabled room-wide.
  // Sprint 9: this page is the Picks surface; when the gate is off the page should not exist.
  const { loading: pickAwardLoading, enabled: pickAwardEnabled } = usePickAwardEnabled(slug);

  // Resolve room. S18 — reads the already-cached portal (PublicLayout resolved
  // it for the same slug) via getPortal instead of fetching the full rooms list.
  useEffect(() => {
    if (!slug) return;
    getPortal(slug)
      .then(portal => {
        setRoomId(portal.roomId);
        setRoomName(portal.name);
        if (portal.logo_url) setRoomLogoUrl(portal.logo_url);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  // Load tournaments for this room
  useEffect(() => {
    if (!roomId) return;
    fetch(`/api/rooms/${roomId}/tournaments`)
      .then(r => r.json())
      .then((ts: TournamentOption[]) => {
        const actives = ts.filter((t: any) => t.is_active);
        setTournaments(actives);
        // v2.2.10 — resolve URL slug to tournament id once the list has loaded.
        // Accepts either a UUID (back-compat) or a human slug from the URL.
        if (!selectedTournamentId && actives.length > 0) {
          if (urlTournament && !isUuid(urlTournament)) {
            const bySlug = actives.find(t => tournamentSlug(t.name) === urlTournament.toLowerCase());
            setSelectedTournamentId(bySlug ? bySlug.id : actives[0]!.id);
          } else {
            setSelectedTournamentId(actives[0]!.id);
          }
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // Load availability data
  useEffect(() => {
    if (!roomId || !selectedTournamentId) return;
    setLoading(true);
    // v2.2.10 — URL reflects the tournament's human slug rather than its UUID,
    // so `/picks?t=daily_grind` is shareable and remembered. Fallback to the
    // raw id if the tournament object hasn't loaded yet.
    const t = tournaments.find(x => x.id === selectedTournamentId);
    const urlValue = t ? tournamentSlug(t.name) : selectedTournamentId;
    setSearchParams({ t: urlValue });
    fetch(`/api/rooms/${roomId}/game-availability/${selectedTournamentId}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, selectedTournamentId, tournaments]);

  // Load pick status when Discord user is logged in
  const fetchPickStatus = useCallback(() => {
    if (!roomId || !playerToken) return;
    fetch(`/api/rooms/${roomId}/pick-status`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setPickStatus(data); })
      .catch(() => {});
  }, [roomId, playerToken]);

  useEffect(() => { fetchPickStatus(); }, [fetchPickStatus]);

  // Same probe the nav badge runs (see PickAlertsData above). Silent on
  // failure — these drive supplementary banners, never the page's core data.
  const [pickAlerts, setPickAlerts] = useState<PickAlertsData | null>(null);
  const fetchPickAlerts = useCallback(() => {
    if (!roomId || !playerToken) { setPickAlerts(null); return; }
    fetch(`/api/rooms/${roomId}/pick-alerts`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => { if (data) setPickAlerts(data); })
      .catch(() => {});
  }, [roomId, playerToken]);

  useEffect(() => { fetchPickAlerts(); }, [fetchPickAlerts]);

  // Tells the nav (PublicLayout) to re-probe /pick-alerts, and re-probes for
  // this page too so the banners clear in the same tick the badge does. Fired
  // only from write paths — both surfaces already probe on mount/navigation.
  // Cross-component DOM event because PublicLayout renders Picks through an
  // <Outlet /> and can't be passed props.
  const refreshPickAlerts = () => {
    window.dispatchEvent(new Event('arcaid_pick_alerts_changed'));
    fetchPickAlerts();
  };

  // Next-win disposition (ROADMAP, locked 2026-08-09) — "If I win next…"
  // control for the currently-selected tournament. Scoped to one tournament
  // at a time via the same selector the rest of the page already uses.
  const [disposition, setDisposition] = useState<{ disposition: 'nominate' | 'forfeit' | 'auto'; nomineeDiscordId: string | null } | null>(null);
  const [dispositionLoading, setDispositionLoading] = useState(false);
  const [nomineeInput, setNomineeInput] = useState('');
  const [showNomineeInput, setShowNomineeInput] = useState(false);

  /**
   * Nominee room-member picker (v2.97.0 follow-up). `GET /:roomId/members` is
   * the same public roster `RoomMembers.tsx` reads — lazily fetched once
   * (first branch-open, or when an existing 'nominate' disposition needs a
   * name to display) and cached for the page's lifetime. `null` = not fetched
   * yet, `[]` = fetched-empty-or-failed; both render as "no picker, free-text
   * only" so a fetch failure degrades silently (no error chrome — the
   * free-text fallback always works). The Bearer token matters on
   * 'approval'-policy rooms: roomVisibilityGate 403s tokenless requests
   * there, and the disposition control only renders for signed-in viewers,
   * so the token is always available here.
   */
  const [roomMembers, setRoomMembers] = useState<PickableMember[] | null>(null);
  const fetchRoomMembers = useCallback(() => {
    if (!roomId || roomMembers !== null) return;
    fetch(`/api/rooms/${roomId}/members`, playerToken ? { headers: { Authorization: `Bearer ${playerToken}` } } : undefined)
      .then(r => (r.ok ? r.json() : []))
      .then((data: unknown) => {
        const list: Array<Record<string, unknown>> = Array.isArray(data) ? data : [];
        setRoomMembers(list.map((m): PickableMember => ({
          userId: String(m.userId),
          displayName: (m.displayName as string | null) ?? (m.username as string | null) ?? null,
          avatarHash: (m.avatarHash as string | null) ?? null,
          avatarUrl: (m.avatarUrl as string | null) ?? null,
        })));
      })
      .catch(() => setRoomMembers([]));
  }, [roomId, roomMembers, playerToken]);

  // Nominable candidates: Discord-snowflake ids only (google:* identities
  // can't be Discord-nominated — the server nominates via Discord DM/mention)
  // and never the signed-in viewer (self-nomination is rejected server-side).
  const nomineeCandidates = useMemo(() => {
    if (!roomMembers) return [];
    return roomMembers.filter(m => /^\d{5,25}$/.test(m.userId) && m.userId !== discordUser?.discordId);
  }, [roomMembers, discordUser]);

  // Names the server resolved from typed-username nominations this session
  // (`nomineeDisplayName` on the PUT response) — lets a guild-member-but-not-
  // room-member nominee render by name instead of <@id>. Session-local only;
  // a reload falls back to the roster/<@id> path.
  const [resolvedNominees, setResolvedNominees] = useState<Record<string, string>>({});

  // Best-effort name+avatar resolution for a stored nominee id — roster
  // first, then this session's server-resolved names; falls back to the raw
  // <@id> rendering (below) when neither knows the id.
  const resolveNominee = (id: string | null): PickableMember | null => {
    if (!id) return null;
    const fromRoster = roomMembers?.find(m => m.userId === id) ?? null;
    if (fromRoster) return fromRoster;
    const name = resolvedNominees[id];
    return name ? { userId: id, displayName: name, avatarHash: null, avatarUrl: null } : null;
  };

  // Prefill: an existing 'nominate' disposition needs the roster to resolve a
  // display name, even if the player never opens the picker branch.
  useEffect(() => {
    if (disposition?.disposition === 'nominate') fetchRoomMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disposition?.disposition]);

  const fetchDisposition = useCallback(() => {
    if (!roomId || !playerToken || !selectedTournamentId) { setDisposition(null); return; }
    fetch(`/api/rooms/${roomId}/tournaments/${selectedTournamentId}/pick-disposition`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : null))
      .then(data => setDisposition(data?.disposition ?? null))
      .catch(() => {});
  }, [roomId, playerToken, selectedTournamentId]);

  useEffect(() => { fetchDisposition(); }, [fetchDisposition]);

  const saveDisposition = async (body: { disposition: 'nominate' | 'forfeit' | 'auto'; nomineeDiscordId?: string }) => {
    if (!roomId || !playerToken || !selectedTournamentId) return;
    setDispositionLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/tournaments/${selectedTournamentId}/pick-disposition`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) { toast(result.error || 'Failed to save', 'error'); return; }
      setDisposition(result.disposition);
      if (result.disposition?.nomineeDiscordId && result.disposition?.nomineeDisplayName) {
        setResolvedNominees(prev => ({ ...prev, [result.disposition.nomineeDiscordId]: result.disposition.nomineeDisplayName }));
      }
      setShowNomineeInput(false);
      setNomineeInput('');
      toast('Saved — applies to your next win only.', 'success');
    } catch { toast('Failed to save', 'error'); } finally { setDispositionLoading(false); }
  };

  const clearDisposition = async () => {
    if (!roomId || !playerToken || !selectedTournamentId) return;
    setDispositionLoading(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/tournaments/${selectedTournamentId}/pick-disposition`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (!res.ok) { toast('Failed to clear', 'error'); return; }
      setDisposition(null);
      setShowNomineeInput(false);
      toast('Back to picking from your own queue.', 'success');
    } catch { toast('Failed to clear', 'error'); } finally { setDispositionLoading(false); }
  };

  const handleNomineeSubmit = () => {
    // Accepts a raw Discord snowflake, a pasted <@id>/<@!id> mention, or a
    // typed username/@handle — the server resolves non-numeric input against
    // the room's linked guild (field report 2026-08-10: '@chuckribbits' was
    // rejected client-side even though the caption promised "@mention").
    const match = nomineeInput.trim().match(/^<@!?(\d+)>$/);
    const value = (match ? match[1] : nomineeInput.trim());
    if (!value) return;
    saveDisposition({ disposition: 'nominate', nomineeDiscordId: value });
  };

  /**
   * Discord-style live suggestions for the free-text nominee field (v2.99.0).
   * `nomineeSearchActive` (below) is a plain derived boolean, not state — it
   * gates both the fetch effect AND the rendered value, so "too short /
   * branch closed" never needs an effect to reset stored state back to null
   * (that shape trips `react-hooks/set-state-in-effect`: a setState call at
   * the top of an effect body, before any async boundary). `fetchedNominee-
   * Suggestions` only ever holds the last completed-or-failed fetch result;
   * `nomineeSuggestions` below folds the two together for render. Debounced
   * ~300ms off `nomineeInput`, with an `AbortController` so a slow earlier
   * response can't clobber a faster later one — same guard idiom as
   * `RAGameSearch`.
   */
  const [debouncedNomineeQuery, setDebouncedNomineeQuery] = useState('');
  // Results are stored WITH the query that produced them and rendered only
  // while that query is still current — otherwise re-opening the field with
  // a new search briefly renders the previous query's list (or a stale
  // "No matching" line) until the new fetch lands.
  const [fetchedNomineeSuggestions, setFetchedNomineeSuggestions] = useState<{ query: string; list: NomineeSuggestion[] } | null>(null);
  const nomineeAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedNomineeQuery(nomineeInput), 300);
    return () => window.clearTimeout(t);
  }, [nomineeInput]);

  const trimmedNomineeQuery = debouncedNomineeQuery.trim().replace(/^@/, '');
  const nomineeSearchActive = showNomineeInput && trimmedNomineeQuery.length >= 2;
  const nomineeSuggestions = nomineeSearchActive && fetchedNomineeSuggestions?.query === trimmedNomineeQuery
    ? fetchedNomineeSuggestions.list
    : null;

  useEffect(() => {
    if (!nomineeSearchActive || !roomId || !playerToken) return;
    nomineeAbortRef.current?.abort();
    const controller = new AbortController();
    nomineeAbortRef.current = controller;
    fetch(`/api/rooms/${roomId}/guild-members/search?q=${encodeURIComponent(trimmedNomineeQuery)}`, {
      headers: { Authorization: `Bearer ${playerToken}` },
      signal: controller.signal,
    })
      .then(r => (r.ok ? r.json() : { members: [] }))
      .then((data: { members?: NomineeSuggestion[] }) => {
        if (controller.signal.aborted) return;
        const list = (data.members ?? []).filter(m => m.discordUserId !== discordUser?.discordId);
        setFetchedNomineeSuggestions({ query: trimmedNomineeQuery, list });
      })
      .catch(() => {
        if (!controller.signal.aborted) setFetchedNomineeSuggestions(null);
      });
    return () => controller.abort();
  }, [nomineeSearchActive, trimmedNomineeQuery, roomId, playerToken, discordUser]);

  const handleNomineeSuggestionSelect = (suggestion: NomineeSuggestion) => {
    setFetchedNomineeSuggestions(null);
    setNomineeInput('');
    setDebouncedNomineeQuery('');
    // The PUT response carries no `nomineeDisplayName` for numeric ids (only
    // the typed-username resolution path returns one) — stash it here so the
    // "Currently set to hand off to…" confirmation line can render a name
    // instead of falling back to the raw <@id>.
    setResolvedNominees(prev => ({ ...prev, [suggestion.discordUserId]: suggestion.displayName }));
    saveDisposition({ disposition: 'nominate', nomineeDiscordId: suggestion.discordUserId });
  };

  const handlePickConfirm = async (tournamentId: string) => {
    if (!roomId || !playerToken) return;
    const res = await fetch(`/api/rooms/${roomId}/pick-game`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${playerToken}`,
      },
      body: JSON.stringify({ tournamentId, gameName: pickTarget }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || 'Pick failed');

    setPickTarget(null);
    if (result.status === 'activated') {
      toast(`${result.gameName} is now active for ${result.tournamentName}!`, 'success');
    } else {
      toast(`${result.gameName} queued for ${result.tournamentName}`, 'success');
    }
    // Refresh data
    fetchPickStatus();
    refreshPickAlerts();
    if (selectedTournamentId) {
      fetch(`/api/rooms/${roomId}/game-availability/${selectedTournamentId}`)
        .then(r => r.json())
        .then(setData)
        .catch(() => {});
    }
  };

  const handleDeleteQueued = async (gameId: string) => {
    if (!roomId || !playerToken) return;
    try {
      const res = await fetch(`/api/rooms/${roomId}/queue/${gameId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (!res.ok) { const d = await res.json(); toast(d.error || 'Failed to remove', 'error'); return; }
      toast('Game removed from queue', 'success');
      fetchPickStatus();
      refreshPickAlerts();
    } catch { toast('Failed to remove game', 'error'); }
  };

  const handleMoveQueued = async (index: number, direction: 'up' | 'down') => {
    if (!roomId || !playerToken || !pickStatus) return;
    const games = [...pickStatus.queuedGames];
    const swapIndex = direction === 'up' ? index - 1 : index + 1;
    if (swapIndex < 0 || swapIndex >= games.length) return;
    // A held pick's place is decided by the hold, not by `queue_order` — it
    // can neither be moved nor be displaced. The buttons already reflect this;
    // the guard makes it true regardless of how the click arrived.
    if (games[index]?.held || games[swapIndex]?.held) return;
    [games[index], games[swapIndex]] = [games[swapIndex], games[index]];
    // Optimistic update
    setPickStatus({ ...pickStatus, queuedGames: games });
    try {
      const res = await fetch(`/api/rooms/${roomId}/queue/reorder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify({ gameIds: games.map(g => g.id) }),
      });
      if (!res.ok) { fetchPickStatus(); toast('Failed to reorder', 'error'); }
      // Reorder changes which game is head-of-queue, so it can flip the
      // "queued pick is ineligible" alert either way.
      refreshPickAlerts();
    } catch { fetchPickStatus(); }
  };

  /**
   * Per-game derived index: the engine ids it denotes and one lowercase
   * haystack covering everything the row shows (name, manufacturer, year, and
   * its chip labels). Built once per payload so typing doesn't re-fold the
   * taxonomy for every keystroke × game.
   *
   * `features` is deliberately NOT in the haystack: those tokens aren't
   * rendered as chips, and matching on something invisible makes the result
   * list look wrong.
   */
  const gameIndex = useMemo(() => {
    const index = new Map<string, { engines: string[]; haystack: string }>();
    for (const g of data?.games ?? []) {
      index.set(g.name, {
        engines: engineIdsFor(g),
        haystack: [
          g.name,
          g.manufacturer ?? '',
          g.year != null ? String(g.year) : '',
          ...chipLabelsFor(g),
        ].join(' ').toLowerCase(),
      });
    }
    return index;
  }, [data]);

  /**
   * Distinct engines present in THIS tournament's list. One pill each, plus
   * "All". Hidden entirely below two options — a lone pill filters nothing.
   */
  const engineOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of gameIndex.values()) {
      for (const e of entry.engines) seen.add(e);
    }
    return [...seen]
      .map(id => ({ id, label: getEngineShortLabel(id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [gameIndex]);

  // Switching tournaments can drop the engine the pill selected. Falling back
  // to 'all' beats rendering an empty list under a pill that no longer exists.
  const activeEngine = engineOptions.some(e => e.id === engineFilter) ? engineFilter : 'all';

  const filteredGames = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = (data?.games ?? []).filter(g => {
      if (filter === 'available' && !g.available) return false;
      if (filter === 'cooldown' && g.available) return false;
      const entry = gameIndex.get(g.name);
      if (activeEngine !== 'all' && !(entry?.engines ?? []).includes(activeEngine)) return false;
      if (q && !(entry?.haystack ?? g.name.toLowerCase()).includes(q)) return false;
      return true;
    });
    // Search-relevance work package (2026-08-13): nearest-exact-match first
    // on game name, keeping the chip/other filters above as-is.
    if (q) filtered.sort(compareByRank(q, g => g.name));
    return filtered;
  }, [data, filter, activeEngine, search, gameIndex]);

  const availableCount = data?.games.filter(g => g.available).length ?? 0;
  const cooldownCount = data?.games.filter(g => !g.available).length ?? 0;
  const totalCount = data?.games.length ?? 0;

  const hasPendingPicks = (pickStatus?.pendingPicks.length ?? 0) > 0;
  // Every badge state gets a rendering. `emptyQueue` becomes a soft banner;
  // `ineligible` marks the queued row it refers to (the server only ever flags
  // the head of a queue — that's the row that would actually activate next).
  const emptyQueueAlerts = pickAlerts?.emptyQueue ?? [];
  const ineligibleByGameId = new Map((pickAlerts?.ineligible ?? []).map(i => [i.gameId, i]));

  // Defense-in-depth (plan §3): when gate off the Picks page should not exist.
  // Sprint 7 already hides the nav tab; this covers direct-URL access.
  if (!pickAwardLoading && !pickAwardEnabled && slug) {
    return <Navigate to={`/${slug}`} replace />;
  }

  // Wait for gate state so we never briefly render Picks UI for a disabled room.
  if (pickAwardLoading) {
    return (
      <main className="px-4 sm:px-6 lg:px-10 py-6">
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  const mysteryAvailable = availableCount >= 2;

  return (
    <main className="px-4 sm:px-6 lg:px-10 py-6">
      <Link to={`/${slug}`} className="text-muted text-xs hover:text-neon-cyan no-underline transition-colors">
        &larr; Scoreboard
      </Link>

      {/* v2.77.0 — the title block and the tournament select shared one
          non-wrapping row with no min-w-0, so at 390px a long tournament name
          squeezed the heading into a two-line sliver. Stack them on phones;
          the select goes full-width under the title and keeps sm+ inline. */}
      <div className="mt-3 mb-4 flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-2 sm:gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-xl font-bold text-primary">Picks</h1>
          <p className="text-muted text-xs mt-1">
            Queue your next pick or spin the Mystery Award.
          </p>
        </div>
        {tournaments.length > 1 && (
          <div className="relative w-full sm:w-auto sm:flex-shrink-0">
            <select
              value={selectedTournamentId || ''}
              onChange={(e) => setSelectedTournamentId(e.target.value)}
              className="appearance-none w-full sm:w-auto bg-surface border border-border rounded-lg px-4 py-2 pr-8 text-sm text-primary focus:outline-none focus:border-neon-cyan/50 cursor-pointer"
            >
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          </div>
        )}
      </div>

      {/* Guest-login banner (S5). When the viewer isn't logged in with Discord
          the pick/queue UI is gated off, so a guest sees the Mystery Award spin
          and the game list but no way to actually pick. This explains why and
          offers a one-click login that returns to this same tournament. */}
      {!discordUser && slug && (
        <div className="mb-6 rounded-lg border border-neon-cyan/30 bg-neon-cyan/5 p-4 sm:p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h2 className="font-display text-sm font-bold text-primary">Log in to pick games</h2>
              <p className="text-xs text-muted mt-1">
                Log in to pick games and spin for awards.
              </p>
            </div>
            <LoginButtons
              onDiscordLogin={() => {
                const back = `/${slug}/picks${window.location.search || ''}`;
                loginWithDiscord(slug, back);
              }}
              onGoogleLogin={() => {
                const back = `/${slug}/picks${window.location.search || ''}`;
                loginWithGoogle(slug, back);
              }}
              label="Log in"
              className="flex-shrink-0"
            />
          </div>
        </div>
      )}

      {/* Top-level Mystery Award action (plan §9). Persistent at the top of Picks. */}
      {/* v2.77.0 mobile balance — at 390px the icon + title + description + Spin
          button all fought for one flex row and wrapped into a ragged block.
          Phones now get three stacked bands (chip+title / description /
          full-width Spin); sm+ keeps the original single inline row. */}
      {/* v2.wide-pages — capped (not full-bleed like the table below): at
          1999px a full-width single-row action card left the icon/title/
          description bunched left with the Spin button stranded ~1200px away
          on the far right, an empty card in between. A centered inner cap
          keeps the control strip readable at any viewport width. */}
      <div className="max-w-5xl mx-auto mb-6 rounded-lg border border-neon-green/30 bg-gradient-to-br from-neon-green/5 to-transparent p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
          {/* 2-col grid rather than nested flex rows: the description spans
              both columns on phones (full-width, under the chip+title line)
              and tucks under the title on sm+ — one DOM node either way, so
              no duplicated headings for screen readers. */}
          <div className="min-w-0 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1.5 sm:gap-y-0">
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-neon-green/10 border border-neon-green/30 text-neon-green flex items-center justify-center sm:row-span-2">
              <MysteryAwardIcon size={22} />
            </div>
            <h2 className="font-display text-sm font-bold text-primary min-w-0 sm:self-end">Mystery Award</h2>
            <p className="col-span-2 sm:col-span-1 sm:col-start-2 sm:self-start text-xs text-muted min-w-0">
              {mysteryAvailable
                ? 'Spin for a random pick from the available tables.'
                : 'Needs at least 2 available tables to spin.'}
            </p>
          </div>
          <button
            onClick={() => setShowPicker(true)}
            disabled={!mysteryAvailable}
            className="w-full sm:w-auto sm:flex-shrink-0 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-neon-green/40 bg-neon-green/10 text-neon-green text-sm font-semibold hover:bg-neon-green/20 hover:border-neon-green/60 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <MysteryAwardIcon size={16} />
            Spin
          </button>
        </div>
      </div>

      {/* Next-win disposition (ROADMAP, locked 2026-08-09; extended
          2026-08-17) — "If I win…" control, scoped to the currently-selected
          tournament. One preference, no precedence puzzles.

          Lifetime is SPLIT by type (owner ruling — see
          docs/contracts/pick-delegation-contract.md §5 Q2): "Give my pick to…" fires once
          and clears, while "Forfeit" and "Roll the dice" stand until changed.
          The copy below says so rather than claiming one rule for all three. */}
      {discordUser && selectedTournamentId && (
        <div className="max-w-5xl mx-auto mb-6 rounded-lg border border-border bg-surface p-4 sm:p-5">
          <h2 className="font-display text-sm font-bold text-primary mb-1">If I win…</h2>
          <p className="text-xs text-muted mb-3">
            Default is picking from your own queue. Forfeit and Roll the dice stay set until you
            change them; giving your pick to someone applies to your next win only.
          </p>
          <div className="flex flex-wrap justify-center gap-2 px-2 sm:px-8 pt-1">
            <button
              onClick={clearDisposition}
              disabled={dispositionLoading || !disposition}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer disabled:cursor-default ${
                !disposition
                  ? 'bg-neon-cyan/15 border-neon-cyan/50 text-neon-cyan'
                  : 'border-border text-muted hover:text-primary hover:border-border/80'
              }`}
            >
              Pick from my queue
            </button>
            <button
              onClick={() => saveDisposition({ disposition: 'forfeit' })}
              disabled={dispositionLoading}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer disabled:cursor-default ${
                disposition?.disposition === 'forfeit'
                  ? 'bg-neon-amber/15 border-neon-amber/50 text-neon-amber'
                  : 'border-border text-muted hover:text-primary hover:border-border/80'
              }`}
            >
              Forfeit to runner-up
            </button>
            <button
              onClick={() => saveDisposition({ disposition: 'auto' })}
              disabled={dispositionLoading}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer disabled:cursor-default ${
                disposition?.disposition === 'auto'
                  ? 'bg-neon-green/15 border-neon-green/50 text-neon-green'
                  : 'border-border text-muted hover:text-primary hover:border-border/80'
              }`}
            >
              Roll the dice
            </button>
            <button
              onClick={() => { setShowNomineeInput(v => !v); fetchRoomMembers(); }}
              disabled={dispositionLoading}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors cursor-pointer disabled:cursor-default ${
                disposition?.disposition === 'nominate'
                  ? 'bg-neon-purple/15 border-neon-purple/50 text-neon-purple'
                  : 'border-border text-muted hover:text-primary hover:border-border/80'
              }`}
            >
              Give my pick to…
            </button>
          </div>
          {disposition?.disposition === 'nominate' && !showNomineeInput && (() => {
            const resolved = resolveNominee(disposition.nomineeDiscordId);
            return (
              <p className="text-xs text-muted mt-2 flex items-center flex-wrap gap-1.5">
                <span>Currently set to hand off to</span>
                {resolved ? (
                  <span className="inline-flex items-center gap-1.5">
                    <PlayerAvatar
                      username={resolved.displayName || resolved.userId}
                      discordUserId={resolved.userId}
                      avatarHash={resolved.avatarHash}
                      avatarUrl={resolved.avatarUrl}
                      size={16}
                    />
                    <span className="text-primary font-medium">{resolved.displayName || resolved.userId}</span>
                  </span>
                ) : (
                  <span className="text-primary font-medium">&lt;@{disposition.nomineeDiscordId}&gt;</span>
                )}
                <span>.</span>
              </p>
            );
          })()}
          {showNomineeInput && (
            <div className="mt-3 space-y-3">
              {/* Room-member picker — the common case (nominee already plays
                  here) is search-and-click. Only rendered once the roster has
                  loaded AND has an eligible candidate; a fetch failure or an
                  empty/all-excluded roster falls straight through to the
                  free-text fallback below with no error chrome. */}
              {nomineeCandidates.length > 0 && (
                <MemberAdminPicker
                  members={nomineeCandidates}
                  excludeIds={new Set()}
                  onSelect={(member) => saveDisposition({ disposition: 'nominate', nomineeDiscordId: member.userId })}
                  label="Pick a room member"
                />
              )}
              <div>
                <p className="text-[11px] text-faint mb-1">
                  {nomineeCandidates.length > 0
                    ? 'Not in the list? Enter their Discord username or ID'
                    : 'Anyone in the Discord server — enter their Discord username or ID'}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={nomineeInput}
                    onChange={(e) => setNomineeInput(e.target.value)}
                    placeholder="Discord username or ID"
                    aria-label="Nominee Discord username or ID"
                    className="flex-1 min-w-[200px] bg-bg border border-border rounded-lg px-3 py-1.5 text-xs text-primary placeholder:text-faint focus:outline-none focus:border-neon-purple/50"
                  />
                  <button
                    onClick={handleNomineeSubmit}
                    disabled={dispositionLoading || !nomineeInput.trim()}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-neon-purple/40 bg-neon-purple/10 text-neon-purple hover:bg-neon-purple/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Save
                  </button>
                </div>
                {/* Discord-style typeahead (v2.99.0) — live suggestions as the
                    player types, sourced from the room's linked guild rather
                    than the room roster (catches guild members who haven't
                    played here yet). Purely a fill-and-Save shortcut: picking
                    a row saves immediately, same as the room-member picker
                    above. */}
                {nomineeSuggestions !== null && (
                  nomineeSuggestions.length > 0 ? (
                    <div
                      data-testid="nominee-typeahead"
                      className="mt-2 max-h-56 overflow-y-auto border border-border rounded divide-y divide-border/40"
                    >
                      {nomineeSuggestions.map((s) => (
                        <button
                          key={s.discordUserId}
                          type="button"
                          onClick={() => handleNomineeSuggestionSelect(s)}
                          className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-border/20 transition-colors"
                        >
                          <PlayerAvatar
                            username={s.displayName}
                            discordUserId={s.discordUserId}
                            avatarHash={s.avatarHash}
                            size={24}
                          />
                          <span className="text-sm text-primary truncate flex-1">{s.displayName}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-faint mt-2" data-testid="nominee-typeahead-empty">
                      No matching Discord members
                    </p>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Pending pick banner */}
      {discordUser && hasPendingPicks && (
        <div className="flex items-center gap-2 px-4 py-2.5 mb-4 rounded-lg bg-neon-green/10 border border-neon-green/30">
          <Crosshair size={16} className="text-neon-green flex-shrink-0" />
          <p className="text-xs text-neon-green">
            It's your turn to pick! Select an available game below to activate it.
          </p>
        </div>
      )}

      {/* Empty-queue nudge (v2.77.0). The soft half of the badge: cyan, not
          magenta — nothing is on a clock here, the player just has no next
          pick lined up. One row per tournament so the copy can name it. */}
      {discordUser && emptyQueueAlerts.length > 0 && (
        <div
          data-testid="picks-empty-queue-banner"
          className="mb-4 rounded-lg bg-neon-cyan/5 border border-neon-cyan/25 divide-y divide-neon-cyan/10"
        >
          {emptyQueueAlerts.map(a => (
            <div key={`eq-${a.tournamentId}`} className="flex items-start gap-2 px-4 py-2.5">
              <Clock size={14} className="text-neon-cyan flex-shrink-0 mt-px" />
              <p className="text-xs text-muted min-w-0">
                Nothing queued for <span className="text-primary font-medium">{a.tournamentName}</span> — line up your next pick.
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Your Picks summary */}
      {discordUser && pickStatus && (pickStatus.pendingPicks.length > 0 || pickStatus.queuedGames.length > 0) && (
        <div className="max-w-5xl mx-auto mb-4 bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-border/50 flex items-baseline justify-between gap-2">
            <h2 className="text-xs font-medium text-faint uppercase tracking-wider">Your Picks</h2>
            <span className="text-[10px] text-faint flex-shrink-0">
              up to {pickStatus.queueMax ?? 30} per tournament
            </span>
          </div>
          <div className="divide-y divide-border/20">
            {pickStatus.pendingPicks.map(p => (
              <div key={`pending-${p.pick_slot_id}`} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Crosshair size={14} className="text-neon-green flex-shrink-0" />
                  <span className="text-xs text-muted truncate">{p.tournament_name}</span>
                  {p.won_game_name && (
                    <span className="text-xs text-faint truncate">· won <span className="text-neon-amber">{p.won_game_name}</span></span>
                  )}
                </div>
                <span className="text-xs text-neon-green font-medium flex-shrink-0">Awaiting your pick</span>
              </div>
            ))}
            {pickStatus.queuedGames.map((q, idx) => {
              // v2.77.0 — the badge's (c) condition, made visible. Without the
              // chip this row looks identical to a healthy one right up until
              // maintenance silently skips it.
              const inelig = ineligibleByGameId.get(q.id);
              return (
              <div key={`queued-${q.id}`} className="flex items-center justify-between px-4 py-2.5 gap-2">
                {/* v2.77.0 — wraps to two lines on phones: the game name (the
                    identity of the pick) shares line 1 with the index, the
                    clock and any cooldown chip, and the tournament name drops
                    to line 2 as context. Pre-fix all four competed in one
                    non-wrapping row and the game name lost, rendering as
                    "WHO ..." at 390px — the chip only made it tighter.
                    `order-last` is mobile-only, so sm+ keeps the original
                    tournament-then-game reading order on a single line. */}
                <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-0.5 min-w-0 flex-1">
                  <span className="text-[10px] text-faint w-4 text-center flex-shrink-0">{idx + 1}</span>
                  <Clock size={14} className={`flex-shrink-0 ${inelig || q.held ? 'text-neon-amber' : 'text-neon-cyan'}`} />
                  {q.held ? (
                    <span
                      data-testid={`picks-hold-chip-${q.id}`}
                      title="This pick is in cooldown. It keeps its place at the front of your queue and activates as soon as the cooldown ends — the next eligible game runs meanwhile."
                      className="flex-shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium border border-neon-amber/40 bg-neon-amber/10 text-neon-amber"
                    >
                      On hold &mdash; cooldown{q.daysUntilAvailable ? `, ${q.daysUntilAvailable}d` : ''}
                    </span>
                  ) : inelig ? (
                    <span
                      data-testid={`picks-cooldown-chip-${q.id}`}
                      title="This pick is on cooldown. At the next rotation it goes on hold at the front of your queue and the next eligible game is used instead."
                      className="flex-shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium border border-neon-amber/40 bg-neon-amber/10 text-neon-amber"
                    >
                      On cooldown
                    </span>
                  ) : null}
                  <span className="order-last sm:order-none w-full sm:w-auto pl-6 sm:pl-0 text-xs text-muted truncate min-w-0 sm:max-w-[40%]">
                    {q.tournament_name}
                  </span>
                  <span className="text-xs text-primary font-medium truncate min-w-0 flex-1">{q.game_name}</span>
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => handleMoveQueued(idx, 'up')}
                    disabled={idx === 0 || !!q.held || !!pickStatus.queuedGames[idx - 1]?.held}
                    className="p-1 text-muted hover:text-neon-cyan disabled:opacity-20 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title="Move up"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveQueued(idx, 'down')}
                    disabled={idx === pickStatus.queuedGames.length - 1 || !!q.held || !!pickStatus.queuedGames[idx + 1]?.held}
                    className="p-1 text-muted hover:text-neon-cyan disabled:opacity-20 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title="Move down"
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    onClick={() => handleDeleteQueued(q.id)}
                    className="p-1 text-muted hover:text-neon-magenta transition-colors cursor-pointer"
                    title="Remove from queue"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      )}

      {data && (
        <p className="text-muted text-xs mb-4">
          Games must wait <span className="text-neon-cyan font-medium">{data.eligibilityDays} days</span> between plays in <span className="text-primary font-medium">{data.tournament.name}</span>
        </p>
      )}

      {/* Summary cards / filter chips.
          v2.77.0 — the hard `grid-cols-3` squeezed three stacked label+number
          cards into ~110px each at 390px. Phones now get a single-row chip
          strip (label and count side by side, so each chip needs a fraction of
          the height); sm+ keeps the original three stacked cards. Counts are
          flex-shrink-0 + tabular-nums per the score-containment doctrine —
          the label yields, the number never wraps. */}
      <div className="grid grid-cols-3 sm:grid-cols-3 gap-2 sm:gap-3 mb-6">
        <button
          onClick={() => setFilter('all')}
          className={`bg-surface border rounded-lg px-2 py-2 sm:p-3 flex items-center justify-center gap-1.5 sm:block sm:text-center cursor-pointer transition-colors ${
            filter === 'all' ? 'border-neon-cyan/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider truncate min-w-0 sm:mb-0.5">Total</p>
          <p className="font-display font-bold text-sm sm:text-lg text-primary flex-shrink-0 whitespace-nowrap tabular-nums">{totalCount}</p>
        </button>
        <button
          onClick={() => setFilter(filter === 'available' ? 'all' : 'available')}
          className={`bg-surface border rounded-lg px-2 py-2 sm:p-3 flex items-center justify-center gap-1.5 sm:block sm:text-center cursor-pointer transition-colors ${
            filter === 'available' ? 'border-neon-green/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider truncate min-w-0 sm:mb-0.5">Available</p>
          <p className="font-display font-bold text-sm sm:text-lg text-neon-green flex-shrink-0 whitespace-nowrap tabular-nums">{availableCount}</p>
        </button>
        <button
          onClick={() => setFilter(filter === 'cooldown' ? 'all' : 'cooldown')}
          className={`bg-surface border rounded-lg px-2 py-2 sm:p-3 flex items-center justify-center gap-1.5 sm:block sm:text-center cursor-pointer transition-colors ${
            filter === 'cooldown' ? 'border-neon-amber/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider truncate min-w-0 sm:mb-0.5">Cooldown</p>
          <p className="font-display font-bold text-sm sm:text-lg text-neon-amber flex-shrink-0 whitespace-nowrap tabular-nums">{cooldownCount}</p>
        </button>
      </div>

      {/* Search — matches name, manufacturer, year and the row's chip labels,
          so "Bally", "1992" and "VPX" all find something. */}
      <div className="relative mb-3">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint pointer-events-none" />
        <input
          type="text"
          placeholder="Search by title, manufacturer, year, platform..."
          aria-label="Search games"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full bg-surface border border-border rounded-lg pl-9 pr-4 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/50"
        />
      </div>

      {/* Engine pills. Single-select, ANDed with the availability cards above
          and the search below. One engine means nothing to choose between, so
          the row doesn't render at all. */}
      {engineOptions.length > 1 && (
        <div data-testid="picks-engine-pills" className="flex items-center gap-2 flex-wrap mb-3">
          <button
            onClick={() => setEngineFilter('all')}
            aria-pressed={activeEngine === 'all'}
            className={`px-3 py-1 text-[10px] rounded-full border cursor-pointer transition-colors ${
              activeEngine === 'all'
                ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                : 'border-border text-muted hover:text-primary'
            }`}
          >
            All
          </button>
          {engineOptions.map(opt => (
            <button
              key={opt.id}
              onClick={() => setEngineFilter(activeEngine === opt.id ? 'all' : opt.id)}
              aria-pressed={activeEngine === opt.id}
              className={`px-3 py-1 text-[10px] rounded-full border cursor-pointer transition-colors ${
                activeEngine === opt.id
                  ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                  : 'border-border text-muted hover:text-primary'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {/* Only while something is narrowing the list — the three cards above
          already state the unfiltered totals. */}
      {(search.trim() !== '' || activeEngine !== 'all') && (
        <p className="text-faint text-xs mb-3">
          {filteredGames.length} of {totalCount} games
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="text-center py-16 text-muted">
          {data ? 'No games match your filters.' : 'No game library configured for this tournament.'}
        </div>
      ) : (
        // Phones get a stack of discrete cards (each with its own panel +
        // border, separated by a real gap) because a single tall panel with
        // hairline dividers read as one undifferentiated block. sm+ keeps the
        // original single panel with row dividers.
        <div className="flex flex-col gap-3 sm:block sm:gap-0 sm:bg-surface sm:border sm:border-border sm:rounded-lg sm:overflow-hidden">
          {/* Header */}
          <div className={`hidden sm:grid gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider ${
            discordUser ? 'grid-cols-[1fr_100px_110px_140px_120px_60px]' : 'grid-cols-[1fr_100px_110px_140px_120px]'
          }`}>
            <span>Game</span>
            <span className="text-center">Status</span>
            <span className="text-center">Last Played</span>
            <span className="text-right">All-Time High</span>
            <span className="text-right">Last Winner</span>
            {discordUser && <span className="text-center">Pick</span>}
          </div>
          {filteredGames.map((game) => (
            <div
              key={game.name}
              className="sm:border-b sm:border-border/20 sm:last:border-0"
            >
              {/* Desktop row */}
              <div className={`hidden sm:grid gap-2 px-4 py-3 items-center ${
                discordUser ? 'grid-cols-[1fr_100px_110px_140px_120px_60px]' : 'grid-cols-[1fr_100px_110px_140px_120px]'
              }`}>
                {/* Title never ellipsizes — it wraps. Manufacturer/year and the
                    platform chips sit under it as quiet identity context. */}
                <div className="flex flex-col gap-1 min-w-0">
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(game.name)}`}
                    onClick={handleTitleClick(game)}
                    className="font-medium text-sm break-words leading-tight no-underline text-primary hover:text-neon-cyan transition-colors"
                  >
                    {game.name}
                  </Link>
                  {(game.manufacturer || game.year != null) && (
                    <span className="text-[11px] text-muted break-words leading-tight">
                      {[game.manufacturer, game.year].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  <PlatformChips platforms={game.platforms ?? []} roomTags={game.room_tags} dense uniformStyle emptyFallback={null} />
                </div>
                {/* A bare "12d" doesn't say what the number counts — the
                    caption names it without stealing the number's weight. */}
                <div className="flex flex-col items-center justify-center">
                  {game.available ? (
                    <div className="flex items-center gap-1.5">
                      <CheckCircle size={14} className="text-neon-green flex-shrink-0" />
                      <span className="text-neon-green text-xs font-medium">Available</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5">
                        <Clock size={14} className="text-neon-amber flex-shrink-0" />
                        <span className="text-neon-amber text-xs font-medium">{game.daysUntilAvailable}d</span>
                      </div>
                      <span className="text-faint text-[10px] leading-tight">cooldown</span>
                    </>
                  )}
                </div>
                <div className="flex items-center justify-center gap-1 text-xs text-muted">
                  {game.lastPlayedDate ? (
                    <>
                      <Calendar size={12} className="flex-shrink-0" />
                      <span>{new Date(game.lastPlayedDate).toLocaleDateString()}</span>
                    </>
                  ) : (
                    <span className="text-faint">Never</span>
                  )}
                </div>
                <div className="text-right text-xs">
                  {game.allTimeHigh != null ? (
                    <div className="flex items-center justify-end gap-1">
                      <Star size={12} className="text-neon-amber flex-shrink-0" />
                      <span className="text-primary font-medium flex-shrink-0 whitespace-nowrap tabular-nums">{game.allTimeHigh.toLocaleString()}</span>
                      {game.allTimeHighPlayer && (
                        <span className="text-muted hidden lg:inline truncate min-w-0">({game.allTimeHighPlayer})</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-faint">--</span>
                  )}
                </div>
                <div className="text-right text-xs">
                  {game.winnerName ? (
                    <div className="flex items-center justify-end gap-1">
                      <Trophy size={12} className="text-neon-amber flex-shrink-0" />
                      <span className="text-primary truncate">{game.winnerName}</span>
                    </div>
                  ) : (
                    <span className="text-faint">{game.lastPlayedDate ? (game.lastStatus === 'ACTIVE' ? 'In progress' : '--') : '--'}</span>
                  )}
                </div>
                {discordUser && (
                  <div className="flex items-center justify-center">
                    {game.available ? (
                      <button
                        onClick={() => setPickTarget(game.name)}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-neon-purple/40 bg-neon-purple/10 text-neon-purple hover:bg-neon-purple/20 transition-colors cursor-pointer"
                      >
                        <Crosshair size={12} />
                        Pick
                      </button>
                    ) : (
                      <span className="text-faint text-[10px]">--</span>
                    )}
                  </div>
                )}
              </div>

              {/* Mobile card */}
              <div className="sm:hidden bg-surface border border-border rounded-lg px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex flex-col gap-1 min-w-0">
                    <Link
                      to={`/${slug}/games/${encodeURIComponent(game.name)}`}
                      onClick={handleTitleClick(game)}
                      className="font-medium text-sm break-words no-underline text-primary hover:text-neon-cyan transition-colors leading-tight"
                    >
                      {game.name}
                    </Link>
                    {(game.manufacturer || game.year != null) && (
                      <span className="text-[11px] text-muted break-words leading-tight">
                        {[game.manufacturer, game.year].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <PlatformChips platforms={game.platforms ?? []} roomTags={game.room_tags} dense uniformStyle emptyFallback={null} />
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0">
                    {game.available ? (
                      <div className="flex items-center gap-1">
                        <CheckCircle size={14} className="text-neon-green" />
                        <span className="text-neon-green text-xs font-medium">Available</span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1">
                          <Clock size={14} className="text-neon-amber" />
                          <span className="text-neon-amber text-xs font-medium">{game.daysUntilAvailable}d</span>
                        </div>
                        <span className="text-faint text-[10px] leading-tight">cooldown</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
                  <div>
                    <span className="text-faint">Played</span>
                    <p className="text-muted">{game.lastPlayedDate ? new Date(game.lastPlayedDate).toLocaleDateString() : 'Never'}</p>
                  </div>
                  <div>
                    <span className="text-faint">High Score</span>
                    <p className="text-primary whitespace-nowrap tabular-nums">{game.allTimeHigh != null ? game.allTimeHigh.toLocaleString() : '--'}</p>
                  </div>
                  <div>
                    <span className="text-faint">Winner</span>
                    <p className="text-primary truncate">{game.winnerName || '--'}</p>
                  </div>
                </div>
                {/* Centered on the card's bottom edge — it's the card's one
                    action, so it reads as a footer rather than another inline
                    detail competing with the stats grid above it. */}
                {discordUser && game.available && (
                  <div className="mt-3 pt-3 border-t border-border/40 flex justify-center">
                    <button
                      onClick={() => setPickTarget(game.name)}
                      className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded text-[11px] font-medium border border-neon-purple/40 bg-neon-purple/10 text-neon-purple hover:bg-neon-purple/20 transition-colors cursor-pointer"
                    >
                      <Crosshair size={12} />
                      Pick Game
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Peek at a game to confirm it's the one you meant, then close and pick
          up exactly where you left off — no navigation, so scroll position and
          the active filters survive. */}
      {quickView && (
        <GameQuickView
          lb={{
            gameName: quickView.name,
            imageUrl: quickView.image_url ?? null,
            globalGameId: quickView.global_game_id ?? null,
          }}
          slug={slug || ''}
          highlightStat={{
            label: 'All-Time High',
            value: quickView.allTimeHigh ?? null,
            player: quickView.allTimeHighPlayer,
          }}
          onClose={() => setQuickView(null)}
        />
      )}

      {showPicker && data && (
        <MysteryAward
          availableGames={data.games.filter(g => g.available).map(g => g.name)}
          onClose={() => setShowPicker(false)}
          roomName={roomName}
          backglassUrl={roomLogoUrl}
          onPickGame={discordUser ? (name) => { setShowPicker(false); setPickTarget(name); } : undefined}
        />
      )}

      {/* Pick game modal */}
      {pickTarget && pickStatus && (
        <PickGameModal
          gameName={pickTarget}
          tournaments={pickStatus.tournaments.map(t => ({ id: t.id, name: t.name, type: t.type, mode: t.mode }))}
          pendingPicks={pickStatus.pendingPicks}
          selectedTournamentId={selectedTournamentId}
          onConfirm={handlePickConfirm}
          onClose={() => setPickTarget(null)}
        />
      )}
    </main>
  );
}
