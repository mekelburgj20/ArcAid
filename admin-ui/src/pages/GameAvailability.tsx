import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle, Clock, Trophy, Calendar, ChevronDown, Shuffle, Star, Crosshair } from 'lucide-react';
import PinballPicker from '../components/PinballPicker';
import PickGameModal from '../components/PickGameModal';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useToast } from '../components/Toast';

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
  tournament_id: string;
  tournament_name: string;
  picker_type: string;
  picker_designated_at: string;
}

interface QueuedGame {
  game_name: string;
  tournament_id: string;
  tournament_name: string;
}

interface PickStatusData {
  pendingPicks: PendingPick[];
  queuedGames: QueuedGame[];
  tournaments: Array<{ id: string; name: string; type: string; mode: string; max_active_games: number; platform_rules: string }>;
}

export default function GameAvailability() {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [selectedTournamentId, setSelectedTournamentId] = useState<string | null>(searchParams.get('t'));
  const [data, setData] = useState<AvailabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'available' | 'cooldown'>('all');
  const [search, setSearch] = useState('');
  const [showPicker, setShowPicker] = useState(false);

  // Pick game state
  const { discordUser, playerToken } = useViewerAuth();
  const { toast } = useToast();
  const [pickStatus, setPickStatus] = useState<PickStatusData | null>(null);
  const [pickTarget, setPickTarget] = useState<string | null>(null);

  // Resolve room
  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (found) setRoomId(found.id);
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
        setTournaments(ts.filter((t: any) => t.is_active));
        if (!selectedTournamentId && ts.length > 0) {
          const active = ts.filter((t: any) => t.is_active);
          if (active.length > 0) setSelectedTournamentId(active[0]!.id);
        }
      })
      .catch(() => {});
  }, [roomId]);

  // Load availability data
  useEffect(() => {
    if (!roomId || !selectedTournamentId) return;
    setLoading(true);
    setSearchParams(selectedTournamentId ? { t: selectedTournamentId } : {});
    fetch(`/api/rooms/${roomId}/game-availability/${selectedTournamentId}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId, selectedTournamentId]);

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
    if (selectedTournamentId) {
      fetch(`/api/rooms/${roomId}/game-availability/${selectedTournamentId}`)
        .then(r => r.json())
        .then(setData)
        .catch(() => {});
    }
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

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      <Link to={`/${slug}`} className="text-muted text-xs hover:text-neon-cyan no-underline transition-colors">
        &larr; Scoreboard
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mt-3 mb-6">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-xl font-bold text-primary">Game Availability</h1>
          {availableCount >= 2 && (
            <button
              onClick={() => setShowPicker(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-neon-green/40 bg-neon-green/10 text-neon-green text-xs font-medium hover:bg-neon-green/20 hover:border-neon-green/60 transition-colors cursor-pointer"
            >
              <Shuffle size={14} />
              Pick Random
            </button>
          )}
        </div>

        {tournaments.length > 1 && (
          <div className="relative">
            <select
              value={selectedTournamentId || ''}
              onChange={(e) => setSelectedTournamentId(e.target.value)}
              className="w-full appearance-none bg-surface border border-border rounded-lg px-4 py-2 pr-8 text-sm text-primary focus:outline-none focus:border-neon-cyan/50 cursor-pointer"
            >
              {tournaments.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          </div>
        )}
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

      {/* Your Picks summary */}
      {discordUser && pickStatus && (pickStatus.pendingPicks.length > 0 || pickStatus.queuedGames.length > 0) && (
        <div className="mb-4 bg-surface border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-border/50">
            <h2 className="text-xs font-medium text-faint uppercase tracking-wider">Your Picks</h2>
          </div>
          <div className="divide-y divide-border/20">
            {pickStatus.pendingPicks.map(p => (
              <div key={`pending-${p.tournament_id}`} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Crosshair size={14} className="text-neon-green flex-shrink-0" />
                  <span className="text-xs text-muted truncate">{p.tournament_name}</span>
                </div>
                <span className="text-xs text-neon-green font-medium flex-shrink-0">Awaiting your pick</span>
              </div>
            ))}
            {pickStatus.queuedGames.map(q => (
              <div key={`queued-${q.tournament_id}-${q.game_name}`} className="flex items-center justify-between px-4 py-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Clock size={14} className="text-neon-cyan flex-shrink-0" />
                  <span className="text-xs text-muted truncate">{q.tournament_name}</span>
                </div>
                <span className="text-xs text-primary font-medium truncate ml-2">{q.game_name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && (
        <p className="text-muted text-xs mb-4">
          Games must wait <span className="text-neon-cyan font-medium">{data.eligibilityDays} days</span> between plays in <span className="text-primary font-medium">{data.tournament.name}</span>
        </p>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <button
          onClick={() => setFilter(filter === 'all' ? 'all' : 'all')}
          className={`bg-surface border rounded-lg p-3 text-center cursor-pointer transition-colors ${
            filter === 'all' ? 'border-neon-cyan/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider mb-0.5">Total</p>
          <p className="font-display font-bold text-lg text-primary">{totalCount}</p>
        </button>
        <button
          onClick={() => setFilter(filter === 'available' ? 'all' : 'available')}
          className={`bg-surface border rounded-lg p-3 text-center cursor-pointer transition-colors ${
            filter === 'available' ? 'border-neon-green/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider mb-0.5">Available</p>
          <p className="font-display font-bold text-lg text-neon-green">{availableCount}</p>
        </button>
        <button
          onClick={() => setFilter(filter === 'cooldown' ? 'all' : 'cooldown')}
          className={`bg-surface border rounded-lg p-3 text-center cursor-pointer transition-colors ${
            filter === 'cooldown' ? 'border-neon-amber/50' : 'border-border hover:border-border/80'
          }`}
        >
          <p className="text-faint text-[10px] uppercase tracking-wider mb-0.5">Cooldown</p>
          <p className="font-display font-bold text-lg text-neon-amber">{cooldownCount}</p>
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
                      <span className="text-primary font-medium">{game.allTimeHigh.toLocaleString()}</span>
                      {game.allTimeHighPlayer && (
                        <span className="text-muted hidden lg:inline">({game.allTimeHighPlayer})</span>
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
                    <p className="text-primary">{game.allTimeHigh != null ? game.allTimeHigh.toLocaleString() : '--'}</p>
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
        <PinballPicker
          availableGames={data.games.filter(g => g.available).map(g => g.name)}
          onClose={() => setShowPicker(false)}
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
