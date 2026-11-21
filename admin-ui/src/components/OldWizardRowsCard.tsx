import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from './NeonCard';
import NeonButton from './NeonButton';
import { AlertTriangle, ArrowRight, GitMerge, RefreshCw, Search } from 'lucide-react';

/**
 * C14 (v2.257.0) — Super Admin -> Global Catalogue -> Old Wizard Rows.
 *
 * The README-era Wizard import left rows with no VPS id that copy a VPS game
 * under the README's spelling ("Addams Family, The", "Medusa - JP"). The
 * server proposes a survivor for each (`GET /admin/catalogue/old-wizard-rows`)
 * and pre-ticks only the pairs nothing argues against; the owner ticks the
 * rest, can point any row at another catalogue game, and merges. Every merge
 * is `GlobalGameService.merge`: scores, ratings, My Tables and room links move.
 */

export interface OldWizardTarget {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  vps_id: string | null;
}

export interface OldWizardRowPlan {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  status: string;
  folder: string | null;
  counts: {
    globalScores: number;
    globalPlayers: number;
    ratings: number;
    comments: number;
    myTables: number;
    pins: number;
    roomGames: number;
    activeRoomGames: number;
  };
  suggestion: {
    target: OldWizardTarget;
    tier: 'folder' | 'name' | 'maker_year';
    disagreements: string[];
    conflict: string | null;
  } | null;
  alternatives: OldWizardTarget[];
  preselect: boolean;
}

interface Preview {
  rows: OldWizardRowPlan[];
  summary: { total: number; suggested: number; preselected: number; ambiguous: number; none: number };
}

interface MergeResult {
  merged: Array<{ sourceId: string; targetId: string; scoresMoved: number }>;
  failed: Array<{ sourceId: string; targetId: string; error: string }>;
}

type Filter = 'all' | 'ticked' | 'unticked' | 'needs';

const TIER_LABEL: Record<string, string> = {
  folder: 'Same Wizard folder',
  name: 'Same name',
  maker_year: 'Similar name, same maker and year',
};

function makerYear(g: { manufacturer: string | null; year: number | null }): string {
  const parts = [g.manufacturer, g.year ? String(g.year) : null].filter(Boolean);
  return parts.length ? parts.join(' ') : 'maker and year unknown';
}

function holdings(c: OldWizardRowPlan['counts']): string {
  const parts: string[] = [];
  if (c.globalScores) parts.push(`${c.globalScores} Global score${c.globalScores === 1 ? '' : 's'} (${c.globalPlayers} player${c.globalPlayers === 1 ? '' : 's'})`);
  if (c.ratings) parts.push(`${c.ratings} rating${c.ratings === 1 ? '' : 's'}`);
  if (c.comments) parts.push(`${c.comments} comment${c.comments === 1 ? '' : 's'}`);
  if (c.myTables) parts.push(`in ${c.myTables} player${c.myTables === 1 ? "'s" : "s'"} My Tables`);
  if (c.pins) parts.push(`${c.pins} pin${c.pins === 1 ? '' : 's'}`);
  if (c.roomGames) parts.push(`${c.roomGames} room game${c.roomGames === 1 ? '' : 's'}${c.activeRoomGames ? ` (${c.activeRoomGames} live)` : ''}`);
  return parts.length ? parts.join(' · ') : 'Holds nothing';
}

