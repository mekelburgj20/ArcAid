import { useEffect, useState, useCallback } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle, Clock, Trophy, Calendar, ChevronDown, ChevronUp, Star, Crosshair, X } from 'lucide-react';
import MysteryAward from '../components/MysteryAward';
import PickGameModal from '../components/PickGameModal';
import LoginButtons from '../components/LoginButtons';
import { MysteryAwardIcon } from '../assets/icons/ThemedIcons';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { useToast } from '../components/Toast';
import { getPortal } from '../lib/portal';

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
}

interface PickStatusData {
  pendingPicks: PendingPick[];
  queuedGames: QueuedGame[];
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
  const [showPicker, setShowPicker] = useState(false);

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

  const filteredGames = data?.games.filter(g => {
    if (filter === 'available' && !g.available) return false;
    if (filter === 'cooldown' && g.available) return false;
    if (search && !g.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }) ?? [];

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
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      </main>
    );
  }

  const mysteryAvailable = availableCount >= 2;

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
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
      <div className="mb-6 rounded-lg border border-neon-green/30 bg-gradient-to-br from-neon-green/5 to-transparent p-4 sm:p-5">
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
        <div className="mb-4 bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-border/50">
            <h2 className="text-xs font-medium text-faint uppercase tracking-wider">Your Picks</h2>
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
                  <Clock size={14} className={`flex-shrink-0 ${inelig ? 'text-neon-amber' : 'text-neon-cyan'}`} />
                  {inelig && (
                    <span
                      data-testid={`picks-cooldown-chip-${q.id}`}
                      title="This pick is on cooldown and would be skipped at the next rotation."
                      className="flex-shrink-0 whitespace-nowrap px-1.5 py-0.5 rounded text-[10px] font-medium border border-neon-amber/40 bg-neon-amber/10 text-neon-amber"
                    >
                      On cooldown
                    </span>
                  )}
                  <span className="order-last sm:order-none w-full sm:w-auto pl-6 sm:pl-0 text-xs text-muted truncate min-w-0 sm:max-w-[40%]">
                    {q.tournament_name}
                  </span>
                  <span className="text-xs text-primary font-medium truncate min-w-0 flex-1">{q.game_name}</span>
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button
                    onClick={() => handleMoveQueued(idx, 'up')}
                    disabled={idx === 0}
                    className="p-1 text-muted hover:text-neon-cyan disabled:opacity-20 disabled:cursor-not-allowed transition-colors cursor-pointer"
                    title="Move up"
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    onClick={() => handleMoveQueued(idx, 'down')}
                    disabled={idx === pickStatus.queuedGames.length - 1}
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

      {/* Search */}
      <input
        type="text"
        placeholder="Search games..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full bg-surface border border-border rounded-lg px-4 py-2 text-sm text-primary placeholder:text-faint mb-4 focus:outline-none focus:border-neon-cyan/50"
      />

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      ) : filteredGames.length === 0 ? (
        <div className="text-center py-16 text-muted">
          {data ? 'No games match your search.' : 'No game library configured for this tournament.'}
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
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
              className="border-b border-border/20 last:border-0"
            >
              {/* Desktop row */}
              <div className={`hidden sm:grid gap-2 px-4 py-3 items-center ${
                discordUser ? 'grid-cols-[1fr_100px_110px_140px_120px_60px]' : 'grid-cols-[1fr_100px_110px_140px_120px]'
              }`}>
                <div className="flex items-center gap-2 min-w-0">
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(game.name)}`}
                    className="font-medium text-sm truncate no-underline text-primary hover:text-neon-cyan transition-colors"
                  >
                    {game.name}
                  </Link>
                </div>
                <div className="flex items-center justify-center gap-1.5">
                  {game.available ? (
                    <>
                      <CheckCircle size={14} className="text-neon-green flex-shrink-0" />
                      <span className="text-neon-green text-xs font-medium">Available</span>
                    </>
                  ) : (
                    <>
                      <Clock size={14} className="text-neon-amber flex-shrink-0" />
                      <span className="text-neon-amber text-xs font-medium">{game.daysUntilAvailable}d</span>
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
                        className="inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 transition-colors cursor-pointer"
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
              <div className="sm:hidden px-4 py-3">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Link
                    to={`/${slug}/games/${encodeURIComponent(game.name)}`}
                    className="font-medium text-sm no-underline text-primary hover:text-neon-cyan transition-colors leading-tight"
                  >
                    {game.name}
                  </Link>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {game.available ? (
                      <>
                        <CheckCircle size={14} className="text-neon-green" />
                        <span className="text-neon-green text-xs font-medium">Available</span>
                      </>
                    ) : (
                      <>
                        <Clock size={14} className="text-neon-amber" />
                        <span className="text-neon-amber text-xs font-medium">{game.daysUntilAvailable}d</span>
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
                {discordUser && game.available && (
                  <button
                    onClick={() => setPickTarget(game.name)}
                    className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 transition-colors cursor-pointer"
                  >
                    <Crosshair size={12} />
                    Pick Game
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
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
