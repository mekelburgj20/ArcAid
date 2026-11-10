import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Circle } from 'lucide-react';
import { playerName } from '../components/ScoreboardComponents';
import { TournamentTypeBadge } from '../components/TournamentTypeBadge';
import GameArt from '../components/GameArt';
import RankLine from '../components/results/RankLine';
import RunFeed from '../components/results/RunFeed';
import { RESULTS_PAGE } from '../lib/pageLayout';
import { useRoom } from '../contexts/RoomContext';

/**
 * `/:slug/tournaments/:tournamentId` — one tournament's results.
 *
 * v2.238.0 (B24) — two views:
 *   - **Runs** (default): the tournament's finished runs. v2.241.0 (B26):
 *     a week at a time as cards with their final standings open
 *     (`components/results/RunFeed`, shared with History). `?run=<gameId>`
 *     deep-links one run: the card chip, the past-games pile, Lobby result
 *     items and Discord close posts all point here, and the server answers
 *     the week that holds it.
 *   - **By table** (`?view=tables`): every score submitted during the
 *     tournament, one board per table, runs merged ("Featured N×"). The boards
 *     are scoped by `submitted_during_tournament_id` server-side, so a player's
 *     all-time best on a game does not leak into a tournament they didn't play
 *     (see `TournamentScoresService`).
 *
 * A switcher in the header moves between the room's tournaments.
 */

interface ScoreRow {
  rank: number;
  discord_user_id: string;
  iscored_username: string;
  display_name: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  score: number;
  created_at: string | null;
}

interface Board {
  game_key: string;
  game_name: string;
  /** v2.240.0 (B25): the table's art. */
  image_url?: string | null;
  slot_count: number;
  start_date: string | null;
  end_date: string | null;
  status: string | null;
  winner: ScoreRow | null;
  scores: ScoreRow[];
}

interface TournamentScores {
  tournament: {
    id: string;
    name: string;
    type: string;
    is_active: boolean;
    first_start: string | null;
    last_end: string | null;
  };
  boards: Board[];
}

interface TournamentOption {
  id: string;
  name: string;
  is_active?: number | boolean;
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Jan 1 – Feb 3, 2026", collapsing to a single date when both ends match. */
function dateRange(from: string | null, to: string | null): string | null {
  const a = shortDate(from);
  const b = shortDate(to);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a || b;
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
    </div>
  );
}

