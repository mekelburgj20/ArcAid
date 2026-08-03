import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, Trophy } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import { TournamentTypeBadge as TypeBadge, TOURNAMENT_TYPE_COLORS } from '../components/TournamentTypeBadge';
import { useRoom } from '../contexts/RoomContext';

interface HistoryEntry {
  /** v2.76: ids ship so each row can link through to the tournament's boards. */
  game_id: string | null;
  tournament_id: string | null;
  game_name: string;
  tournament_name: string;
  tournament_type: string;
  start_date: string;
  end_date: string;
  winner_name: string | null;
  winner_score: number | null;
}

interface HistoryResponse {
  results: HistoryEntry[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Grid cells for the desktop table.
 *
 * Padding lives on the cell rather than on a grid gap, so a row's hover
 * highlight reads as one continuous band instead of a striped one.
 *
 * `self-stretch` is what keeps the dividers unbroken: without it each cell is
 * only as tall as its own content (a badge is shorter than a line of text, an
 * empty header cell has no height at all), so the per-cell bottom borders sit
 * at different heights and the rule reads as a dashed line.
 */
const HEAD_CELL = 'flex items-center self-stretch py-2 border-b border-border/50 text-[10px] text-faint uppercase tracking-wider';
const CELL = 'flex items-center self-stretch min-w-0 py-3 border-b border-border/20 transition-colors group-hover:bg-raised/50';

/**
 * Rows whose `tournament_id` is null (pre-v2.76 responses, or a legacy row) stay
 * non-interactive rather than linking to a page that can't resolve.
 */
function rowLink(item: HistoryEntry, slug: string | undefined): string | null {
  return item.tournament_id && slug ? `/${slug}/tournaments/${item.tournament_id}` : null;
}

const rowLabel = (item: HistoryEntry) => `${item.tournament_name} — ${item.game_name} scores`;
const rowKey = (item: HistoryEntry, i: number) => `${item.game_name}-${item.end_date}-${i}`;

/** Short, unambiguous, and narrow enough to sit beside a 12-digit score. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PublicHistory() {
  const { roomId, roomSlug } = useRoom();
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState('');
  const limit = 20;

  useEffect(() => {
    if (!roomId) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (typeFilter) params.set('type', typeFilter);

    fetch(`/api/rooms/${roomId}/history?${params}`)
      .then(r => r.ok ? r.json() : { results: [], total: 0, page: 1, limit })
      .then(setData)
      .catch(() => setData({ results: [], total: 0, page: 1, limit }))
      .finally(() => setLoading(false));
  }, [roomId, page, typeFilter]);

  const totalPages = data ? Math.ceil(data.total / limit) : 0;
  // Static list (matches TypeBadge's known types) rather than deriving from
  // the current page's results — deriving from paginated/filtered data would
  // make the filter's own options shrink once a filter is applied.
  const tournamentTypes = Object.keys(TOURNAMENT_TYPE_COLORS);

  return (
    <div>
      {/* Page Header + filter */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 pt-6 pb-2 flex flex-col gap-3 sm:flex-row sm:items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-display text-xl font-bold">History</h2>
          <span className="text-xs text-muted">
            {data ? `${data.total} completed game${data.total !== 1 ? 's' : ''}` : ''}
          </span>
        </div>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(1); }}
          className="bg-raised border border-border rounded px-3 py-2 text-sm text-primary focus:outline-none focus:border-neon-cyan/60 w-full sm:w-auto"
        >
          <option value="">All Types</option>
          {tournamentTypes.map(type => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : !data || data.results.length === 0 ? (
          <p className="text-muted text-center py-12">No completed games found.</p>
        ) : (
          <div className="bg-surface border border-border rounded-lg overflow-hidden">
            {/* ── Mobile: three stacked lines per row ──────────────────────
                Everything the owner asked to see (winner, score, completed
                date) is present WITHOUT a horizontal squeeze. Five columns on
                one 390px line is what crushed the tournament name and wrapped
                the type tag in the first place. */}
            <div className="sm:hidden">
              {data.results.map((item, i) => {
                const winner = item.winner_name;
                const to = rowLink(item, roomSlug);
                const body = (
                  <div className="flex flex-col gap-1 min-w-0">
                    {/* The type tag is pushed to the right edge rather than
                        sitting inline after the name, so the tags line up down
                        the list instead of starting at a name-dependent
                        offset — and the name gets every pixel up to it. The
                        badge's own `flex-shrink-0 whitespace-nowrap` still
                        keeps it from wrapping. */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="min-w-0 truncate font-medium text-sm text-primary">{item.game_name}</span>
                      <span className="ml-auto flex-shrink-0">
                        <TypeBadge type={item.tournament_type} />
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className={`flex items-center gap-1 min-w-0 text-sm ${winner ? 'text-neon-green font-medium' : 'text-faint'}`}>
                        {winner ? <Trophy size={12} className="flex-shrink-0" /> : null}
                        <span className="min-w-0 truncate">{winner || 'No submissions'}</span>
                      </span>
                      <span
                        className="ml-auto flex-shrink-0 whitespace-nowrap tabular-nums text-sm font-display text-neon-amber"
                        title={scoreTitle(item.winner_score)}
                      >
                        {formatScore(item.winner_score)}
                      </span>
                    </div>
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className="min-w-0 truncate text-xs text-muted">{item.tournament_name}</span>
                      <span className="ml-auto flex-shrink-0 whitespace-nowrap text-xs text-faint">
                        {shortDate(item.end_date)}
                      </span>
                    </div>
                  </div>
                );
                const shell = 'block px-4 py-3 border-b border-border/20 last:border-0';
                return to ? (
                  <Link
                    key={rowKey(item, i)}
                    to={to}
                    aria-label={rowLabel(item)}
                    className={`${shell} no-underline hover:bg-raised/50 transition-colors cursor-pointer`}
                  >
                    {body}
                  </Link>
                ) : (
                  <div key={rowKey(item, i)} className={shell}>{body}</div>
                );
              })}
            </div>

            {/* ── Desktop: header + rows share ONE grid ────────────────────
                Two sibling grids with the same template still drift, because
                each sizes its own `auto` tracks to its own content — the label
                "COMPLETED" is wider than "Jul 29, 2026", so the headers stop
                sitting over the columns they name (the PlayerDetail lesson from
                the score-overflow pass). Rows are therefore `display:contents`
                links whose CELLS are the grid items. Score and date keep `auto`
                tracks so a 12-digit number widens its own column rather than
                clipping, and the type tag gets its own track so tournament
                names line up instead of starting at a badge-dependent offset.
                Cell padding (not a grid gap) keeps the row hover unbroken. */}
            <div className="hidden sm:grid grid-cols-[minmax(0,1.4fr)_auto_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto] items-center [&>*:last-child>*]:border-b-0">
              <span className={`${HEAD_CELL} pl-4 pr-3`}>Game</span>
              <span className={`${HEAD_CELL} pr-3`}>Type</span>
              <span className={`${HEAD_CELL} pr-3`}>Tournament</span>
              <span className={`${HEAD_CELL} pr-3`}>Winner</span>
              <span className={`${HEAD_CELL} pr-3 justify-end`}>Score</span>
              <span className={`${HEAD_CELL} pr-3 justify-end`}>Completed</span>
              <span className={`${HEAD_CELL} pr-4`} />
              {data.results.map((item, i) => {
                const winner = item.winner_name;
                const to = rowLink(item, roomSlug);
                const cells = (
                  <>
                    <span className={`${CELL} pl-4 pr-3`}>
                      <span className="min-w-0 truncate font-medium text-sm text-primary">{item.game_name}</span>
                    </span>
                    <span className={`${CELL} pr-3`}><TypeBadge type={item.tournament_type} /></span>
                    <span className={`${CELL} pr-3`}>
                      <span className="min-w-0 truncate text-sm text-muted">{item.tournament_name}</span>
                    </span>
                    <span className={`${CELL} pr-3 gap-1 text-sm ${winner ? 'text-neon-green font-medium' : 'text-faint'}`}>
                      {winner ? <Trophy size={12} className="flex-shrink-0" /> : null}
                      <span className="min-w-0 truncate">{winner || 'No submissions'}</span>
                    </span>
                    <span
                      className={`${CELL} pr-3 justify-end whitespace-nowrap tabular-nums text-sm font-display text-neon-amber`}
                      title={scoreTitle(item.winner_score)}
                    >
                      {formatScore(item.winner_score)}
                    </span>
                    <span className={`${CELL} pr-3 justify-end whitespace-nowrap text-xs text-faint`}>
                      {shortDate(item.end_date)}
                    </span>
                    <span className={`${CELL} pr-4`}>
                      <ChevronRight size={14} className={`text-faint ${to ? '' : 'opacity-0'}`} />
                    </span>
                  </>
                );
                return to ? (
                  <Link
                    key={rowKey(item, i)}
                    to={to}
                    aria-label={rowLabel(item)}
                    className="contents group no-underline cursor-pointer"
                  >
                    {cells}
                  </Link>
                ) : (
                  <div key={rowKey(item, i)} className="contents">{cells}</div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 mt-4">
            <span className="text-muted text-sm">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="px-3 py-1.5 text-sm rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
