import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { AlertTriangle, Trash2, XCircle, RefreshCw, Play, Lock, EyeOff, Plus, Zap, Recycle } from 'lucide-react';

interface GameState {
  id: string;
  name: string;
  status: string;
  iscored_id: string | null;
  picker_discord_id: string | null;
  picker_type: string | null;
  picker_designated_at: string | null;
  reminder_count: number;
  won_game_id: string | null;
  start_date: string | null;
  end_date: string | null;
  queue_order: number | null;
  style_id: string | null;
  tournament_name: string;
  tournament_type: string;
  tournament_id: string;
}

interface ReconcileEntry {
  id: string;
  name: string;
  hidden: boolean;
  locked: boolean;
  tags: string[];
  localName: string | null;
  localStatuses: string[];
}

interface ReconcilePlan {
  keep: ReconcileEntry[];
  orphans: ReconcileEntry[];
  unmanaged: ReconcileEntry[];
}

type StatusFilter = 'ALL' | 'ACTIVE' | 'QUEUED' | 'COMPLETED' | 'ARCHIVED';

// ALL is "currently meaningful states" — explicitly excludes ARCHIVED
// (post-cleanup historical anchors). ARCHIVED has its own chip so the page
// can still surface them, but the default rescue-page view stays focused.

const STATUS_BADGES: Record<string, { color: string }> = {
  ACTIVE:    { color: 'bg-neon-green/20 text-neon-green border-neon-green/30' },
  QUEUED:    { color: 'bg-neon-amber/20 text-neon-amber border-neon-amber/30' },
  COMPLETED: { color: 'bg-muted/20 text-muted border-border' },
  ARCHIVED:  { color: 'bg-faint/15 text-faint border-faint/30' },
};