function TablesView({ slug, boards }: { slug: string | undefined; boards: Board[] }) {
  if (boards.length === 0) {
    return <p className="text-muted text-center py-12">No scores were submitted during this tournament.</p>;
  }
  return (
    <div className="grid gap-5 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] items-start">
      {boards.map(board => {
        const slotRange = dateRange(board.start_date, board.end_date);
        return (
          <section key={board.game_key} className="bg-surface border border-border rounded-xl overflow-hidden shadow-lg shadow-black/20">
            <div className="p-4 border-b border-border/60 flex items-center gap-4 min-w-0">
              <GameArt src={board.image_url} name={board.game_name} size={80} mobileSize={64} />
              <div className="min-w-0 flex-1 flex flex-col gap-1">
                <Link
                  to={`/${slug}/games/${encodeURIComponent(board.game_name)}`}
                  className="min-w-0 break-words font-display font-bold text-lg sm:text-xl leading-tight text-primary hover:text-neon-cyan transition-colors no-underline"
                >
                  {board.game_name}
                </Link>
                <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-faint">
                  {board.slot_count > 1 && (
                    <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-neon-cyan">
                      Featured {board.slot_count}×
                    </span>
                  )}
                  {slotRange && <span className="whitespace-nowrap">{slotRange}</span>}
                </span>
              </div>
            </div>

            <div className="divide-y divide-border/20">
              {board.scores.map(row => (
                <RankLine
                  key={`${row.iscored_username}-${row.rank}-${row.score}`}
                  slug={slug}
                  rank={row.rank}
                  username={row.iscored_username}
                  label={playerName(row)}
                  score={row.score}
                  date={row.created_at}
                  avatar={{ discordUserId: row.discord_user_id, avatarHash: row.avatar_hash, avatarUrl: row.avatar_url }}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function TournamentDetail() {
  const { roomSlug, roomId } = useRoom();
  const { tournamentId } = useParams<{ tournamentId: string }>();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const view: 'runs' | 'tables' = params.get('view') === 'tables' ? 'tables' : 'runs';
  const [data, setData] = useState<TournamentScores | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);

  useEffect(() => {
    if (!roomId || !tournamentId) return;
    setLoading(true);
    setNotFound(false);
    fetch(`/api/rooms/${roomId}/tournaments/${tournamentId}/scores`)
      .then(r => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.ok ? r.json() : null;
      })
      .then(json => setData(json))
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [roomId, tournamentId]);

  // The switcher's list. Optional: the page works without it.
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/tournaments`)
      .then(r => (r.ok ? r.json() : []))
      .then((rows: unknown) => {
        if (cancelled || !Array.isArray(rows)) return;
        const list = (rows as TournamentOption[])
          .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string')
          // Running tournaments first, then by name.
          .sort((a, b) => (Number(!!b.is_active) - Number(!!a.is_active)) || a.name.localeCompare(b.name));
        setTournaments(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  const backLink = (
    <Link
      to={`/${roomSlug}/history`}
      className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
    >
      <ChevronLeft size={16} />
      History
    </Link>
  );

  if (loading) {
    return (
      <main className={`${RESULTS_PAGE} py-6`}>
        {backLink}
        <Spinner />
      </main>
    );
  }

  if (notFound || !data || !roomId || !tournamentId) {
    return (
      <main className={`${RESULTS_PAGE} py-6`}>
        {backLink}
        <p className="text-muted text-center py-12">
          Tournament not found.
        </p>
      </main>
    );
  }

  const { tournament, boards } = data;
  const range = dateRange(tournament.first_start, tournament.last_end);
  const setView = (next: 'runs' | 'tables') => {
    // Switching views drops the run/week of the other one.
    setParams(next === 'tables' ? new URLSearchParams({ view: 'tables' }) : new URLSearchParams());
  };
  const tabClass = (on: boolean) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
      on ? 'bg-raised text-primary font-medium shadow-sm' : 'text-muted hover:text-primary'
    }`;

  return (
    <main className={`${RESULTS_PAGE} py-6`}>
      {backLink}

      <header className="mt-3 mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display text-2xl sm:text-3xl font-bold text-primary min-w-0 break-words">
              {tournament.name}
            </h1>
            <TournamentTypeBadge type={tournament.type} />
            {tournament.is_active && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-neon-magenta" role="status">
                {/* `.pulse` is already nulled under prefers-reduced-motion by
                    index.css's global guard — no extra media query needed. */}
                <Circle className="pulse h-2 w-2 shrink-0 fill-current" strokeWidth={0} aria-hidden="true" data-testid="live-dot" />
                LIVE
              </span>
            )}
          </div>
          {range && <p className="mt-1 text-xs text-faint">{range}</p>}
        </div>
        {tournaments.length > 1 && (
          <select
            aria-label="Tournament"
            value={tournament.id}
            onChange={e => navigate(`/${roomSlug}/tournaments/${encodeURIComponent(e.target.value)}${view === 'tables' ? '?view=tables' : ''}`)}
            className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60 w-full sm:w-auto sm:max-w-[16rem] flex-shrink-0"
          >
            {tournaments.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
      </header>

      <div className="mb-5 inline-flex gap-1 p-1 rounded-lg bg-surface border border-border" role="group" aria-label="View">
        <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')} className={tabClass(view === 'runs')}>
          Runs
        </button>
        <button type="button" aria-pressed={view === 'tables'} onClick={() => setView('tables')} className={tabClass(view === 'tables')}>
          By table
        </button>
      </div>

      {view === 'runs'
        ? <RunFeed key={tournamentId} roomId={roomId} slug={roomSlug} tournamentId={tournamentId} showTournament={false} />
        : <TablesView slug={roomSlug} boards={boards} />}
    </main>
  );
}
