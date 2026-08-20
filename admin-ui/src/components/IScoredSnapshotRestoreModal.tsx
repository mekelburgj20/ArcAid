import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonButton from './NeonButton';

/**
 * Restore-from-iScored-snapshot modal (v2.117.0).
 *
 * Mirrors the Game States page's "Reconcile iScored" flow: a dry run comes back
 * first as a plan, the admin ticks what to act on, then Execute runs it inside a
 * serialized iScored session and reports per-game results. Restore is lossy in
 * four structural ways, so all four are stated on the page BEFORE the button.
 */

export interface SnapshotInfo {
  gameroom: string;
  name: string;
  capturedAt: string;
  reason: string;
  games: number;
  scores: number;
  size: number;
  gamesCaptured: boolean;
  scoresCaptured: boolean;
}

interface RestorePlanGame {
  id: string;
  name: string;
  hidden: boolean;
  locked: boolean;
  tags: string[];
  scoreCount: number;
  localGameRows: { id: string; name: string }[];
}

interface RestorePlan {
  alreadyPresent: { id: string; name: string; liveId: string }[];
  toCreate: RestorePlanGame[];
}

interface RestoreGameResult {
  snapshotId: string;
  newId: string | null;
  name: string;
  scoresSubmitted: number;
  scoresRejected: number;
  relinkedLocalGames: number;
  error?: string;
}

export default function IScoredSnapshotRestoreModal({
  snapshot,
  onClose,
  onFinished,
}: {
  snapshot: SnapshotInfo;
  onClose: () => void;
  onFinished: (message: string, kind: 'success' | 'error') => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RestoreGameResult[] | null>(null);

  const base = `/admin/iscored-snapshots/${encodeURIComponent(snapshot.gameroom)}/${encodeURIComponent(snapshot.name)}/restore`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.post<{ plan: RestorePlan }>(base, { dryRun: true })
      .then(res => {
        if (cancelled) return;
        setPlan(res.plan);
        // Pre-select everything missing — that is the whole point of a restore.
        setSelected(new Set(res.plan.toCreate.map(g => g.id)));
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Could not build the restore plan');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.gameroom, snapshot.name]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const execute = async () => {
    setRunning(true);
    try {
      const res = await api.post<{ results: RestoreGameResult[] }>(base, {
        dryRun: false,
        gameIds: [...selected],
      });
      setResults(res.results);
      const created = res.results.filter(r => r.newId).length;
      const failed = res.results.filter(r => r.error).length;
      onFinished(
        `Restored ${created} of ${res.results.length} game(s)${failed > 0 ? ` — ${failed} failed` : ''}`,
        failed > 0 ? 'error' : 'success',
      );
    } catch (err: any) {
      onFinished(err.message || 'Restore failed', 'error');
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-lg shadow-2xl p-6 max-w-2xl w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="font-display font-bold text-primary mb-1">Restore from snapshot</h3>
        <p className="text-xs text-muted mb-3">
          <span className="font-mono">{snapshot.gameroom}</span> ·{' '}
          {new Date(snapshot.capturedAt).toLocaleString()} · {snapshot.games} game(s), {snapshot.scores} score(s)
        </p>

        {loading ? (
          <p className="text-sm text-muted py-6">Reading the live iScored game list…</p>
        ) : error ? (
          <p className="text-sm text-red-400 py-6">{error}</p>
        ) : results ? (
          <div className="overflow-y-auto flex-1 -mx-2 px-2">
            <div className="text-[10px] uppercase tracking-wider text-muted mb-2">Result</div>
            {results.length === 0 && <p className="text-sm text-muted py-2">Nothing was selected.</p>}
            {results.map(r => (
              <div key={r.snapshotId} className="flex items-start gap-2 py-1.5 text-sm border-b border-border/40 last:border-0">
                <span className={r.error ? 'text-red-400' : 'text-neon-green'}>{r.error ? '✕' : '✓'}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-primary break-words">{r.name}</div>
                  {r.error ? (
                    <div className="text-xs text-red-400 break-words">{r.error}</div>
                  ) : (
                    <div className="text-xs text-muted">
                      new iScored id <span className="font-mono">{r.newId}</span> · {r.scoresSubmitted} score(s) submitted
                      {r.scoresRejected > 0 && `, ${r.scoresRejected} rejected`} · {r.relinkedLocalGames} local game row(s) re-linked
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : plan ? (
          <>
            <div className="overflow-y-auto flex-1 -mx-2 px-2 space-y-3">
              {plan.toCreate.length > 0 ? (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-neon-cyan mb-1">
                    Missing from iScored — tick to recreate
                  </div>
                  {plan.toCreate.map(g => (
                    <label key={g.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-raised cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(g.id)}
                        onChange={() => toggle(g.id)}
                        className="accent-neon-cyan"
                      />
                      <span className="text-primary flex-1 break-words">{g.name}</span>
                      {g.tags.length > 0 && <span className="text-[10px] text-muted shrink-0">{g.tags.join(', ')}</span>}
                      <span className="text-[10px] text-faint shrink-0">
                        {g.scoreCount} player best{g.scoreCount === 1 ? '' : 's'}
                        {g.localGameRows.length > 0 && ` · ${g.localGameRows.length} local row(s)`}
                      </span>
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-neon-green py-2">
                  Every game in this snapshot is already on iScored — nothing to restore.
                </p>
              )}

              {plan.alreadyPresent.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted mb-1">
                    Already on iScored — skipped
                  </div>
                  {plan.alreadyPresent.map(g => (
                    <div key={g.id} className="flex items-center gap-2 py-1.5 px-2 text-sm opacity-50">
                      <span className="text-faint">—</span>
                      <span className="text-muted flex-1 break-words">{g.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-3 pt-3 border-t border-border text-xs text-muted space-y-1">
              <div className="text-neon-amber font-medium">What a restore cannot bring back:</div>
              <ul className="list-disc pl-5 space-y-0.5">
                <li>iScored assigns <strong>new game IDs</strong> — the old IDs are gone (Arcaid's game rows are re-linked automatically).</li>
                <li>Score <strong>dates become the restore time</strong> — iScored accepts no date on submit.</li>
                <li><strong>Score photos are not restored.</strong></li>
                <li>Only each player's <strong>best score</strong> comes back, not their full history on the game.</li>
              </ul>
            </div>

            <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
              <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
              <NeonButton
                onClick={execute}
                disabled={running || selected.size === 0}
              >
                {running ? 'Restoring…' : `Restore ${selected.size} game${selected.size === 1 ? '' : 's'}`}
              </NeonButton>
            </div>
          </>
        ) : null}

        {(results || error) && (
          <div className="flex justify-end mt-4 pt-3 border-t border-border">
            <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
          </div>
        )}
      </div>
    </div>
  );
}
