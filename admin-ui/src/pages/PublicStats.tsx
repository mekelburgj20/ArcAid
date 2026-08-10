import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PlayerNameLink from '../components/PlayerNameLink';
import { Trophy, Flame, Users, Gamepad2, Zap, Clock, History, X } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { STATS_RANGE_PRESETS, presetToRange, weekInputToRange, type StatsRangePreset } from '../lib/statsWindow';

interface PlayerSummary {
  discord_user_id: string;
  iscored_username: string | null;
  /** v2.8.0: user-chosen global display name. */
  display_name?: string | null;
  games_played: number;
  wins: number;
  avg_finish_position: number;
  top5_rate: number;
  champion_streak: number;
}

interface GameActivity {
  name: string;
  submissions: number;
  players: number;
  top_score: number;
  last_activity: string | null;
}

interface StatsOverview {
  totalPlaysWeek: number;
  activePlayersWeek: number;
  hottestGame: { name: string; submissions: number } | null;
  latestSubmission: { iscored_username: string; display_name: string | null; score: number; game_name: string; created_at: string } | null;
}

interface TournamentOption {
  id: string;
  type: string;
}

type View = 'players' | 'games';

function abbreviateScore(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toLocaleString();
}

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return 'Just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function PublicStats() {
  const { slug } = useParams<{ slug: string }>();
  const [params, setParams] = useSearchParams();
  const view: View = params.get('view') === 'games' ? 'games' : 'players';

  // v2.9x — tournament-type + time-window filters. URL-stated (shareable,
  // survives reload): `type` is a single tournament type (e.g. "DG") or
  // absent for "all types"; `week` (an <input type="week"> value, e.g.
  // "2026-W32") takes precedence over `range` when both are present, since a
  // specific-week pick is a more deliberate choice than a leftover preset.
  // Absent `range` defaults to "all" — today's unfiltered behavior.
  const typeFilter = params.get('type') || '';
  const weekFilter = params.get('week') || '';
  const rangeFilter = (params.get('range') as StatsRangePreset) || 'all';

  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [games, setGames] = useState<GameActivity[]>([]);
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [tournamentTypes, setTournamentTypes] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const { roomId } = useRoom();

  // Distinct tournament types for the chip row. Fetched once per room — the
  // set of types rarely changes and this endpoint is already public/cheap
  // (Rankings.tsx uses the same one for its tournament picker).
  useEffect(() => {
    if (!roomId) return;
    fetch(`/api/rooms/${roomId}/tournaments`)
      .then(r => r.ok ? r.json() : [])
      .then((rows: TournamentOption[]) => {
        const types = Array.from(new Set((rows || []).map(t => t.type).filter(Boolean))).sort();
        setTournamentTypes(types);
      })
      .catch(() => {});
  }, [roomId]);

  // `week` wins over `range` (see comment above); `weekInputToRange` returning
  // null for a malformed/partial value (e.g. mid-typing) falls back to "all"
  // rather than sending a bad `from`/`to` to the BE.
  const dateWindow = useMemo(() => {
    if (weekFilter) return weekInputToRange(weekFilter) ?? {};
    return presetToRange(rangeFilter);
  }, [weekFilter, rangeFilter]);

  const filtersActive = !!typeFilter || !!weekFilter || rangeFilter !== 'all';

  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    const qs = new URLSearchParams();
    if (typeFilter) qs.set('type', typeFilter);
    if (dateWindow.from) qs.set('from', dateWindow.from);
    if (dateWindow.to) qs.set('to', dateWindow.to);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    (async () => {
      const [playersRes, gamesRes, overviewRes] = await Promise.all([
        fetch(`/api/rooms/${roomId}/stats/enhanced/players${suffix}`).then(r => r.ok ? r.json() : []),
        fetch(`/api/rooms/${roomId}/stats/games-activity${suffix}`).then(r => r.ok ? r.json() : []),
        fetch(`/api/rooms/${roomId}/stats/overview`).then(r => r.ok ? r.json() : null),
      ]);
      setPlayers(playersRes || []);
      setGames(gamesRes || []);
      setOverview(overviewRes);
    })()
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [roomId, typeFilter, dateWindow.from, dateWindow.to]);

  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === 'games') next.set('view', 'games');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  const setTypeFilter = (type: string) => {
    const next = new URLSearchParams(params);
    if (type) next.set('type', type);
    else next.delete('type');
    setParams(next, { replace: true });
  };

  const setRangePreset = (preset: StatsRangePreset) => {
    const next = new URLSearchParams(params);
    next.delete('week'); // a preset click overrides any specific-week pick
    if (preset === 'all') next.delete('range');
    else next.set('range', preset);
    setParams(next, { replace: true });
  };

  const setWeekFilter = (week: string) => {
    const next = new URLSearchParams(params);
    if (week) { next.set('week', week); next.delete('range'); }
    else next.delete('week');
    setParams(next, { replace: true });
  };

  const clearFilters = () => {
    const next = new URLSearchParams(params);
    next.delete('type');
    next.delete('range');
    next.delete('week');
    setParams(next, { replace: true });
  };

  const q = search.toLowerCase();
  const filteredPlayers = players.filter(p => {
    const shown = (p.display_name || p.iscored_username || `User ${p.discord_user_id.slice(-4)}`).toLowerCase();
    return shown.includes(q)
      || (p.iscored_username || '').toLowerCase().includes(q)
      || (p.display_name || '').toLowerCase().includes(q)
      || p.discord_user_id.toLowerCase().includes(q);
  });
  const filteredGames = games.filter(g => g.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div>
      {/* v2.1.0 Stats Combo — purpose + overview cards above the tabs. */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2">
        <p className="text-xs text-muted mb-4">
          How this room's doing. Pulse of the week above; drill into players and games below.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <OverviewCard
            icon={<Zap size={14} className="text-neon-cyan" />}
            label="Plays this week"
            value={overview ? overview.totalPlaysWeek.toLocaleString() : '—'}
            sub={overview ? `${overview.activePlayersWeek} player${overview.activePlayersWeek === 1 ? '' : 's'}` : null}
          />
          <OverviewCard
            icon={<Users size={14} className="text-neon-green" />}
            label="Active players"
            value={overview ? overview.activePlayersWeek.toLocaleString() : '—'}
            sub="past 7 days"
          />
          <OverviewCard
            icon={<Flame size={14} className="text-neon-magenta" />}
            label="Hottest game"
            value={overview?.hottestGame?.name ?? '—'}
            sub={overview?.hottestGame ? `${overview.hottestGame.submissions} submission${overview.hottestGame.submissions === 1 ? '' : 's'}` : null}
            truncate
          />
          <OverviewCard
            icon={<Clock size={14} className="text-neon-amber" />}
            label="Latest"
            value={overview?.latestSubmission
              ? abbreviateScore(overview.latestSubmission.score)
              : '—'}
            sub={overview?.latestSubmission
              ? `${overview.latestSubmission.display_name || overview.latestSubmission.iscored_username} · ${formatRelative(overview.latestSubmission.created_at)}`
              : null}
            truncate
          />
        </div>
      </div>

      {/* Page Header + toggle + search */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-2 flex flex-col gap-3 sm:flex-row sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl font-bold">Stats</h2>
          <div role="tablist" className="flex bg-raised border border-border rounded overflow-hidden">
            <button
              role="tab"
              aria-selected={view === 'players'}
              onClick={() => setView('players')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                view === 'players' ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-muted hover:text-primary'
              }`}
            >
              <Users size={12} />
              Players
            </button>
            <button
              role="tab"
              aria-selected={view === 'games'}
              onClick={() => setView('games')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors cursor-pointer ${
                view === 'games' ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-muted hover:text-primary'
              }`}
            >
              <Gamepad2 size={12} />
              Games
            </button>
            <Link
              to={`/${slug}/history`}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors text-muted hover:text-primary no-underline"
            >
              <History size={12} />
              History
            </Link>
          </div>
        </div>
        <input
          type="text"
          placeholder={view === 'players' ? 'Search players...' : 'Search games...'}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none w-full sm:w-60"
        />
      </div>

      {/* v2.9x — tournament-type + time-window filters. Applies to both
          Players and Games views (composes: type AND window). URL-stated —
          see the param handling above. */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pb-4 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-faint mr-1">Type</span>
          <button
            onClick={() => setTypeFilter('')}
            className={`px-2.5 py-1 rounded-full text-xs border transition-colors cursor-pointer ${
              !typeFilter ? 'border-neon-cyan bg-neon-cyan/15 text-neon-cyan' : 'border-border text-muted hover:text-primary hover:border-primary/40'
            }`}
          >
            All
          </button>
          {tournamentTypes.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors cursor-pointer ${
                typeFilter === t ? 'border-neon-cyan bg-neon-cyan/15 text-neon-cyan' : 'border-border text-muted hover:text-primary hover:border-primary/40'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-faint mr-1">Period</span>
          {STATS_RANGE_PRESETS.map(p => (
            <button
              key={p.value}
              onClick={() => setRangePreset(p.value)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors cursor-pointer ${
                !weekFilter && rangeFilter === p.value ? 'border-neon-cyan bg-neon-cyan/15 text-neon-cyan' : 'border-border text-muted hover:text-primary hover:border-primary/40'
              }`}
            >
              {p.label}
            </button>
          ))}
          <label className="flex items-center gap-1.5 ml-1">
            <span className="text-[10px] uppercase tracking-wider text-faint">or week</span>
            <input
              type="week"
              value={weekFilter}
              onChange={e => setWeekFilter(e.target.value)}
              aria-label="Specific week"
              className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary focus:border-neon-cyan focus:outline-none"
            />
          </label>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-faint hover:text-primary transition-colors cursor-pointer"
            >
              <X size={11} />
              Clear filters
            </button>
          )}
        </div>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : view === 'players' ? (
          filteredPlayers.length === 0 ? (
            <p className="text-muted text-center py-12">No players found.</p>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              <div className="hidden sm:grid grid-cols-[40px_1fr_80px_80px_70px_70px_60px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                <span className="text-center">#</span>
                <span>Player</span>
                <span className="text-center">Games</span>
                <span className="text-center">Avg Finish</span>
                <span className="text-center">Top 5 %</span>
                <span className="text-center">Streak</span>
                <span className="text-center">Wins</span>
              </div>
              {filteredPlayers.map((p, i) => {
                const name = p.display_name || p.iscored_username || `User ${p.discord_user_id.slice(-4)}`;
                return (
                  <PlayerNameLink
                    key={p.iscored_username || p.discord_user_id}
                    slug={slug || ''}
                    entry={{
                      // v2.13.16 — iscored_username drives URL + modal fetch.
                      // Falls back to discord_user_id when player has no
                      // iScored alias (endpoint auto-detects either format).
                      // display_name carries the pre-resolved human name so
                      // the modal header reads correctly. PlayerSummary
                      // doesn't carry avatar_hash; modal renders a fallback.
                      iscored_username: p.iscored_username || p.discord_user_id,
                      display_name: name,
                      discord_user_id: p.discord_user_id,
                    }}
                    className="grid grid-cols-[40px_1fr_auto] sm:grid-cols-[40px_1fr_80px_80px_70px_70px_60px] gap-2 px-4 py-3 border-b border-border/20 last:border-0 items-center hover:bg-raised/50 transition-colors no-underline group"
                  >
                    <span className="text-faint font-display font-bold text-center">{i + 1}</span>
                    <span className="font-medium text-sm text-primary group-hover:text-neon-cyan transition-colors truncate">{name}</span>
                    <span className="hidden sm:block text-center text-sm text-muted">{p.games_played}</span>
                    <span className="hidden sm:block text-center text-sm text-muted">{p.avg_finish_position.toFixed(1)}</span>
                    <span className="hidden sm:block text-center text-sm text-muted">{Math.round(p.top5_rate * 100)}%</span>
                    <span className="hidden sm:flex items-center justify-center gap-1 text-sm">
                      {p.champion_streak > 0 ? (
                        <>
                          <Flame size={14} className="text-neon-amber" />
                          <span className="text-neon-amber font-medium">{p.champion_streak}</span>
                        </>
                      ) : (
                        <span className="text-faint">0</span>
                      )}
                    </span>
                    <span className="flex items-center justify-end sm:justify-center gap-1 text-sm">
                      <Trophy size={14} className="text-neon-green sm:hidden" />
                      <span className="font-display font-bold text-neon-green">{p.wins}</span>
                    </span>
                  </PlayerNameLink>
                );
              })}
            </div>
          )
        ) : (
          filteredGames.length === 0 ? (
            <p className="text-muted text-center py-12">No game activity yet.</p>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              <div className="hidden sm:grid grid-cols-[40px_1fr_90px_90px_100px_90px] gap-2 px-4 py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider">
                <span className="text-center">#</span>
                <span>Game</span>
                <span className="text-center">Submissions</span>
                <span className="text-center">Players</span>
                <span className="text-center">Top Score</span>
                <span className="text-center">Last</span>
              </div>
              {filteredGames.map((g, i) => (
                <Link
                  key={g.name}
                  to={`/${slug}/games/${encodeURIComponent(g.name)}`}
                  className="grid grid-cols-[40px_1fr_auto] sm:grid-cols-[40px_1fr_90px_90px_100px_90px] gap-2 px-4 py-3 border-b border-border/20 last:border-0 items-center hover:bg-raised/50 transition-colors no-underline group"
                >
                  <span className="text-faint font-display font-bold text-center">{i + 1}</span>
                  <span className="font-medium text-sm text-primary group-hover:text-neon-cyan transition-colors truncate">{g.name}</span>
                  <span className="hidden sm:block text-center text-sm text-muted">{g.submissions}</span>
                  <span className="hidden sm:block text-center text-sm text-muted">{g.players}</span>
                  <span className="hidden sm:block text-center text-sm font-display text-neon-amber" title={g.top_score.toLocaleString()}>
                    {g.top_score > 0 ? abbreviateScore(g.top_score) : '—'}
                  </span>
                  <span className="hidden sm:block text-center text-xs text-faint">{formatRelative(g.last_activity)}</span>
                  <span className="sm:hidden text-xs text-faint text-right">{g.submissions} ·&nbsp;{g.players}p</span>
                </Link>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}

/**
 * v2.1.0 — small summary card for the Stats page overview row.
 */
function OverviewCard({
  icon,
  label,
  value,
  sub,
  truncate,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string | null;
  truncate?: boolean;
}) {
  return (
    <div className="bg-surface border border-border rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-faint uppercase tracking-wider">
        {icon}
        <span>{label}</span>
      </div>
      <p className={`font-display text-sm text-primary mt-1 ${truncate ? 'truncate' : ''}`} title={truncate ? value : undefined}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted mt-0.5 truncate">{sub}</p>}
    </div>
  );
}
