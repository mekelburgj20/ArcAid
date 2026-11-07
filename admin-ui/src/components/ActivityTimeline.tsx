import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronRight, Download, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { getSocket } from '../lib/websocket';
import { useLiveRefresh } from '../hooks/useLiveRefresh';
import {
  ACTIVITY_CATEGORIES, ACTIVITY_FILTER_KEYS, activityQueryString, formatActivityTime,
  formatActivityTimeExact, formatChangeValue,
  type ActivityChange, type ActivityPage, type ActivityRow,
} from '../lib/activityLog';
import NeonCard from './NeonCard';
import LoadingState from './LoadingState';

/**
 * G14 (v2.227.0, ADR 0037) - the activity timeline. One component for the
 * room admin (one room) and the super-admin (every room + room-less/server
 * rows). Filters live in the URL query string so a filtered view is a
 * shareable link; the server applies them (dates in the room timezone).
 * Names arrive already resolved through the label chain; this page never
 * renders a raw id.
 *
 * G15 (v2.228.0): every row opens an inline details panel (the server's
 * curated `detail`: facts by event type, an admin edit's changed keys with
 * before/after values, a secret as "changed"). The super-admin also gets the
 * row's raw JSON, collapsed.
 */

interface Meta {
  tournaments: Array<{ id: string; name: string }>;
  rooms?: Array<{ id: string; name: string }>;
  timezone: string;
}

const inputClass = 'w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder:text-faint focus:outline-none focus:border-neon-cyan/60';
const chipBase = 'text-xs font-semibold px-3 py-1.5 rounded-full border cursor-pointer transition-colors';

