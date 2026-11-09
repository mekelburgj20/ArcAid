import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { parseServerDate } from '../lib/format';

/**
 * A35 (v2.235.0) — Game names: merge room history recorded under a name the
 * catalogue does not have ("Arkanoid") into a catalogue game ("Arkanoid
 * (Pinball)"). Super-admin, every room, one (room, name) at a time, with a
 * preview of every row that moves and an exact Undo (owner 2026-11-08).
 */

interface Suggestion {
  id: string; name: string; manufacturer: string | null; year: number | null; platforms: string[]; atgames: boolean;
}
interface Orphan {
  roomId: string; roomName: string; roomSlug: string; name: string; spellings: string[];
  counts: { games: number; activeGames: number; scores: number; communityScores: number; comments: number };
  lastScoreAt: string | null; suggestions: Suggestion[];
}
interface Preview {
  roomId: string; fromName: string; spellings: string[]; to: { id: string; name: string };
  counts: { games: number; activeGames: number; scores: number; communityScores: number; comments: number; library: 'rename' | 'merge' | 'none'; suppressions: number };
  blockers: string[]; warnings: string[];
}
interface Reconcile {
  id: string; roomId: string; roomName: string | null; fromName: string; toName: string;
  counts: Partial<Preview['counts']>; createdAt: string; undoneAt: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function usage(c: Orphan['counts']): string {
  const parts: string[] = [];
  if (c.scores) parts.push(plural(c.scores, 'score'));
  if (c.communityScores) parts.push(plural(c.communityScores, 'community score'));
  if (c.games) parts.push(plural(c.games, 'game') + (c.activeGames ? ` (${c.activeGames} live)` : ''));
  if (c.comments) parts.push(plural(c.comments, 'comment'));
  return parts.join(' · ') || 'no rows';
}

function SuggestionLabel({ s }: { s: Suggestion }) {
  const meta = [s.manufacturer, s.year].filter(Boolean).join(', ');
  return (
    <span className="min-w-0 break-words">
      <span className="text-primary">{s.name}</span>
      {meta && <span className="text-faint"> · {meta}</span>}
      {s.atgames && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded border border-neon-cyan/40 text-neon-cyan align-middle">AtGames</span>}
    </span>
  );
}

function OrphanRow({ orphan, onMerged }: { orphan: Orphan; onMerged: () => void }) {
  const { toast } = useToast();
  const [target, setTarget] = useState<Suggestion | null>(orphan.suggestions[0] ?? null);
  const [extra, setExtra] = useState<Suggestion[]>([]);
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    if (query.trim().length < 2) return;
    timer.current = setTimeout(async () => {
      try {
        const res = await api.get<{ games: Suggestion[] }>(`/admin/game-names/catalogue-search?q=${encodeURIComponent(query.trim())}`);
        setExtra(res.games);
      } catch { setExtra([]); }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query]);

  const choices = [...orphan.suggestions, ...extra.filter(e => !orphan.suggestions.some(s => s.id === e.id))];

  const runPreview = async (t: Suggestion | null = target) => {
    if (!t) return;
    setBusy(true);
    try {
      setPreview(await api.post<Preview>('/admin/game-names/preview', { roomId: orphan.roomId, fromName: orphan.name, toGlobalGameId: t.id }));
    } catch (err) {
      toast((err as Error).message || 'Preview failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    if (!target) return;
    setConfirming(false);
    setBusy(true);
    try {
      await api.post('/admin/game-names/reconcile', { roomId: orphan.roomId, fromName: orphan.name, toGlobalGameId: target.id });
      toast(`Merged "${orphan.name}" into "${target.name}" in ${orphan.roomName}`, 'success');
      onMerged();
    } catch (err) {
      toast((err as Error).message || 'Merge failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 rounded border border-border bg-surface" data-testid="orphan-row">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-display text-base text-primary break-words">"{orphan.name}"</span>
        {orphan.spellings.length > 1 && <span className="text-xs text-faint">also {orphan.spellings.slice(1).map(s => `"${s}"`).join(', ')}</span>}
        <span className="text-xs text-muted">{usage(orphan.counts)}</span>
        {orphan.lastScoreAt && <span className="text-xs text-faint">last score {parseServerDate(orphan.lastScoreAt)?.toLocaleDateString() ?? orphan.lastScoreAt}</span>}
      </div>

      <div className="mt-3 grid gap-2">
        <p className="text-xs text-muted">Merge into:</p>
        {choices.length === 0 && <p className="text-xs text-faint">No close catalogue match. Search below.</p>}
        {choices.map(s => (
          <label key={s.id} className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="radio" name={`target-${orphan.roomId}-${orphan.name}`} className="mt-1"
              checked={target?.id === s.id}
              onChange={() => { setTarget(s); setPreview(null); }}
            />
            <SuggestionLabel s={s} />
          </label>
        ))}
        <input
          type="search" placeholder="Search the catalogue for another game" value={query}
          onChange={e => setQuery(e.target.value)}
          className="mt-1 px-3 py-2 bg-raised border border-border rounded text-primary text-sm sm:max-w-sm focus:outline-none focus:border-neon-cyan"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <NeonButton variant="ghost" className="text-xs px-3 py-2" disabled={!target || busy} onClick={() => runPreview()}>Preview</NeonButton>
        <NeonButton
          className="text-xs px-3 py-2"
          disabled={!target || busy || !preview || preview.to.id !== target?.id || preview.blockers.length > 0}
          onClick={() => setConfirming(true)}
        >Merge</NeonButton>
      </div>

      {preview && preview.to.id === target?.id && (
        <div className="mt-3 p-3 rounded border border-border bg-raised text-xs grid gap-1" data-testid="reconcile-preview">
          <p className="text-primary">
            In {orphan.roomName}, "{preview.spellings.join('" / "')}" becomes "{preview.to.name}":
          </p>
          <p className="text-muted">
            {plural(preview.counts.scores, 'score')}, {plural(preview.counts.communityScores, 'community score')},{' '}
            {plural(preview.counts.games, 'game')}, {plural(preview.counts.comments, 'comment')}
            {preview.counts.library !== 'none' && `, the room's game-list entry (${preview.counts.library === 'merge' ? 'merged into the existing one' : 'renamed'})`}
            {preview.counts.suppressions > 0 && `, ${plural(preview.counts.suppressions, 'deleted-score marker')}`}.
          </p>
          {preview.warnings.map(w => <p key={w} className="text-neon-amber">{w}</p>)}
          {preview.blockers.map(b => <p key={b} className="text-neon-magenta">Can't merge: {b}</p>)}
          {preview.blockers.length === 0 && <p className="text-faint">Merges can be undone below.</p>}
        </div>
      )}

      {confirming && target && preview && (
        <ConfirmModal
          title="Merge game name"
          message={`Rename "${orphan.name}" to "${target.name}" in ${orphan.roomName}: ${plural(preview.counts.scores + preview.counts.communityScores, 'score')} and ${plural(preview.counts.games, 'game')} move. You can undo this.`}
          confirmLabel="Merge"
          onConfirm={merge}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

interface Loaded { orphans: Orphan[]; history: Reconcile[]; error?: string }

async function fetchAll(): Promise<Loaded> {
  try {
    const [o, h] = await Promise.all([
      api.get<{ orphans: Orphan[] }>('/admin/game-names/orphans'),
      api.get<{ reconciles: Reconcile[] }>('/admin/game-names/reconciles'),
    ]);
    return { orphans: o.orphans, history: h.reconciles };
  } catch (err) {
    return { orphans: [], history: [], error: (err as Error).message || 'Could not load game names' };
  }
}

export default function GameNameReconcile() {
  const { toast } = useToast();
  const [orphans, setOrphans] = useState<Orphan[] | null>(null);
  const [history, setHistory] = useState<Reconcile[]>([]);
  const [undoTarget, setUndoTarget] = useState<Reconcile | null>(null);

  const apply = useCallback((data: Loaded) => {
    if (data.error) toast(data.error, 'error');
    setOrphans(data.orphans);
    setHistory(data.history);
  }, [toast]);

  const load = useCallback(async () => { apply(await fetchAll()); }, [apply]);

  useEffect(() => {
    let alive = true;
    void fetchAll().then(data => { if (alive) apply(data); });
    return () => { alive = false; };
  }, [apply]);

  const undo = async (r: Reconcile) => {
    setUndoTarget(null);
    try {
      await api.post(`/admin/game-names/reconciles/${r.id}/undo`, {});
      toast(`Undid "${r.fromName}" → "${r.toName}"`, 'success');
      await load();
    } catch (err) {
      toast((err as Error).message || 'Undo failed', 'error');
    }
  };

  if (orphans === null) return <LoadingState />;

  const byRoom = new Map<string, Orphan[]>();
  for (const o of orphans) byRoom.set(o.roomId, [...(byRoom.get(o.roomId) ?? []), o]);

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center gap-3 mb-2">
        <h1 className="font-display text-2xl font-bold">Game Names</h1>
        <NeonButton variant="ghost" className="ml-auto" onClick={load}>Refresh</NeonButton>
      </div>
      <p className="text-sm text-muted mb-6">
        Game names in room history that match no catalogue game. Their scores do not join the catalogue game, the Global
        Scoreboard or AtGames (for example "Arkanoid", where the catalogue has "Arkanoid (Pinball)"). Merge one room at a
        time: the same name in another room may be another game.
      </p>

      {orphans.length === 0 ? (
        <NeonCard><p className="text-sm text-muted">Every game name in room history matches a catalogue game.</p></NeonCard>
      ) : (
        <div className="grid gap-6">
          {[...byRoom.entries()].map(([roomId, list]) => (
            <section key={roomId}>
              <h2 className="font-display text-xs font-bold uppercase tracking-wider text-muted mb-2">
                {list[0]!.roomName} <span className="text-faint normal-case tracking-normal">· {plural(list.length, 'name')}</span>
              </h2>
              <div className="grid gap-3">
                {list.map(o => <OrphanRow key={`${o.roomId}:${o.name}`} orphan={o} onMerged={load} />)}
              </div>
            </section>
          ))}
        </div>
      )}

      {history.length > 0 && (
        <section className="mt-10">
          <h2 className="font-display text-xs font-bold uppercase tracking-wider text-muted mb-2">Merged</h2>
          <div className="grid gap-2">
            {history.map(r => (
              <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 rounded border border-border bg-surface text-sm">
                <span className="text-primary break-words">"{r.fromName}" → "{r.toName}"</span>
                <span className="text-xs text-muted">{r.roomName ?? r.roomId}</span>
                <span className="text-xs text-faint">{parseServerDate(r.createdAt)?.toLocaleString() ?? r.createdAt}</span>
                <span className="ml-auto">
                  {r.undoneAt
                    ? <span className="text-xs text-faint">Undone</span>
                    : <NeonButton variant="ghost" className="text-xs px-3 py-1" onClick={() => setUndoTarget(r)}>Undo</NeonButton>}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {undoTarget && (
        <ConfirmModal
          title="Undo merge"
          message={`Put "${undoTarget.fromName}" back in ${undoTarget.roomName ?? 'that room'}? Only the rows this merge changed are restored; scores added since stay under "${undoTarget.toName}".`}
          confirmLabel="Undo"
          onConfirm={() => undo(undoTarget)}
          onCancel={() => setUndoTarget(null)}
        />
      )}
    </div>
  );
}