export default function OldWizardRowsCard() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** Survivors the owner chose instead of (or in the absence of) a suggestion. */
  const [chosen, setChosen] = useState<Record<string, OldWizardTarget>>({});
  const [filter, setFilter] = useState<Filter>('all');
  const [merging, setMerging] = useState(false);
  const [result, setResult] = useState<MergeResult | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Preview>('/admin/catalogue/old-wizard-rows');
      setPreview(data);
      setTicked(new Set(data.rows.filter(r => r.preselect).map(r => r.id)));
      setChosen({});
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the old Wizard rows');
    } finally {
      setLoading(false);
    }
  };

  const targetOf = (r: OldWizardRowPlan): OldWizardTarget | null => chosen[r.id] ?? r.suggestion?.target ?? null;

  const visible = useMemo(() => (preview?.rows ?? []).filter(r => {
    if (filter === 'ticked') return ticked.has(r.id);
    if (filter === 'unticked') return !ticked.has(r.id) && !!(chosen[r.id] ?? r.suggestion);
    if (filter === 'needs') return !(chosen[r.id] ?? r.suggestion);
    return true;
  }), [preview, filter, ticked, chosen]);

  const toggle = (id: string) => setTicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const choose = (rowId: string, target: OldWizardTarget) => {
    setChosen(prev => ({ ...prev, [rowId]: target }));
    setTicked(prev => new Set(prev).add(rowId));
  };

  const pairs = (preview?.rows ?? [])
    .filter(r => ticked.has(r.id))
    .map(r => ({ sourceId: r.id, targetId: targetOf(r)?.id }))
    .filter((p): p is { sourceId: string; targetId: string } => !!p.targetId);

  const runMerge = async () => {
    if (pairs.length === 0) return;
    if (!confirm(`Merge ${pairs.length} old Wizard row${pairs.length === 1 ? '' : 's'} into the games shown? Scores, ratings, My Tables and room links move to each survivor. This cannot be undone.`)) return;
    setMerging(true);
    setError(null);
    try {
      const res = await api.post<MergeResult>('/admin/catalogue/old-wizard-rows/merge', { pairs });
      setResult(res);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Merge failed');
    } finally {
      setMerging(false);
    }
  };

  return (
    <NeonCard glowColor="amber" className="mb-6" title="Old Wizard Rows">
      <p className="text-sm text-muted mb-3">
        Rows the old Wizard README import created, with no VPS id. Most are a second copy of a VPS game
        under the README's spelling. Merging moves each row's scores, ratings, My Tables entries and room links
        onto the game shown and keeps the old name as a search alias. The old row's Wizard tags and dead
        download link are not copied. Pre-ticked: the same Wizard folder, or the same name with the same maker and year.
      </p>
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <NeonButton variant="secondary" onClick={load} disabled={loading || merging} className="flex items-center gap-2">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          {preview ? 'Reload' : 'Find old Wizard rows'}
        </NeonButton>
        {preview && (
          <span className="text-sm text-muted">
            {preview.summary.total} rows · {preview.summary.suggested} with a suggested game · {preview.summary.ambiguous} with
            several candidates · {preview.summary.none} with none
          </span>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-3 p-3 rounded bg-red-900/30 border border-red-700 text-red-300 text-sm">{error}</div>
      )}

      {result && (
        <div className="mb-3 p-3 rounded bg-surface-alt border border-border text-sm">
          <div className="font-medium">
            Merged {result.merged.length} row{result.merged.length === 1 ? '' : 's'}
            {result.failed.length > 0 && `, ${result.failed.length} refused`}.
          </div>
          {result.failed.length > 0 && (
            <ul className="text-xs text-muted mt-1 space-y-0.5">
              {result.failed.map(f => <li key={f.sourceId}>{f.error}</li>)}
            </ul>
          )}
          {result.merged.length > 0 && (
            <div className="text-xs text-muted mt-1">
              Room games still named the old way are listed under Game Names, which renames them room by room.
            </div>
          )}
        </div>
      )}

      {preview && preview.rows.length === 0 && (
        <div className="text-muted text-center py-6 text-sm">No old Wizard rows are left.</div>
      )}

      {preview && preview.rows.length > 0 && (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-3" role="group" aria-label="Show">
            {([
              ['all', `All (${preview.rows.length})`],
              ['ticked', `Ticked (${ticked.size})`],
              ['unticked', 'Suggested, not ticked'],
              ['needs', 'Needs a game'],
            ] as Array<[Filter, string]>).map(([f, label]) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`text-xs px-3 py-1 rounded border ${filter === f ? 'border-neon-cyan text-neon-cyan' : 'border-border text-muted hover:text-primary'}`}
              >
                {label}
              </button>
            ))}
            <NeonButton
              variant="danger"
              onClick={runMerge}
              disabled={merging || pairs.length === 0}
              className="ml-auto text-xs py-1 px-3 flex items-center gap-1.5"
            >
              <GitMerge size={13} />
              {merging ? 'Merging…' : `Merge ${pairs.length} ticked`}
            </NeonButton>
          </div>

          <ul className="space-y-2">
            {visible.map(r => (
              <OldRow
                key={r.id}
                row={r}
                target={targetOf(r)}
                chosenByYou={!!chosen[r.id]}
                ticked={ticked.has(r.id)}
                onToggle={() => toggle(r.id)}
                onChoose={t => choose(r.id, t)}
              />
            ))}
          </ul>
        </>
      )}
    </NeonCard>
  );
}