export default function ActivityTimeline({ mode, roomId }: { mode: 'room' | 'super'; roomId?: string }) {
  const [params, setParams] = useSearchParams();
  const base = mode === 'room' ? `/rooms/${roomId}/admin/activity` : '/admin/activity';
  const filterKey = activityQueryString(params);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);

  const selectedRoom = params.get('room') ?? '';
  useEffect(() => {
    const metaPath = mode === 'room'
      ? `${base}/meta`
      : `${base}/meta${selectedRoom ? `?room=${encodeURIComponent(selectedRoom)}` : ''}`;
    api.get<Meta>(metaPath).then(setMeta).catch(() => setMeta(null));
  }, [base, mode, selectedRoom]);

  // Page 1 for the current filters. Only the newest request may write state.
  const requestSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    const key = `${base}${filterKey}`;
    return api.get<ActivityPage>(key)
      .then((next) => {
        if (seq !== requestSeq.current) return;
        setPage(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : 'Could not load the activity log');
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoadedKey(key);
      });
  }, [base, filterKey]);

  useEffect(() => {
    load();
  }, [load]);
  const loading = loadedKey !== `${base}${filterKey}`;

  // Live: the room channel pings `activity:new` (no content); reload page 1.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; });
  useEffect(() => {
    if (mode !== 'room' || !roomId) return;
    const socket = getSocket();
    const join = () => socket.emit('join:room', roomId);
    join();
    const onNew = () => { void loadRef.current(); };
    socket.on('connect', join);
    socket.on('activity:new', onNew);
    return () => {
      socket.off('connect', join);
      socket.off('activity:new', onNew);
    };
  }, [mode, roomId]);
  useLiveRefresh(() => { void loadRef.current(); }, { intervalMs: mode === 'super' ? 30_000 : 60_000 });

  const rows = page?.rows ?? [];
  const loadMore = async () => {
    if (page?.nextBefore == null) return;
    setLoadingMore(true);
    try {
      const more = await api.get<ActivityPage>(`${base}${activityQueryString(params, { before: String(page.nextBefore) })}`);
      setPage(prev => prev ? { ...prev, rows: [...prev.rows, ...more.rows], nextBefore: more.nextBefore } : more);
    } catch { /* keep what we have */ }
    setLoadingMore(false);
  };

  const setFilter = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v); else next.delete(k);
    }
    setParams(next);
  };

  const categories = (params.get('category') ?? '').split(',').filter(Boolean);
  const toggleCategory = (key: string) => {
    const set = new Set(categories);
    if (set.has(key)) set.delete(key); else set.add(key);
    setFilter({ category: [...set].join(',') });
  };
  const problemsOnly = params.get('problems') === '1';
  const anyFilter = ACTIVITY_FILTER_KEYS.some(k => params.get(k));

  const downloadCsv = async () => {
    try {
      await api.download(`${base}.csv${filterKey}`, 'activity.csv');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    }
  };

  const failures = page?.writeFailures;
  const timezone = page?.timezone ?? meta?.timezone ?? '';

  return (
    <div className="space-y-4">
      {mode === 'super' && failures && failures.count > 0 && (
        <div className="flex items-start gap-2 text-sm text-neon-amber border border-neon-amber/40 bg-neon-amber/10 rounded p-3">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span className="min-w-0 break-words">
            {failures.count} activity-log write{failures.count === 1 ? '' : 's'} failed since the server started.
            {failures.last ? ` Last: ${failures.last}` : ''}
          </span>
        </div>
      )}

      <NeonCard>
        {/* Keyed by the URL filters so the text boxes reset to them on back/forward. */}
        <TextFilters key={filterKey} params={params} onApply={setFilter}>
          {mode === 'super' && (
            <label className="text-xs text-muted space-y-1">
              <span>Room</span>
              <select className={inputClass} value={selectedRoom}
                onChange={e => setFilter({ room: e.target.value, tournament: null })}>
                <option value="">All rooms</option>
                <option value="none">No room (server / Global)</option>
                {(meta?.rooms ?? []).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
          {(mode === 'room' || (selectedRoom && selectedRoom !== 'none')) && (
            <label className="text-xs text-muted space-y-1">
              <span>Tournament</span>
              <select className={inputClass} value={params.get('tournament') ?? ''}
                onChange={e => setFilter({ tournament: e.target.value })}>
                <option value="">All tournaments</option>
                {(meta?.tournaments ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
        </TextFilters>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button type="button" onClick={() => setFilter({ problems: problemsOnly ? null : '1' })}
            className={`${chipBase} ${problemsOnly ? 'text-neon-coral border-neon-coral/60 bg-neon-coral/15' : 'text-muted border-border bg-transparent'}`}
            aria-pressed={problemsOnly}>
            Problems only
          </button>
          {ACTIVITY_CATEGORIES.map(c => (
            <button type="button" key={c.key} onClick={() => toggleCategory(c.key)}
              className={`${chipBase} ${categories.includes(c.key) ? c.color : 'text-muted border-border bg-transparent'}`}
              aria-pressed={categories.includes(c.key)}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 mt-3">
          {anyFilter && (
            <button type="button" onClick={() => setParams(new URLSearchParams())}
              className="text-sm text-muted border border-border rounded px-4 py-2 bg-transparent cursor-pointer hover:text-primary">
              Clear filters
            </button>
          )}
          <button type="button" onClick={() => void load()} title="Refresh"
            className="text-sm text-muted border border-border rounded px-3 py-2 bg-transparent cursor-pointer hover:text-primary inline-flex items-center gap-1">
            <RefreshCw size={14} /> Refresh
          </button>
          <button type="button" onClick={() => void downloadCsv()}
            className="text-sm text-muted border border-border rounded px-3 py-2 bg-transparent cursor-pointer hover:text-primary inline-flex items-center gap-1">
            <Download size={14} /> CSV
          </button>
          {timezone && (
            <span className="text-xs text-faint">
              {mode === 'super'
                ? `Dates and times use each row's room timezone (rows with no room: ${timezone.replace(/_/g, ' ')})`
                : `Dates and times in ${timezone.replace(/_/g, ' ')}`}
            </span>
          )}
        </div>
      </NeonCard>

      {error && <p className="text-sm text-neon-coral">{error}</p>}

      <NeonCard>
        {loading && !page ? (
          <LoadingState message="Loading activity..." />
        ) : rows.length === 0 ? (
          <p className="text-muted text-sm py-8 text-center">
            {anyFilter ? 'Nothing matches these filters.' : 'No activity recorded yet.'}
          </p>
        ) : (
          <ul className={`divide-y divide-border/30 ${loading ? 'opacity-60' : ''}`}>
            {rows.map(r => <ActivityItem key={r.id} row={r} showRoom={mode === 'super'} />)}
          </ul>
        )}
        {page?.nextBefore != null && rows.length > 0 && (
          <div className="mt-4 text-center">
            <button onClick={() => void loadMore()} disabled={loadingMore}
              className="text-sm text-neon-cyan hover:text-neon-cyan/80 transition-colors cursor-pointer bg-transparent border border-neon-cyan/30 rounded px-4 py-2 disabled:opacity-50">
              {loadingMore ? 'Loading...' : 'Load older'}
            </button>
          </div>
        )}
      </NeonCard>
    </div>
  );
}

/** The free-text and date filters: edited locally, applied on submit (no refetch per keystroke). */
function TextFilters({ params, onApply, children }: {
  params: URLSearchParams;
  onApply: (updates: Record<string, string | null>) => void;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState({
    player: params.get('player') ?? '', game: params.get('game') ?? '', q: params.get('q') ?? '',
    from: params.get('from') ?? '', to: params.get('to') ?? '',
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onApply({ player: draft.player.trim(), game: draft.game.trim(), q: draft.q.trim(), from: draft.from, to: draft.to });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label className="text-xs text-muted space-y-1">
          <span>Player</span>
          <input className={inputClass} value={draft.player} placeholder="Name or alias"
            onChange={e => setDraft(d => ({ ...d, player: e.target.value }))} />
        </label>
        <label className="text-xs text-muted space-y-1">
          <span>Game or table</span>
          <input className={inputClass} value={draft.game} placeholder="e.g. Twilight Zone"
            onChange={e => setDraft(d => ({ ...d, game: e.target.value }))} />
        </label>
        <label className="text-xs text-muted space-y-1">
          <span>Keyword</span>
          <input className={inputClass} value={draft.q} placeholder="Search the log"
            onChange={e => setDraft(d => ({ ...d, q: e.target.value }))} />
        </label>
        {children}
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted space-y-1">
            <span>From</span>
            <input type="date" className={inputClass} value={draft.from}
              onChange={e => setDraft(d => ({ ...d, from: e.target.value }))} />
          </label>
          <label className="text-xs text-muted space-y-1">
            <span>To</span>
            <input type="date" className={inputClass} value={draft.to}
              onChange={e => setDraft(d => ({ ...d, to: e.target.value }))} />
          </label>
        </div>
      </div>
      <button type="submit" className="text-sm font-semibold text-neon-cyan border border-neon-cyan/40 rounded px-4 py-2 bg-transparent cursor-pointer hover:bg-neon-cyan/10">
        Apply
      </button>
    </form>
  );
}

function ActivityItem({ row, showRoom }: { row: ActivityRow; showRoom: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const cat = ACTIVITY_CATEGORIES.find(c => c.key === row.category);
  const problem = row.severity === 'problem';
  const context = [row.tournament_name, row.game_name && row.game_name !== row.table_name ? row.game_name : null, row.table_name]
    .filter((v): v is string => !!v);
  // Admin rows name the admin in their summary already.
  const actorInSummary = row.category === 'admin' && !!row.actor && row.summary.startsWith(row.actor);
  return (
    <li className={`py-3 ${problem ? 'border-l-2 border-l-neon-coral pl-2' : ''}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-controls={panelId}
        className="w-full text-left bg-transparent border-0 p-0 cursor-pointer flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60">
        <span className="flex items-center gap-2 sm:w-44 flex-shrink-0">
          {open
            ? <ChevronDown size={14} className="text-faint flex-shrink-0" aria-hidden="true" />
            : <ChevronRight size={14} className="text-faint flex-shrink-0" aria-hidden="true" />}
          <span className="text-xs text-faint whitespace-nowrap">{formatActivityTime(row.created_at, row.tz)}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${cat?.color ?? 'text-muted border-border bg-raised'}`}>
            {cat?.label ?? row.category}
          </span>
        </span>
        <span className="min-w-0 flex-1 space-y-1 block">
          <span className="block text-sm text-primary break-words">
            {problem && <AlertTriangle size={14} className="inline mr-1 -mt-0.5 text-neon-coral" aria-label="Problem" />}
            {row.player && <span className="font-semibold">{row.player}: </span>}
            {row.summary}
          </span>
          {row.reasons.length > 0 && (
            <span className="block text-xs text-muted space-y-0.5">
              {row.reasons.map((reason, i) => <span key={i} className="block break-words">- {reason}</span>)}
            </span>
          )}
          <span className="block text-xs text-faint break-words">
            {[
              showRoom ? (row.room_name ?? 'No room') : null,
              ...context,
              row.device,
              row.actor && !actorInSummary ? `by ${row.actor}` : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {open && <ActivityDetailPanel id={panelId} row={row} showRoom={showRoom} />}
    </li>
  );
}

const factLabel = 'text-xs text-faint';
const factValue = 'text-sm text-primary break-words min-w-0';

function ActivityDetailPanel({ id, row, showRoom }: { id: string; row: ActivityRow; showRoom: boolean }) {
  const detail = row.detail;
  const who = [
    row.actor ? { label: row.category === 'admin' ? 'Admin' : 'Done by', value: row.actor } : null,
    row.player ? { label: 'Player', value: row.player } : null,
  ].filter((v): v is { label: string; value: string } => !!v);
  return (
    <div id={id} role="region" aria-label="Activity details"
      className="mt-2 sm:ml-[11.75rem] rounded border border-border/60 bg-raised/40 p-3 space-y-3">
      <dl className="grid grid-cols-1 sm:grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1">
        <dt className={factLabel}>When</dt>
        <dd className={factValue}>{formatActivityTimeExact(row.created_at, row.tz)}</dd>
        {showRoom && (<>
          <dt className={factLabel}>Room</dt>
          <dd className={factValue}>{row.room_name ?? 'No room'}</dd>
        </>)}
        {who.map(w => (
          <div key={w.label} className="contents">
            <dt className={factLabel}>{w.label}</dt>
            <dd className={factValue}>{w.value}</dd>
          </div>
        ))}
        {(detail?.facts ?? []).map((f, i) => (
          <div key={`${f.label}-${i}`} className="contents">
            <dt className={factLabel}>{f.label}</dt>
            <dd className={factValue}>{f.time ? formatActivityTimeExact(f.value, row.tz) : f.value}</dd>
          </div>
        ))}
      </dl>

      {detail?.changes && detail.changes.length > 0 && <ChangeTable changes={detail.changes} />}

      {detail?.recordedKeys && detail.recordedKeys.length > 0 && (
        <div className="space-y-1">
          <p className={factLabel}>Settings saved</p>
          <ul className="flex flex-wrap gap-1.5">
            {detail.recordedKeys.map((k, i) => (
              <li key={`${k}-${i}`} className="text-xs text-primary border border-border rounded px-2 py-0.5 break-words max-w-full">{k}</li>
            ))}
          </ul>
        </div>
      )}

      {(detail?.notes ?? []).map((n, i) => <p key={i} className="text-xs text-muted italic break-words">{n}</p>)}

      {row.details && (
        <details className="text-xs">
          <summary className="cursor-pointer text-faint">Raw (super-admin)</summary>
          <pre className="mt-1 whitespace-pre-wrap break-all text-muted">{JSON.stringify(row.details, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

function ChangeValue({ value }: { value: string | null | undefined }) {
  if (value == null) return <span className="text-faint italic">(not set)</span>;
  return <pre className="whitespace-pre-wrap break-words font-mono text-xs text-primary m-0">{formatChangeValue(value)}</pre>;
}

function ChangeTable({ changes }: { changes: ActivityChange[] }) {
  return (
    <table className="w-full table-fixed text-left border-collapse">
      <caption className="sr-only">What changed</caption>
      <thead>
        <tr className="text-xs text-faint">
          <th scope="col" className="font-normal pb-1 pr-2 w-1/4">Changed</th>
          <th scope="col" className="font-normal pb-1 pr-2">Before</th>
          <th scope="col" className="font-normal pb-1">After</th>
        </tr>
      </thead>
      <tbody>
        {changes.map(c => (
          <tr key={c.key} className="align-top border-t border-border/30">
            <th scope="row" className="text-sm font-semibold text-primary py-1 pr-2 break-words">{c.label}</th>
            {c.secret ? (
              <td colSpan={2} className="text-sm text-muted py-1">Changed (secret; values are never recorded)</td>
            ) : (<>
              <td className="py-1 pr-2 min-w-0"><ChangeValue value={c.from} /></td>
              <td className="py-1 min-w-0"><ChangeValue value={c.to} /></td>
            </>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
