import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { formatScore, scoreTitle } from '../../lib/format';
import { tournamentResultsPath } from '../../lib/tournamentLinks';
import { PlayerAvatar, playerName } from '../ScoreboardComponents';
import { TournamentTypeBadge } from '../TournamentTypeBadge';
import GameArt from '../GameArt';
import RankLine from './RankLine';

/**
 * Past runs a WEEK at a time, one card per run with its final standings open
 * (v2.241.0, B26; owner 2026-11-10). Shared by History (every tournament,
 * `showTournament`) and the tournament page's Runs view (one tournament).
 *
 * - Week 0 is the seven days ending at the newest run in the filter; Newer /
 *   Older step a week at a time (`?week=N`). A deep link `?run=<gameId>` with
 *   no `week` asks the server for the week that holds that run, and that card
 *   opens and scrolls into view.
 * - Every card's standings are open by default. One button collapses or
 *   expands them all (remembered on this device); a card's own chevron still
 *   opens or closes just that card.
 * - Data: `GET /:roomId/history?week=N&standings=1`. Winners and standings
 *   come from each run's own board (`LeaderboardService.getRunStandings`), so
 *   rank 1 is always the winner shown in the card's header.
 */

export interface RunStanding {
  rank: number;
  iscored_username: string;
  display_name: string | null;
  score: number;
  discord_user_id?: string | null;
  avatar_hash?: string | null;
  avatar_url?: string | null;
}

export interface RunCardData {
  game_id: string;
  tournament_id: string | null;
  game_name: string;
  tournament_name: string;
  tournament_type: string;
  start_date: string | null;
  end_date: string | null;
  image_url?: string | null;
  winner_name: string | null;
  winner_username?: string | null;
  winner_score: number | null;
  winner_discord_user_id?: string | null;
  winner_avatar_hash?: string | null;
  winner_avatar_url?: string | null;
  players: number;
  standings?: RunStanding[];
}

interface RunWeek {
  results: RunCardData[];
  total: number;
  week: number;
  window: { from: string; to: string } | null;
  has_newer: boolean;
  has_older: boolean;
}

const COLLAPSED_KEY = 'arcaid-results-collapsed';

function readCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
}
function writeCollapsed(value: boolean): void {
  try { localStorage.setItem(COLLAPSED_KEY, value ? '1' : '0'); } catch { /* private mode: not remembered */ }
}

function sameYear(d: Date): boolean {
  return d.getFullYear() === new Date().getFullYear();
}

/** "Tue, Nov 3", with the year only when it isn't this year's. */
function runDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', year: sameYear(d) ? undefined : 'numeric',
  });
}

/** "Nov 3 – Nov 10" for a week window (`from` is exclusive). */
function weekLabel(window: { from: string; to: string }): string {
  const from = new Date(Date.parse(window.from) + 1);
  const to = new Date(window.to);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: sameYear(d) ? undefined : 'numeric',
  });
  return `${fmt(from)} – ${fmt(to)}`;
}