function OldRow({ row, target, chosenByYou, ticked, onToggle, onChoose }: {
  row: OldWizardRowPlan;
  target: OldWizardTarget | null;
  chosenByYou: boolean;
  ticked: boolean;
  onToggle: () => void;
  onChoose: (t: OldWizardTarget) => void;
}) {
  const [searching, setSearching] = useState(false);
  const s = row.suggestion;
  const warnings: string[] = [];
  if (!chosenByYou && s) {
    if (s.disagreements.includes('maker')) warnings.push('The makers differ');
    if (s.disagreements.includes('year')) warnings.push('The years differ');
  }
  const conflict = !chosenByYou ? s?.conflict ?? null : null;

  return (
    <li className="border border-border rounded p-3 bg-surface-alt">
      <div className="flex items-start gap-3 flex-wrap sm:flex-nowrap">
        <input
          type="checkbox"
          className="mt-1 shrink-0"
          checked={ticked}
          disabled={!target}
          onChange={onToggle}
          aria-label={`Merge ${row.name}`}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium break-words">{row.name}</div>
          <div className="text-xs text-muted">
            {makerYear(row)}{row.folder ? ` · folder ${row.folder}` : ''}{row.status !== 'approved' ? ` · ${row.status}` : ''}
          </div>
          <div className="text-xs text-muted">{holdings(row.counts)}</div>
        </div>
        <ArrowRight size={16} className="mt-1 shrink-0 text-muted hidden sm:block" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          {target ? (
            <>
              <div className="font-medium break-words">{target.name}</div>
              <div className="text-xs text-muted">
                {makerYear(target)}{target.vps_id ? ` · VPS ${target.vps_id}` : ' · no VPS id'}
              </div>
              <div className="text-xs text-neon-cyan">{chosenByYou ? 'Chosen by you' : s ? TIER_LABEL[s.tier] : ''}</div>
            </>
          ) : row.alternatives.length > 0 ? (
            <div className="text-xs text-muted">
              <div className="mb-1">Several games fit. Pick one:</div>
              <div className="flex flex-wrap gap-1.5">
                {row.alternatives.map(a => (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => onChoose(a)}
                    className="px-2 py-0.5 rounded border border-border hover:border-neon-cyan text-primary text-left"
                  >
                    {a.name} ({makerYear(a)})
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-muted">No matching game found. Search for one.</div>
          )}
          {warnings.length > 0 && (
            <div className="text-xs text-neon-amber mt-1 flex items-center gap-1">
              <AlertTriangle size={12} aria-hidden="true" /> {warnings.join('; ')}. Check before ticking.
            </div>
          )}
          {conflict && (
            <div className="text-xs text-red-300 mt-1 flex items-start gap-1">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> {conflict}
            </div>
          )}
          <button
            type="button"
            onClick={() => setSearching(v => !v)}
            className="text-xs text-neon-cyan hover:underline mt-1 inline-flex items-center gap-1"
          >
            <Search size={12} aria-hidden="true" /> {searching ? 'Close search' : 'Choose another game'}
          </button>
          {searching && (
            <TargetSearch
              initial={row.name}
              onPick={t => { onChoose(t); setSearching(false); }}
            />
          )}
        </div>
      </div>
    </li>
  );
}

function TargetSearch({ initial, onPick }: { initial: string; onPick: (t: OldWizardTarget) => void }) {
  const [q, setQ] = useState(initial.replace(/\s*[-,(].*$/, ''));
  const [found, setFound] = useState<OldWizardTarget[] | null>(null);
  // A term too short to search shows no list (the last answer is kept, unshown).
  const hits = q.trim().length >= 2 ? found : null;

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      api.get<{ games: OldWizardTarget[] }>(`/admin/catalogue/old-wizard-rows/targets?q=${encodeURIComponent(term)}`)
        .then(res => { if (live) setFound(res.games); })
        .catch(() => { if (live) setFound([]); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  return (
    <div className="mt-2">
      <input
        type="text"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search the catalogue…"
        aria-label="Search the catalogue for the game to keep"
        className="w-full px-3 py-1.5 bg-surface border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
      />
      {hits && hits.length === 0 && <div className="text-xs text-muted mt-1">No catalogue game matches.</div>}
      {hits && hits.length > 0 && (
        <ul className="mt-1 space-y-1">
          {hits.map(h => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onPick(h)}
                className="w-full text-left text-xs px-2 py-1 rounded border border-border hover:border-neon-cyan"
              >
                <span className="text-primary break-words">{h.name}</span>
                <span className="text-muted"> · {makerYear(h)}{h.vps_id ? ` · VPS ${h.vps_id}` : ' · no VPS id'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
