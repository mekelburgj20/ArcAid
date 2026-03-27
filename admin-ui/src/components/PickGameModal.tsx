import { useState } from 'react';
import { X, Zap, Clock, ChevronDown } from 'lucide-react';

interface PendingPick {
  tournament_id: string;
  tournament_name: string;
  picker_type: string;
  picker_designated_at: string;
}

interface TournamentOption {
  id: string;
  name: string;
  type: string;
  mode: string;
}

interface PickGameModalProps {
  gameName: string;
  tournaments: TournamentOption[];
  pendingPicks: PendingPick[];
  selectedTournamentId: string | null;
  onConfirm: (tournamentId: string) => Promise<void>;
  onClose: () => void;
}

export default function PickGameModal({
  gameName,
  tournaments,
  pendingPicks,
  selectedTournamentId,
  onConfirm,
  onClose,
}: PickGameModalProps) {
  const [tournamentId, setTournamentId] = useState(selectedTournamentId || (tournaments[0]?.id ?? ''));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedTournament = tournaments.find(t => t.id === tournamentId);
  const hasPendingPick = pendingPicks.some(p => p.tournament_id === tournamentId);

  const handleConfirm = async () => {
    if (!tournamentId) return;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm(tournamentId);
    } catch (err: any) {
      setError(err.message || 'Failed to pick game');
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4" onClick={onClose}>
      <div className="bg-surface border border-border rounded-xl w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
          <h2 className="font-display text-lg font-bold text-primary">Pick Game</h2>
          <button onClick={onClose} className="p-1 text-muted hover:text-primary transition-colors cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Game name */}
          <div>
            <p className="text-xs text-faint uppercase tracking-wider mb-1">Game</p>
            <p className="font-display text-primary font-medium">{gameName}</p>
          </div>

          {/* Tournament selector */}
          <div>
            <p className="text-xs text-faint uppercase tracking-wider mb-1">Tournament</p>
            {tournaments.length === 1 ? (
              <p className="text-primary text-sm">{tournaments[0].name}</p>
            ) : (
              <div className="relative">
                <select
                  value={tournamentId}
                  onChange={e => { setTournamentId(e.target.value); setError(''); }}
                  className="w-full appearance-none bg-raised border border-border rounded-lg px-3 py-2 pr-8 text-sm text-primary focus:outline-none focus:border-neon-cyan/50 cursor-pointer"
                >
                  {tournaments.map(t => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {pendingPicks.some(p => p.tournament_id === t.id) ? ' (your pick!)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
              </div>
            )}
          </div>

          {/* Status indicator */}
          {hasPendingPick ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neon-green/10 border border-neon-green/30">
              <Zap size={16} className="text-neon-green flex-shrink-0" />
              <p className="text-xs text-neon-green">
                You have a win pick for <span className="font-medium">{selectedTournament?.name}</span> — this game will activate immediately if a slot is open!
              </p>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neon-cyan/10 border border-neon-cyan/30">
              <Clock size={16} className="text-neon-cyan flex-shrink-0" />
              <p className="text-xs text-neon-cyan">
                This game will be queued for <span className="font-medium">{selectedTournament?.name}</span> and will activate when a slot opens.
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-neon-magenta/10 border border-neon-magenta/30">
              <p className="text-xs text-neon-magenta">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-border/50">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-primary transition-colors cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting || !tournamentId}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-neon-cyan/20 border border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/30 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Picking...' : hasPendingPick ? 'Pick & Activate' : 'Queue Game'}
          </button>
        </div>
      </div>
    </div>
  );
}