export default function RunFeed({ roomId, slug, tournamentId, type, showTournament, emptyText = 'No finished runs yet.' }: {
  roomId: string;
  slug: string | undefined;
  /** Only this tournament's runs. */
  tournamentId?: string;
  /** Only tournaments with this tag. */
  type?: string;
  /** Name each card's tournament (History lists every tournament). */
  showTournament: boolean;
  emptyText?: string;
}) {
  const [params, setParams] = useSearchParams();
  const openRun = params.get('run');
  const weekParam = params.get('week');
  const week = Math.max(0, Number(weekParam) || 0);
  // A deep link names a run but no week: the server answers the run's week.
  const jumpTo = weekParam === null ? openRun : null;

  const requestKey = `${roomId}|${tournamentId ?? ''}|${type ?? ''}|${week}|${jumpTo ?? ''}`;
  const [loaded, setLoaded] = useState<{ key: string; data: RunWeek } | null>(null);
  const data = loaded?.data ?? null;
  const loading = loaded?.key !== requestKey;

  const [allCollapsed, setAllCollapsed] = useState<boolean>(readCollapsed);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const scrolledFor = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams({ week: String(week), standings: '1' });
    if (tournamentId) q.set('tournament_id', tournamentId);
    if (type) q.set('type', type);
    if (jumpTo) q.set('run', jumpTo);
    const empty: RunWeek = { results: [], total: 0, week, window: null, has_newer: false, has_older: false };
    const key = `${roomId}|${tournamentId ?? ''}|${type ?? ''}|${week}|${jumpTo ?? ''}`;
    fetch(`/api/rooms/${roomId}/history?${q}`)
      .then(r => (r.ok ? r.json() : null))
      .then((json: RunWeek | null) => {
        if (!cancelled) setLoaded({ key, data: json && Array.isArray(json.results) ? json : empty });
      })
      .catch(() => { if (!cancelled) setLoaded({ key, data: empty }); });
    return () => { cancelled = true; };
  }, [roomId, tournamentId, type, week, jumpTo]);

  // Bring a deep-linked run into view once, the first time it renders.
  useEffect(() => {
    if (!openRun || scrolledFor.current === openRun || !data) return;
    const el = document.getElementById(`run-${openRun}`);
    if (!el) return;
    scrolledFor.current = openRun;
    el.scrollIntoView?.({ block: 'start' });
  }, [data, openRun]);

  const isOpen = (id: string) => overrides[id] ?? (id === openRun ? true : !allCollapsed);

  const toggleAll = () => {
    const next = !allCollapsed;
    setAllCollapsed(next);
    setOverrides({});
    writeCollapsed(next);
  };
  const toggleOne = (id: string) => setOverrides(o => ({ ...o, [id]: !isOpen(id) }));

  const goWeek = (next: number) => {
    const p = new URLSearchParams(params);
    if (next <= 0) p.delete('week'); else p.set('week', String(next));
    // Leaving the deep-linked week: the run is no longer the page's subject.
    p.delete('run');
    setParams(p);
    setOverrides({});
    scrolledFor.current = null;
  };

  if (loading && !data) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }
  if (!data || !data.window) {
    return <p className="text-muted text-center py-12">{emptyText}</p>;
  }

  const shownWeek = data.week;
  const count = data.results.length;
  const nav = (where: 'top' | 'bottom') => (
    <div className={`flex flex-wrap items-center gap-2 ${where === 'top' ? 'mb-5' : 'mt-6'}`}>
      <button
        type="button"
        onClick={() => goWeek(shownWeek - 1)}
        disabled={!data.has_newer}
        className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        <ChevronLeft size={16} aria-hidden="true" /> Newer
      </button>
      <div className="min-w-0 px-2 text-center" aria-live="polite">
        <div className="font-display font-bold text-base sm:text-lg text-primary whitespace-nowrap">{weekLabel(data.window!)}</div>
        <div className="text-xs text-faint">
          {shownWeek === 0 ? 'Latest week · ' : ''}{count} {count === 1 ? 'game' : 'games'}
        </div>
      </div>
      <button
        type="button"
        onClick={() => goWeek(shownWeek + 1)}
        disabled={!data.has_older}
        className="inline-flex items-center gap-1 px-3 py-2 text-sm rounded-lg border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        Older <ChevronRight size={16} aria-hidden="true" />
      </button>
      {where === 'top' && count > 0 && (
        <button
          type="button"
          onClick={toggleAll}
          className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors cursor-pointer"
        >
          <ChevronDown size={16} aria-hidden="true" className={allCollapsed ? '' : 'rotate-180'} />
          {allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      )}
    </div>
  );

  return (
    <section aria-label="Past runs" className={loading ? 'opacity-60 transition-opacity' : ''}>
      {nav('top')}
      {count === 0 ? (
        <p className="text-muted text-center py-12 border border-dashed border-border rounded-xl">
          No games finished in this week.
        </p>
      ) : (
        <ol className="grid gap-5 grid-cols-[minmax(0,1fr)] xl:grid-cols-[repeat(2,minmax(0,1fr))] items-start" aria-label="Runs, newest first">
          {data.results.map(run => (
            <li key={run.game_id} className="min-w-0">
              <RunCard
                run={run}
                slug={slug}
                showTournament={showTournament}
                open={isOpen(run.game_id)}
                highlight={run.game_id === openRun}
                onToggle={() => toggleOne(run.game_id)}
              />
            </li>
          ))}
        </ol>
      )}
      {count > 4 && nav('bottom')}
    </section>
  );
}

