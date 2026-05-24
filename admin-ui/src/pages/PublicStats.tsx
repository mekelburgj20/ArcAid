import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import PlayerNameLink from '../components/PlayerNameLink';
import { Trophy, Flame, Users, Gamepad2, Zap, Clock } from 'lucide-react';

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

  const [players, setPlayers] = useState<PlayerSummary[]>([]);
  const [games, setGames] = useState<GameActivity[]>([]);
  const [overview, setOverview] = useState<StatsOverview | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    fetch('/api/rooms')
      .then(r => r.json())
      .then(async (rooms: Array<{ id: string; slug: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (!found) return;
        const [playersRes, gamesRes, overviewRes] = await Promise.all([
          fetch(`/api/rooms/${found.id}/stats/enhanced/players`).then(r => r.ok ? r.json() : []),
          fetch(`/api/rooms/${found.id}/stats/games-activity`).then(r => r.ok ? r.json() : []),
          fetch(`/api/rooms/${found.id}/stats/overview`).then(r => r.ok ? r.json() : null),
        ]);
        setPlayers(playersRes || []);
        setGames(gamesRes || []);
        setOverview(overviewRes);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [slug]);

  const setView = (v: View) => {
    const next = new URLSearchParams(params);
    if (v === 'games') next.set('view', 'games');
    else next.delete('view');
    setParams(next, { replace: true });
  };

  const filteredPlayers = players.filter(p =>
    (p.iscored_username || p.discord_user_id).toLowerCase().includes(search.toLowerCase())
  );
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
