import { useState } from 'react';
import { Zap, Clock } from 'lucide-react';
import { Dialog } from './parts/Dialog';
import Button from './parts/Button';
import { Select } from './parts/Field';

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
    <Dialog
      open
      onOpenChange={o => { if (!o) onClose(); }}
      tone="cyan"
      label="Picks"
      title="Pick a game"
      sheet
      footer={(
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={submitting || !tournamentId}>
            {submitting ? 'Picking...' : hasPendingPick ? 'Pick & Activate' : 'Queue Game'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {/* Game name */}
        <div>
          <p className="text-xs text-faint uppercase tracking-wider mb-1">Game</p>
          <p className="font-display text-primary font-medium">{gameName}</p>
        </div>

        {/* Tournament selector */}
        {tournaments.length === 1 ? (
          <div>
            <p className="text-xs text-faint uppercase tracking-wider mb-1">Tournament</p>
            <p className="text-primary text-sm">{tournaments[0].name}</p>
          </div>
        ) : (
          <Select
            id="pick-game-tournament"
            label="Tournament"
            value={tournamentId}
            onChange={e => { setTournamentId(e.target.value); setError(''); }}
          >
            {tournaments.map(t => (
              <option key={t.id} value={t.id}>
                {t.name}
                {pendingPicks.some(p => p.tournament_id === t.id) ? ' (your pick!)' : ''}
              </option>
            ))}
          </Select>
        )}

        {/* Status indicator */}
        {hasPendingPick ? (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-neon-cyan/10 border border-neon-cyan/30">
            <Zap size={16} className="text-neon-cyan flex-shrink-0" />
            <p className="text-xs text-neon-cyan">
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
          <div className="px-3 py-2 rounded-lg bg-neon-coral/10 border border-neon-coral/30">
            <p className="text-xs ink-danger">{error}</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