function RunCard({ run, slug, showTournament, open, highlight, onToggle }: {
  run: RunCardData;
  slug: string | undefined;
  showTournament: boolean;
  open: boolean;
  highlight: boolean;
  onToggle: () => void;
}) {
  const panelId = `run-panel-${run.game_id}`;
  const standings = run.standings ?? [];
  return (
    <article
      id={`run-${run.game_id}`}
      data-testid="run-card"
      className={`scroll-mt-28 bg-surface border rounded-xl overflow-hidden shadow-lg shadow-black/20 ${
        highlight ? 'border-neon-cyan/60 ring-2 ring-neon-cyan/30' : 'border-border'
      }`}
    >
      <header className="flex items-start gap-4 p-4">
        <GameArt src={run.image_url} name={run.game_name} size={112} mobileSize={84} />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <Link
              to={`/${slug}/games/${encodeURIComponent(run.game_name)}`}
              className="min-w-0 break-words font-display font-bold text-lg sm:text-xl leading-tight text-primary hover:text-neon-cyan no-underline transition-colors"
            >
              {run.game_name}
            </Link>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={panelId}
              aria-label={`${open ? 'Hide' : 'Show'} ${run.game_name} final standings`}
              className="ml-auto -mr-1 -mt-1 flex-shrink-0 p-1.5 rounded-lg text-faint hover:text-primary hover:bg-raised transition-colors cursor-pointer"
            >
              <ChevronDown size={18} aria-hidden="true" className={`transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
            </button>
          </div>
          {showTournament && (
            <div className="flex items-center gap-2 min-w-0">
              <TournamentTypeBadge type={run.tournament_type} />
              {run.tournament_id && slug ? (
                <Link
                  to={tournamentResultsPath(slug, run.tournament_id)}
                  className="min-w-0 truncate text-sm text-muted hover:text-neon-cyan no-underline transition-colors"
                >
                  {run.tournament_name}
                </Link>
              ) : (
                <span className="min-w-0 truncate text-sm text-muted">{run.tournament_name}</span>
              )}
            </div>
          )}
          <div className="text-xs text-faint">
            {runDate(run.end_date)} · {run.players} {run.players === 1 ? 'player' : 'players'}
          </div>
          <div className="flex items-center gap-2.5 min-w-0 mt-1">
            {run.winner_name ? (
              <>
                <PlayerAvatar
                  username={run.winner_name}
                  discordUserId={run.winner_discord_user_id}
                  avatarHash={run.winner_avatar_hash}
                  avatarUrl={run.winner_avatar_url}
                  size={36}
                />
                <span className="min-w-0 truncate text-base font-medium text-neon-amber">{run.winner_name}</span>
                <span
                  className="flex-shrink-0 whitespace-nowrap tabular-nums font-display font-bold text-base text-neon-amber"
                  title={scoreTitle(run.winner_score)}
                >
                  {formatScore(run.winner_score)}
                </span>
              </>
            ) : (
              <span className="text-sm text-faint">No scores</span>
            )}
          </div>
        </div>
      </header>
      {open && (
        <div id={panelId} data-testid="run-board" className="border-t border-border/60 bg-deep/30">
          <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-faint">Final standings</div>
          {standings.length === 0 ? (
            <p className="px-4 pb-4 pt-1 text-sm text-faint">Nobody posted a score in this run.</p>
          ) : (
            <div className="divide-y divide-border/20">
              {standings.map(row => (
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
          )}
        </div>
      )}
    </article>
  );
}