function formatDate(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso + (iso.includes('Z') ? '' : 'Z'));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function GameStates() {
  const room = useRoom();
  const [games, setGames] = useState<GameState[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    description: string;
    onConfirm: () => Promise<void>;
    danger?: boolean;
    options?: { label: string; key: string; checked: boolean }[];
  } | null>(null);

  // Tournament list for force-maintenance
  const [tournaments, setTournaments] = useState<{ id: string; name: string }[]>([]);

  // iScored reconcile modal state
  const [reconcile, setReconcile] = useState<{ loading: boolean; plan: ReconcilePlan | null; selected: Set<string>; running: boolean } | null>(null);

  const fetchGames = async () => {
    try {
      // Always pull every status; filter chips operate client-side so the
      // count next to each chip is accurate regardless of the active filter.
      const data = await api.get<GameState[]>(`/rooms/${room.roomId}/admin/game-states`);
      setGames(data);
    } catch {
      setMessage({ text: 'Failed to load games', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    fetchGames();
  }, [room.roomId]);

  // ALL excludes ARCHIVED (post-cleanup historical anchors). The ARCHIVED
  // chip is the way in if the admin wants to see them.
  const displayedGames = filter === 'ALL'
    ? games.filter(g => g.status !== 'ARCHIVED')
    : games.filter(g => g.status === filter);

  useEffect(() => {
    api.get<{ id: string; name: string }[]>(`/rooms/${room.roomId}/tournaments`)
      .then(data => setTournaments(data))
      .catch(() => {});
  }, [room.roomId]);

  const showMsg = (text: string, type: 'success' | 'error') => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  };

  // --- iScored reconcile ---

  const openReconcile = async () => {
    setReconcile({ loading: true, plan: null, selected: new Set(), running: false });
    try {
      const plan = await api.get<ReconcilePlan>(`/rooms/${room.roomId}/admin/game-states/iscored-reconcile`);
      // Pre-select orphans (safe deletes); unmanaged stay unchecked (opt-in).
      setReconcile({ loading: false, plan, selected: new Set(plan.orphans.map(e => e.id)), running: false });
    } catch (err: any) {
      setReconcile(null);
      showMsg(err.message || 'Failed to load the iScored game list', 'error');
    }
  };

  const toggleReconcile = (id: string) => {
    setReconcile(r => {
      if (!r) return r;
      const selected = new Set(r.selected);
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      return { ...r, selected };
    });
  };

  const runReconcile = async () => {
    const gameIds = reconcile ? [...reconcile.selected] : [];
    if (gameIds.length === 0) return;
    setReconcile(r => (r ? { ...r, running: true } : r));
    try {
      const res = await api.post<{ deletedCount: number }>(
        `/rooms/${room.roomId}/admin/game-states/iscored-reconcile`,
        { gameIds },
      );
      showMsg(`Reconcile: deleted ${res.deletedCount} of ${gameIds.length} from iScored`, 'success');
      setReconcile(null);
      await fetchGames();
    } catch (err: any) {
      showMsg(err.message || 'Reconcile failed', 'error');
      setReconcile(r => (r ? { ...r, running: false } : r));
    }
  };

  // --- Actions ---

  const changeStatus = (game: GameState, newStatus: string) => {
    const options = [
      { label: 'Sync to iScored', key: 'syncIScored', checked: !!game.iscored_id },
    ];
    setConfirmAction({
      title: `Change Status: ${game.name}`,
      description: `${game.status} \u2192 ${newStatus}`,
      options: game.iscored_id ? options : undefined,
      onConfirm: async () => {
        const syncIScored = game.iscored_id ? (options[0].checked) : false;
        setActionLoading(game.id);
        try {
          await api.patch(`/rooms/${room.roomId}/admin/game-states/${game.id}/status`, {
            status: newStatus,
            syncIScored,
            confirm: true,
          });
          showMsg(`${game.name}: ${game.status} \u2192 ${newStatus}`, 'success');
          await fetchGames();
        } catch (err: any) {
          showMsg(err.message || 'Failed', 'error');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const clearPicker = (game: GameState) => {
    setConfirmAction({
      title: `Clear Picker: ${game.name}`,
      description: `Cancel the ${game.picker_type} pick timer for this game slot. The timeout will stop.`,
      onConfirm: async () => {
        setActionLoading(game.id);
        try {
          await api.patch(`/rooms/${room.roomId}/admin/game-states/${game.id}/clear-picker`, { confirm: true });
          showMsg(`Picker cleared for ${game.name}`, 'success');
          await fetchGames();
        } catch (err: any) {
          showMsg(err.message || 'Failed', 'error');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const deleteGame = (game: GameState) => {
    const options = game.iscored_id
      ? [{ label: 'Also delete from iScored', key: 'deleteFromIScored', checked: false }]
      : undefined;
    setConfirmAction({
      title: `Delete: ${game.name}`,
      description: `This will permanently remove this game entry and all its submissions. This cannot be undone.`,
      danger: true,
      options,
      onConfirm: async () => {
        const deleteFromIScored = game.iscored_id ? (options?.[0]?.checked ?? false) : false;
        setActionLoading(game.id);
        try {
          await api.delete(`/rooms/${room.roomId}/admin/game-states/${game.id}`, {
            deleteFromIScored,
            confirm: true,
          });
          showMsg(`Deleted: ${game.name}`, 'success');
          await fetchGames();
        } catch (err: any) {
          showMsg(err.message || 'Failed', 'error');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const syncIScored = (game: GameState, action: string) => {
    setConfirmAction({
      title: `iScored: ${action} - ${game.name}`,
      description: `This will ${action} the game on iScored.`,
      onConfirm: async () => {
        setActionLoading(game.id);
        try {
          await api.post(`/rooms/${room.roomId}/admin/game-states/${game.id}/sync-iscored`, { action });
          showMsg(`iScored ${action}: ${game.name}`, 'success');
          await fetchGames();
        } catch (err: any) {
          showMsg(err.message || 'Failed', 'error');
        } finally {
          setActionLoading(null);
        }
      },
    });
  };

  const forceMaintenance = (tournamentId: string, name: string) => {
    setConfirmAction({
      title: `Force Maintenance: ${name}`,
      description: `This will trigger the full maintenance cycle for this tournament (lock, scrape, rotate). Are you sure?`,
      danger: true,
      onConfirm: async () => {
        try {
          await api.post(`/rooms/${room.roomId}/admin/game-states/force-maintenance`, { tournamentId });
          showMsg(`Maintenance triggered for ${name}`, 'success');
          setTimeout(fetchGames, 3000); // Refresh after a delay to let maintenance run
        } catch (err: any) {
          showMsg(err.message || 'Failed', 'error');
        }
      },
    });
  };

  const cleanPhantoms = () => {
    const phantoms = games.filter(g => g.name === '[Pending Pick]' || (g.status === 'QUEUED' && !g.name));
    if (phantoms.length === 0) {
      showMsg('No phantom entries found', 'success');
      return;
    }
    setConfirmAction({
      title: `Clean ${phantoms.length} Phantom Entries`,
      description: `Found ${phantoms.length} [Pending Pick] or empty QUEUED entries. Delete them all?`,
      danger: true,
      onConfirm: async () => {
        let deleted = 0;
        for (const p of phantoms) {
          try {
            await api.delete(`/rooms/${room.roomId}/admin/game-states/${p.id}`, { confirm: true, deleteFromIScored: false });
            deleted++;
          } catch {}
        }
        showMsg(`Deleted ${deleted} phantom entries`, 'success');
        await fetchGames();
      },
    });
  };

  if (loading) return <LoadingState message="Loading game states..." />;

  const phantomCount = games.filter(g => g.name === '[Pending Pick]').length;

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <h1 className="font-display text-2xl font-bold text-primary">Game States</h1>
        <div className="flex gap-2 flex-wrap">
          {phantomCount > 0 && (
            <button
              onClick={cleanPhantoms}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-neon-amber/40 text-neon-amber bg-neon-amber/10 hover:bg-neon-amber/20 transition-colors cursor-pointer"
            >
              <AlertTriangle size={14} />
              Clean {phantomCount} Phantom{phantomCount > 1 ? 's' : ''}
            </button>
          )}
          <button
            onClick={openReconcile}
            title="Find games on iScored that ArcAid no longer tracks and delete them"
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-neon-purple/40 text-neon-purple bg-neon-purple/10 hover:bg-neon-purple/20 transition-colors cursor-pointer"
          >
            <Recycle size={14} />
            Reconcile iScored
          </button>
          <button
            onClick={() => { setLoading(true); fetchGames(); }}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-primary hover:border-neon-cyan/40 transition-colors cursor-pointer"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
      </div>

      {/* Message toast */}
      {message && (
        <div className={`mb-4 px-4 py-2 rounded text-sm ${message.type === 'success' ? 'bg-neon-green/10 text-neon-green border border-neon-green/30' : 'bg-red-500/10 text-red-400 border border-red-500/30'}`}>
          {message.text}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {(['ALL', 'ACTIVE', 'QUEUED', 'COMPLETED', 'ARCHIVED'] as StatusFilter[]).map(f => {
          const count = f === 'ALL'
            ? games.filter(g => g.status !== 'ARCHIVED').length
            : games.filter(g => g.status === f).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`text-xs px-3 py-1.5 rounded border transition-colors cursor-pointer ${
                filter === f
                  ? 'border-neon-cyan text-neon-cyan bg-neon-cyan/10'
                  : 'border-border text-muted hover:border-neon-cyan/40'
              }`}
            >
              {f} ({count})
            </button>
          );
        })}
      </div>

      {/* Force Maintenance */}
      {tournaments.length > 0 && (
        <NeonCard className="mb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-muted font-display uppercase tracking-wider">Force Maintenance:</span>
            {tournaments.map(t => (
              <button
                key={t.id}
                onClick={() => forceMaintenance(t.id, t.name)}
                className="flex items-center gap-1 text-xs px-3 py-1.5 rounded border border-neon-purple/40 text-neon-purple bg-neon-purple/10 hover:bg-neon-purple/20 transition-colors cursor-pointer"
              >
                <Zap size={12} />
                {t.name}
              </button>
            ))}
          </div>
        </NeonCard>
      )}

      {/* Games table */}
      <NeonCard>
        {displayedGames.length === 0 ? (
          <p className="text-muted text-sm py-8 text-center">No games found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/50 text-xs text-faint font-display uppercase tracking-wider">
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Game</th>
                  <th className="text-left py-2 px-2">Tournament</th>
                  <th className="text-left py-2 px-2">iScored</th>
                  <th className="text-left py-2 px-2">Picker</th>
                  <th className="text-left py-2 px-2">Date</th>
                  <th className="text-right py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {displayedGames.map(game => {
                  const badge = STATUS_BADGES[game.status] || STATUS_BADGES.COMPLETED;
                  const isPhantom = game.name === '[Pending Pick]';
                  const isLoading = actionLoading === game.id;

                  return (
                    <tr
                      key={game.id}
                      className={`border-b border-border/20 hover:bg-raised/50 transition-colors ${isPhantom ? 'opacity-60' : ''} ${isLoading ? 'opacity-50' : ''}`}
                    >
                      {/* Status */}
                      <td className="py-2.5 px-2">
                        <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${badge.color}`}>
                          {game.status}
                        </span>
                      </td>

                      {/* Name */}
                      <td className="py-2.5 px-2">
                        <span className={`text-primary ${isPhantom ? 'italic text-faint' : ''}`}>
                          {game.name}
                        </span>
                        {game.queue_order != null && game.status === 'QUEUED' && !isPhantom && (
                          <span className="text-faint text-xs ml-1.5">#{game.queue_order}</span>
                        )}
                      </td>

                      {/* Tournament */}
                      <td className="py-2.5 px-2 text-muted text-xs">{game.tournament_name}</td>

                      {/* iScored */}
                      <td className="py-2.5 px-2">
                        {game.iscored_id ? (
                          <span className="text-xs text-neon-cyan font-mono">{game.iscored_id.slice(0, 8)}...</span>
                        ) : (
                          <span className="text-xs text-faint">none</span>
                        )}
                      </td>

                      {/* Picker */}
                      <td className="py-2.5 px-2">
                        {game.picker_discord_id ? (
                          <div className="flex items-center gap-1">
                            <span className="text-xs text-neon-amber">{game.picker_type}</span>
                            <span className="text-[10px] text-faint">({game.reminder_count}r)</span>
                          </div>
                        ) : (
                          <span className="text-faint text-xs">--</span>
                        )}
                      </td>

                      {/* Date */}
                      <td className="py-2.5 px-2 text-xs text-muted">
                        {game.status === 'ACTIVE' ? formatDate(game.start_date) :
                         game.status === 'COMPLETED' ? formatDate(game.end_date) :
                         formatDate(game.picker_designated_at)}
                      </td>

                      {/* Actions */}
                      <td className="py-2.5 px-2">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          {/* Status transitions */}
                          {game.status !== 'ACTIVE' && !isPhantom && (
                            <ActionBtn icon={<Play size={13} />} title="Force Active" onClick={() => changeStatus(game, 'ACTIVE')} color="green" />
                          )}
                          {game.status === 'ACTIVE' && (
                            <ActionBtn icon={<Lock size={13} />} title="Force Complete" onClick={() => changeStatus(game, 'COMPLETED')} color="muted" />
                          )}

                          {/* Picker */}
                          {game.picker_discord_id && (
                            <ActionBtn icon={<XCircle size={13} />} title="Clear Picker" onClick={() => clearPicker(game)} color="amber" />
                          )}

                          {/* iScored sync */}
                          {game.iscored_id && game.status === 'ACTIVE' && (
                            <ActionBtn icon={<Lock size={13} />} title="Lock on iScored" onClick={() => syncIScored(game, 'lock')} color="muted" />
                          )}
                          {game.iscored_id && game.status !== 'ACTIVE' && (
                            <ActionBtn icon={<Play size={13} />} title="Unlock on iScored" onClick={() => syncIScored(game, 'unlock')} color="cyan" />
                          )}
                          {game.iscored_id && (
                            <ActionBtn icon={<EyeOff size={13} />} title="Hide on iScored" onClick={() => syncIScored(game, 'hide')} color="muted" />
                          )}
                          {!game.iscored_id && !isPhantom && (
                            <ActionBtn icon={<Plus size={13} />} title="Create on iScored" onClick={() => syncIScored(game, 'create')} color="cyan" />
                          )}

                          {/* Delete */}
                          <ActionBtn icon={<Trash2 size={13} />} title="Delete" onClick={() => deleteGame(game)} color="red" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </NeonCard>

      {/* Confirm Modal */}
      {confirmAction && (
        <ConfirmModal
          title={confirmAction.title}
          description={confirmAction.description}
          danger={confirmAction.danger}
          options={confirmAction.options}
          onConfirm={async () => {
            setConfirmAction(null);
            await confirmAction.onConfirm();
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}

      {/* iScored Reconcile Modal */}
      {reconcile && (
        <ReconcileModal
          state={reconcile}
          onToggle={toggleReconcile}
          onRun={runReconcile}
          onCancel={() => setReconcile(null)}
        />
      )}
    </div>
  );
}

// Small action button component
function ActionBtn({ icon, title, onClick, color }: { icon: React.ReactNode; title: string; onClick: () => void; color: string }) {
  const colorMap: Record<string, string> = {
    green: 'text-neon-green hover:bg-neon-green/10',
    amber: 'text-neon-amber hover:bg-neon-amber/10',
    cyan: 'text-neon-cyan hover:bg-neon-cyan/10',
    red: 'text-red-400 hover:bg-red-500/10',
    muted: 'text-muted hover:bg-raised',
  };
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded transition-colors cursor-pointer ${colorMap[color] || colorMap.muted}`}
    >
      {icon}
    </button>
  );
}

// iScored reconcile modal — keep/orphan/unmanaged buckets with per-row delete opt-in.
function ReconcileModal({ state, onToggle, onRun, onCancel }: {
  state: { loading: boolean; plan: ReconcilePlan | null; selected: Set<string>; running: boolean };
  onToggle: (id: string) => void;
  onRun: () => void;
  onCancel: () => void;
}) {
  const { loading, plan, selected, running } = state;
  const row = (e: ReconcileEntry, kind: 'orphan' | 'unmanaged') => (
    <label key={e.id} className="flex items-center gap-2 py-1.5 px-2 rounded hover:bg-raised cursor-pointer text-sm">
      <input type="checkbox" checked={selected.has(e.id)} onChange={() => onToggle(e.id)} className="accent-red-400" />
      <span className="text-primary flex-1 truncate">{e.name || `(id ${e.id})`}</span>
      {e.tags.length > 0 && <span className="text-[10px] text-muted shrink-0">{e.tags.join(', ')}</span>}
      <span className="text-[10px] text-faint shrink-0">{kind === 'orphan' ? `local: ${e.localStatuses.join('/')}` : 'not in ArcAid'}</span>
    </label>
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg shadow-2xl p-6 max-w-lg w-full mx-4 max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <h3 className="font-display font-bold text-primary mb-1">Reconcile iScored</h3>
        {loading ? (
          <p className="text-sm text-muted py-6">Loading iScored game list…</p>
        ) : !plan ? (
          <p className="text-sm text-red-400 py-6">Could not load the iScored game list.</p>
        ) : (
          <>
            <p className="text-xs text-muted mb-3">
              {plan.keep.length + plan.orphans.length + plan.unmanaged.length} on iScored ·{' '}
              <span className="text-neon-green">{plan.keep.length} live (kept)</span> ·{' '}
              <span className="text-red-400">{plan.orphans.length} orphan{plan.orphans.length !== 1 ? 's' : ''}</span> ·{' '}
              <span className="text-neon-amber">{plan.unmanaged.length} unmanaged</span>
            </p>
            <div className="overflow-y-auto flex-1 -mx-2 px-2 space-y-3">
              {plan.orphans.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-red-400 mb-1">Orphans — archived in ArcAid, still on iScored</div>
                  {plan.orphans.map(e => row(e, 'orphan'))}
                </div>
              )}
              {plan.unmanaged.length > 0 && (
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-neon-amber mb-1">Unmanaged — not in ArcAid (check only if you're sure)</div>
                  {plan.unmanaged.map(e => row(e, 'unmanaged'))}
                </div>
              )}
              {plan.orphans.length === 0 && plan.unmanaged.length === 0 && (
                <p className="text-sm text-neon-green py-4">Nothing to clean up — iScored matches ArcAid. 🎉</p>
              )}
            </div>
            <div className="flex justify-end gap-2 mt-4 pt-3 border-t border-border">
              <button onClick={onCancel} className="text-xs px-3 py-1.5 rounded border border-border text-muted hover:text-primary cursor-pointer">Cancel</button>
              <button
                onClick={onRun}
                disabled={running || selected.size === 0}
                className="text-xs px-3 py-1.5 rounded border border-red-500/40 text-red-400 bg-red-500/10 hover:bg-red-500/20 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {running ? 'Deleting…' : `Delete ${selected.size} from iScored`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Confirm modal with optional checkboxes
function ConfirmModal({ title, description, danger, options, onConfirm, onCancel }: {
  title: string;
  description: string;
  danger?: boolean;
  options?: { label: string; key: string; checked: boolean }[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onCancel}>
      <div className="bg-surface border border-border rounded-lg shadow-2xl p-6 max-w-md w-full mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="font-display font-bold text-primary mb-2">{title}</h3>
        <p className="text-sm text-muted mb-4">{description}</p>

        {options && options.length > 0 && (
          <div className="space-y-2 mb-4">
            {options.map(opt => (
              <label key={opt.key} className="flex items-center gap-2 text-sm text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={opt.checked}
                  onChange={e => { opt.checked = e.target.checked; }}
                  className="rounded border-border"
                />
                {opt.label}
              </label>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-muted hover:text-primary border border-border rounded transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <NeonButton
            onClick={onConfirm}
            className={danger ? '!bg-red-500/20 !text-red-400 !border-red-500/40 hover:!bg-red-500/30' : ''}
          >
            Confirm
          </NeonButton>
        </div>
      </div>
    </div>
  );
}
