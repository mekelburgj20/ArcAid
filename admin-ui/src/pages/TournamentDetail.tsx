import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, Circle } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import { playerName, PlayerAvatar } from '../components/ScoreboardComponents';
import { TournamentTypeBadge } from '../components/TournamentTypeBadge';
import GameArt from '../components/GameArt';
import { useRoom } from '../contexts/RoomContext';

/**
 * `/:slug/tournaments/:tournamentId` — one tournament's results.
 *
 * v2.238.0 (B24) — two views:
 *   - **Runs** (default): every finished run of the tournament, newest first
 *     (date, table, winner, players). A row opens that run's final standings,
 *     read from the run's own board (`GET /:roomId/leaderboard/:gameId`, the
 *     board its card showed). `?run=<gameId>` deep-links one run open: the
 *     card chip, the past-games pile, History rows, Lobby result items and
 *     Discord close posts all point here. The list comes from `/history`
 *     filtered to this tournament, so its winners follow the same rule as
 *     History's.
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

/** One finished run: a `/history` row. */
interface RunRow {
  game_id: string;
  game_name: string;
  start_date: string | null;
  end_date: string | null;
  winner_name: string | null;
  winner_username: string | null;
  winner_score: number | null;
  players: number;
  /** v2.240.0 (B25): the table's art and the winner's avatar. */
  image_url?: string | null;
  winner_discord_user_id?: string | null;
  winner_avatar_hash?: string | null;
  winner_avatar_url?: string | null;
}

interface RunsResponse {
  results: RunRow[];
  total: number;
  page: number;
  limit: number;
}

/** A row of a run's board (`RankedEntry` on the server). */
interface RunEntry {
  rank: number;
  iscored_username: string;
  display_name: string | null;
  discord_user_id?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
  score: number;
}

/** What `RankLine` needs to draw a player's avatar. */
interface AvatarSource {
  discordUserId?: string | null;
  avatarHash?: string | null;
  avatarUrl?: string | null;
}

interface TournamentOption {
  id: string;
  name: string;
  is_active?: number | boolean;
}

const RUNS_PER_PAGE = 20;

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Tue, Nov 3", with the year only when it isn't this year's. */
function runDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

/** "Jan 1 – Feb 3, 2026", collapsing to a single date when both ends match. */
function dateRange(from: string | null, to: string | null): string | null {
  const a = shortDate(from);
  const b = shortDate(to);
  if (a && b) return a === b ? a : `${a} – ${b}`;
  return a || b;
}

const RANK_TINT = (rank: number) =>
  rank === 1 ? 'text-neon-amber' : rank === 2 ? 'text-neon-cyan' : rank === 3 ? 'text-neon-green' : 'text-faint';

/**
 * One ranked line, shared by both views. Stats surface: the rank number
 * carries the podium, no trophy icons (owner call, 2026-08-02). The score is
 * content-sized and never shrinks; the name beside it yields instead.
 */
function RankLine({ slug, rank, username, label, score, date, avatar }: {
  slug: string | undefined;
  rank: number;
  username: string;
  label: string;
  score: number;
  /** By table only: when the score was set. Omitted on a run's board. */
  date?: string | null;
  /** v2.240.0 (B25): the player's avatar, beside the rank. */
  avatar?: AvatarSource;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={`font-display font-bold text-sm w-6 text-center flex-shrink-0 ${RANK_TINT(rank)}`}>
        {rank}
      </span>
      {avatar && (
        <PlayerAvatar
          username={label}
          discordUserId={avatar.discordUserId}
          avatarHash={avatar.avatarHash}
          avatarUrl={avatar.avatarUrl}
          size={26}
        />
      )}
      {/* Name + date share the ONE flexible column: stacked on phones (where
          an inline date would starve the name), inline from `sm` up. */}
      <span className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2">
        <Link
          to={`/${slug}/players/${encodeURIComponent(username)}`}
          className={`min-w-0 truncate text-sm no-underline hover:text-neon-cyan transition-colors ${
            rank === 1 ? 'text-neon-amber font-medium' : 'text-primary'
          }`}
        >
          {label}
        </Link>
        {date !== undefined && (
          <span className="flex-shrink-0 whitespace-nowrap text-xs text-faint">
            {shortDate(date) || '—'}
          </span>
        )}
      </span>
      <span
        className={`ml-auto flex-shrink-0 whitespace-nowrap tabular-nums font-display font-bold text-sm ${
          rank === 1 ? 'text-neon-amber' : 'text-primary'
        }`}
        title={scoreTitle(score)}
      >
        {formatScore(score)}
      </span>
    </div>
  );
}

function Spinner() {
  return (
    <div className="flex justify-center py-12">
      <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
    </div>
  );
}

/**
 * A run's final standings, loaded when the row opens. Mounted per open run
 * (inside the run's keyed row), so `gameId` never changes under an instance.
 */
