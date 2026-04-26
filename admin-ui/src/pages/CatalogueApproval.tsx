import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

/**
 * v2.5.0 — super-admin Catalogue Approval queue.
 *
 * Lists global_games rows with status='pending', proposed via the per-room
 * Add Game / Import CSV flow. Each row offers Approve / Reject / Merge into
 * existing. The room's library entry stays intact across all three actions —
 * Reject just hides the row from public reads; Merge re-points the room's
 * global_game_id reference via GlobalGameService.merge before deleting the
 * pending row.
 */

interface GlobalGameLite {
  id: string;
  name: string;
  manufacturer?: string | null;
  year?: number | null;
  type: string;
  platforms?: string[];
}

interface PendingRow {
  id: string;
  name: string;
  manufacturer: string | null;
  year: number | null;
  type: string;
  platforms: string[];
  submitted_by_user_id: string | null;
  submitted_by_room_id: string | null;
  submitted_at: string;
  submitted_by_room_name: string | null;
  submitted_by_room_slug: string | null;
  submitted_by_username: string | null;
}

export default function CatalogueApproval() {
  const { toast } = useToast();
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [rejectTarget, setRejectTarget] = useState<PendingRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [mergeTarget, setMergeTarget] = useState<PendingRow | null>(null);
  const [mergeSearch, setMergeSearch] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<GlobalGameLite[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.get<{ data: PendingRow[]; hasMore: boolean }>('/admin/catalogue/pending?limit=200');
      setRows(result.data || []);
    } catch (err: any) {
      toast(err.message || 'Failed to load approval queue', 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const setRowPending = (id: string, isPending: boolean) => {
    setPending(prev => {
      const next = new Set(prev);
      if (isPending) next.add(id); else next.delete(id);
      return next;
    });
  };

  const handleApprove = async (row: PendingRow) => {
    setRowPending(row.id, true);
    try {
      await api.post(`/admin/catalogue/pending/${encodeURIComponent(row.id)}/approve`, {});
      toast(`Approved "${row.name}"`, 'success');
      setRows(prev => prev.filter(r => r.id !== row.id));
    } catch (err: any) {
      toast(err.message || 'Approve failed', 'error');
    } finally {
      setRowPending(row.id, false);
    }
  };

  const handleRejectConfirm = async () => {
    if (!rejectTarget) return;
    setRowPending(rejectTarget.id, true);
    try {
      await api.post(`/admin/catalogue/pending/${encodeURIComponent(rejectTarget.id)}/reject`, {
        reason: rejectReason.trim() || undefined,
      });
      toast(`Rejected "${rejectTarget.name}"`, 'success');
      setRows(prev => prev.filter(r => r.id !== rejectTarget.id));
      setRejectTarget(null);
      setRejectReason('');
    } catch (err: any) {
      toast(err.message || 'Reject failed', 'error');
    } finally {
      if (rejectTarget) setRowPending(rejectTarget.id, false);
    }
  };

  // Merge picker — search the catalogue (approved only) for the target.
  useEffect(() => {
    if (!mergeTarget) return;
    const q = mergeSearch.trim();
    if (!q) { setMergeCandidates([]); return; }
    const ctrl = new AbortController();
    (async () => {
      try {
        const r = await api.get<{ data: GlobalGameLite[] }>(
          `/admin/catalogue/games?search=${encodeURIComponent(q)}&status=approved&limit=10`,
        );
        if (!ctrl.signal.aborted) setMergeCandidates(r.data || []);
      } catch { /* ignore — search is opportunistic */ }
    })();
    return () => ctrl.abort();
  }, [mergeTarget, mergeSearch]);

  const handleMergeConfirm = async (targetId: string) => {
    if (!mergeTarget) return;
    setRowPending(mergeTarget.id, true);
    try {
      await api.post(
        `/admin/catalogue/pending/${encodeURIComponent(mergeTarget.id)}/merge_into/${encodeURIComponent(targetId)}`,
        {},
      );
      toast(`Merged "${mergeTarget.name}" into existing entry`, 'success');
      setRows(prev => prev.filter(r => r.id !== mergeTarget.id));
      setMergeTarget(null);
      setMergeSearch('');
      setMergeCandidates([]);
    } catch (err: any) {
      toast(err.message || 'Merge failed', 'error');
    } finally {
      if (mergeTarget) setRowPending(mergeTarget.id, false);
    }
  };

  if (loading) return <LoadingState message="Loading approval queue..." />;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="font-display text-2xl font-bold">Catalogue Approvals</h1>
          <p className="text-faint text-sm mt-1">
            Pending submissions from per-room Add Game / Import CSV flows. Approve to
            promote into the public catalogue, reject to hide them, or merge into an
            existing approved entry.
          </p>
        </div>
        <NeonButton variant="ghost" onClick={load}>Refresh</NeonButton>
      </div>

      {rows.length === 0 ? (
        <NeonCard>
          <p className="text-muted text-center py-8">Nothing pending. ✦</p>
        </NeonCard>
      ) : (
        <div className="space-y-3">
          {rows.map(row => {
            const isPending = pending.has(row.id);
            const submittedDate = row.submitted_at ? new Date(row.submitted_at).toLocaleString() : '—';
            return (
              <NeonCard key={row.id}>
                <div className="flex flex-col md:flex-row md:items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap mb-1">
                      <h3 className="font-display text-lg text-primary">{row.name}</h3>
                      <span className="text-xs px-2 py-0.5 rounded bg-neon-amber/15 text-neon-amber border border-neon-amber/30 font-display">
                        {row.type}
                      </span>
                    </div>
                    <div className="text-sm text-muted space-x-3">
                      {(row.manufacturer || row.year) && (
                        <span>{[row.manufacturer, row.year].filter(Boolean).join(' · ')}</span>
                      )}
                      {row.platforms.length > 0 && (
                        <span className="text-faint">Platforms: {row.platforms.join(', ')}</span>
                      )}
                    </div>
                    <div className="text-xs text-faint mt-2 flex flex-wrap gap-3">
                      <span>
                        Submitted by{' '}
                        <span className="text-muted">{row.submitted_by_username || row.submitted_by_user_id || 'unknown'}</span>
                      </span>
                      {row.submitted_by_room_name && (
                        <span>
                          From room{' '}
                          {row.submitted_by_room_slug ? (
                            <Link to={`/${row.submitted_by_room_slug}/admin`} className="text-neon-cyan hover:underline">
                              {row.submitted_by_room_name}
                            </Link>
                          ) : (
                            <span className="text-muted">{row.submitted_by_room_name}</span>
                          )}
                        </span>
                      )}
                      <span>{submittedDate}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 md:flex-shrink-0">
                    <NeonButton onClick={() => handleApprove(row)} disabled={isPending}>
                      Approve
                    </NeonButton>
                    <NeonButton variant="ghost" onClick={() => setRejectTarget(row)} disabled={isPending}>
                      Reject…
                    </NeonButton>
                    <NeonButton variant="ghost" onClick={() => { setMergeTarget(row); setMergeSearch(row.name); }} disabled={isPending}>
                      Merge into…
                    </NeonButton>
                  </div>
                </div>
              </NeonCard>
            );
          })}
        </div>
      )}

      {/* Reject modal */}
      {rejectTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={() => setRejectTarget(null)}>
          <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border/30">
              <h3 className="font-display font-bold text-primary">Reject "{rejectTarget.name}"</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-muted">
                The submitting room keeps its library entry; the global catalogue marks this row as rejected
                and it stays out of public surfaces.
              </p>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Reason (optional, audited)
                </label>
                <textarea
                  value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  rows={3}
                  placeholder="e.g. Duplicate of X submitted yesterday; mod-only release; not a real table"
                  className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
                />
              </div>
              <div className="flex justify-end gap-2">
                <NeonButton variant="ghost" onClick={() => { setRejectTarget(null); setRejectReason(''); }}>
                  Cancel
                </NeonButton>
                <NeonButton onClick={handleRejectConfirm} disabled={pending.has(rejectTarget.id)}>
                  Confirm Reject
                </NeonButton>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Merge modal */}
      {mergeTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={() => { setMergeTarget(null); setMergeSearch(''); setMergeCandidates([]); }}>
          <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-lg mx-4" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-border/30">
              <h3 className="font-display font-bold text-primary">Merge "{mergeTarget.name}" into…</h3>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-muted">
                Search for the existing approved entry to merge into. Room references re-point and the pending row is deleted.
              </p>
              <input
                type="text"
                value={mergeSearch}
                onChange={e => setMergeSearch(e.target.value)}
                placeholder="Search the catalogue…"
                className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
                autoFocus
              />
              <div className="space-y-2 max-h-72 overflow-y-auto">
                {mergeCandidates.length === 0 ? (
                  <p className="text-faint text-xs italic">Type to search.</p>
                ) : (
                  mergeCandidates.map(c => (
                    <div key={c.id} className="flex items-center justify-between gap-3 bg-raised/50 px-3 py-2 rounded text-sm">
                      <div className="min-w-0">
                        <span className="text-primary font-medium">{c.name}</span>
                        {(c.manufacturer || c.year) && (
                          <span className="text-faint ml-2">({[c.manufacturer, c.year].filter(Boolean).join(', ')})</span>
                        )}
                      </div>
                      <NeonButton variant="secondary" className="text-xs px-2 py-1 flex-shrink-0"
                        onClick={() => handleMergeConfirm(c.id)} disabled={pending.has(mergeTarget.id)}>
                        Merge here
                      </NeonButton>
                    </div>
                  ))
                )}
              </div>
              <div className="flex justify-end">
                <NeonButton variant="ghost" onClick={() => { setMergeTarget(null); setMergeSearch(''); setMergeCandidates([]); }}>
                  Cancel
                </NeonButton>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