function RunBoard({ roomId, slug, gameId }: { roomId: string; slug: string | undefined; gameId: string }) {
  const [rows, setRows] = useState<RunEntry[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/rooms/${roomId}/leaderboard/${encodeURIComponent(gameId)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((json: { rankings?: RunEntry[] }) => { if (!cancelled) setRows(json.rankings ?? []); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [roomId, gameId]);

  if (failed) return <p className="px-4 py-4 text-sm text-faint">Couldn&apos;t load this run&apos;s standings.</p>;
  if (!rows) return <div className="px-4 py-4 text-sm text-faint">Loading standings…</div>;
  if (rows.length === 0) return <p className="px-4 py-4 text-sm text-faint">Nobody posted a score in this run.</p>;
  return (
    <div className="divide-y divide-border/20" data-testid="run-board">
      {rows.map(row => (
        <RankLine
          key={`${row.iscored_username}-${row.rank}`}
          slug={slug}
          rank={row.rank}
          username={row.iscored_username}
          label={playerName(row)}
          score={row.score}
          avatar={{ discordUserId: row.discord_user_id, avatarHash: row.avatar_hash, avatarUrl: row.avatar_url }}
        />
      ))}
    </div>
  );
}

function RunsView({ roomId, slug, tournamentId }: { roomId: string; slug: string | undefined; tournamentId: string }) {
  const [params, setParams] = useSearchParams();
  const openRun = params.get('run');
  const pageParam = params.get('page');
  // A deep link names a run but no page: the server answers the page that
  // holds the run. Once a page is explicit (paging, or opening a row) the
  // server is not asked to jump again.
  const jumpTo = pageParam ? null : openRun;
  // The response is stored with the request it answers, so "loading" is
  // derived (a new request key with no answer yet) rather than set in the
  // effect.
  const requestKey = `${pageParam ?? ''}|${jumpTo ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; data: RunsResponse } | null>(null);
  const data = loaded?.data ?? null;
  const loading = loaded?.key !== requestKey;
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({
      tournament_id: tournamentId,
      limit: String(RUNS_PER_PAGE),
      page: String(Math.max(1, Number(pageParam) || 1)),
    });
    if (jumpTo) q.set('run', jumpTo);
    const empty: RunsResponse = { results: [], total: 0, page: 1, limit: RUNS_PER_PAGE };
    const key = `${pageParam ?? ''}|${jumpTo ?? ''}`;
    fetch(`/api/rooms/${roomId}/history?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: RunsResponse | null) => {
        if (!cancelled) setLoaded({ key, data: json && Array.isArray(json.results) ? json : empty });
      })
      .catch(() => { if (!cancelled) setLoaded({ key, data: empty }); });
    return () => { cancelled = true; };
  }, [roomId, tournamentId, pageParam, jumpTo]);

  // Bring a deep-linked run into view once, the first time it renders.
  useEffect(() => {
    if (!openRun || scrolledFor.current === openRun || !data) return;
    const el = document.getElementById(`run-${openRun}`);
    if (!el) return;
    scrolledFor.current = openRun;
    el.scrollIntoView?.({ block: 'start' });
  }, [data, openRun]);

  const page = data?.page ?? 1;
  const totalPages = data ? Math.ceil(data.total / RUNS_PER_PAGE) : 0;

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k); else next.set(k, v);
    }
    setParams(next);
  };
  const toggleRun = (gameId: string) => {
    scrolledFor.current = gameId; // a click is not a deep link: don't scroll
    update({ run: openRun === gameId ? null : gameId, page: String(page) });
  };

  if (loading && !data) return <Spinner />;
  if (!data || data.results.length === 0) {
    return <p className="text-muted text-center py-12">No finished runs yet.</p>;
  }

  return (
    <>
      <ol className="bg-surface border border-border rounded-lg overflow-hidden divide-y divide-border/40" aria-label="Runs, newest first">
        {data.results.map(run => {
          const open = openRun === run.game_id;
          const panelId = `run-panel-${run.game_id}`;
          // `scroll-mt-28` clears the sticky site header (taller on phones).
          return (
            <li key={run.game_id} id={`run-${run.game_id}`} className="scroll-mt-28">
              <button
                type="button"
                onClick={() => toggleRun(run.game_id)}
                aria-expanded={open}
                aria-controls={panelId}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 cursor-pointer transition-colors hover:bg-raised/50 ${open ? 'bg-raised/40' : ''}`}
              >
                <GameArt src={run.image_url} name={run.game_name} size={52} />
                <span className="min-w-0 flex-1 flex flex-col gap-1">
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="min-w-0 truncate font-display font-bold text-sm text-primary">{run.game_name}</span>
                    <span className="ml-auto flex-shrink-0 whitespace-nowrap text-xs text-faint">{runDate(run.end_date)}</span>
                  </span>
                  <span className="flex items-center gap-2 min-w-0 text-sm">
                    {run.winner_name ? (
                      <>
                        <PlayerAvatar
                          username={run.winner_name}
                          discordUserId={run.winner_discord_user_id}
                          avatarHash={run.winner_avatar_hash}
                          avatarUrl={run.winner_avatar_url}
                          size={20}
                        />
                        <span className="min-w-0 truncate text-neon-amber font-medium">{run.winner_name}</span>
                        <span className="flex-shrink-0 whitespace-nowrap tabular-nums font-display text-neon-amber" title={scoreTitle(run.winner_score)}>
                          {formatScore(run.winner_score)}
                        </span>
                      </>
                    ) : (
                      <span className="text-faint">No scores</span>
                    )}
                    <span className="ml-auto flex-shrink-0 whitespace-nowrap text-xs text-faint">
                      {run.players} {run.players === 1 ? 'player' : 'players'}
                    </span>
                  </span>
                </span>
                <ChevronDown
                  size={16}
                  aria-hidden="true"
                  className={`flex-shrink-0 text-faint transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
                />
              </button>
              {open && (
                <div id={panelId} className="border-t border-border/30 bg-deep/30">
                  <div className="flex items-center gap-2 px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-faint">
                    <span>Final standings</span>
                    {run.start_date && run.end_date && (
                      <span className="ml-auto normal-case tracking-normal text-xs">{dateRange(run.start_date, run.end_date)}</span>
                    )}
                  </div>
                  <RunBoard roomId={roomId} slug={slug} gameId={run.game_id} />
                  <div className="px-4 py-2 border-t border-border/20">
                    <Link
                      to={`/${slug}/games/${encodeURIComponent(run.game_name)}`}
                      className="text-xs text-muted hover:text-neon-cyan no-underline transition-colors"
                    >
                      {run.game_name} game page
                    </Link>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-4 mt-2">
          <span className="text-muted text-sm">Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => update({ page: String(Math.max(1, page - 1)) })}
              disabled={page <= 1}
              className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Newer
            </button>
            <button
              onClick={() => update({ page: String(Math.min(totalPages, page + 1)) })}
              disabled={page >= totalPages}
              className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Older
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function TablesView({ slug, boards }: { slug: string | undefined; boards: Board[] }) {
  if (boards.length === 0) {
    return <p className="text-muted text-center py-12">No scores were submitted during this tournament.</p>;
  }
  return (
    <div className="space-y-4">
      {boards.map(board => {
        const slotRange = dateRange(board.start_date, board.end_date);
        return (
          <section key={board.game_key} className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* Card header stacks on phones: sharing one line with the slot
                date range left the game name a ~90px sliver. */}
            <div className="px-4 py-3 border-b border-border/50 flex items-center gap-3 min-w-0">
              <GameArt src={board.image_url} name={board.game_name} size={40} />
              <div className="min-w-0 flex-1 flex flex-col sm:flex-row sm:items-baseline gap-x-2">
              <span className="flex items-baseline gap-2 min-w-0">
                <Link
                  to={`/${slug}/games/${encodeURIComponent(board.game_name)}`}
                  className="min-w-0 truncate font-display font-bold text-sm text-primary hover:text-neon-cyan transition-colors no-underline"
                >
                  {board.game_name}
                </Link>
                {board.slot_count > 1 && (
                  <span className="flex-shrink-0 whitespace-nowrap text-[10px] uppercase tracking-wider text-neon-cyan">
                    Featured {board.slot_count}×
                  </span>
                )}
              </span>
              {slotRange && (
                <span className="sm:ml-auto flex-shrink-0 whitespace-nowrap text-xs text-faint">{slotRange}</span>
              )}
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
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {backLink}
        <Spinner />
      </main>
    );
  }

  if (notFound || !data || !roomId || !tournamentId) {
    return (
      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
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
    // Switching views drops the run/page of the other one.
    setParams(next === 'tables' ? new URLSearchParams({ view: 'tables' }) : new URLSearchParams());
  };
  const tabClass = (on: boolean) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
      on ? 'bg-raised text-primary font-medium shadow-sm' : 'text-muted hover:text-primary'
    }`;

  return (
    <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
      {backLink}

      <header className="mt-3 mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="font-display text-xl sm:text-2xl font-bold text-primary min-w-0 break-words">
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

      <div className="mb-4 inline-flex gap-1 p-1 rounded-lg bg-surface border border-border" role="group" aria-label="View">
        <button type="button" aria-pressed={view === 'runs'} onClick={() => setView('runs')} className={tabClass(view === 'runs')}>
          Runs
        </button>
        <button type="button" aria-pressed={view === 'tables'} onClick={() => setView('tables')} className={tabClass(view === 'tables')}>
          By table
        </button>
      </div>

      {view === 'runs'
        ? <RunsView key={tournamentId} roomId={roomId} slug={roomSlug} tournamentId={tournamentId} />
        : <TablesView slug={roomSlug} boards={boards} />}
    </main>
  );
}
