import { useCallback, useEffect, useState } from 'react';
import { Check, X, Clock } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';
import { relativeTimeFrom } from '../lib/format';

/**
 * Identity claim review queue (identity arc P4, 2026-08-18). Mirrors
 * JoinRequests.tsx's structure deliberately — same useRoom + api + refresh
 * pattern, same NeonCard/NeonButton vocabulary.
 *
 * A claim only reaches this queue when it did NOT match a name the claimant
 * already answers to (auto-approval is case-insensitive EXACT, nothing more).
 * So every row here is a judgement call, and the one fact that makes it
 * judgeable is `scoresInRoom` — how much history the requested name carries
 * here. Zero scores is a harmless housekeeping request; a hundred is handing
 * someone a leaderboard.
 *
 * Approving grants the alias GLOBALLY, because `user_mappings` has no room
 * scope. That is not a regression: a room admin could already do exactly this
 * with /map-user, and unlike /map-user this path is reviewed and audited.
 */

interface ClaimEntry {
  id: number;
  claimant_user_id: string;
  iscored_username: string;
  requested_at: string;
  display_name: string | null;
  username: string | null;
  scores_in_room: number;
}

export default function IdentityClaims() {
  const { roomId } = useRoom();
  const { toast } = useToast();
  const [claims, setClaims] = useState<ClaimEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!roomId) return;
    try {
      const res = await api.get<{ requests: ClaimEntry[] }>(`/rooms/${roomId}/admin/identity-claims`);
      setClaims(res.requests ?? []);
    } catch {
      toast('Could not load identity claims', 'error');
    }
    setLoading(false);
  }, [roomId, toast]);

  useEffect(() => { load(); }, [load]);

  const resolve = async (id: number, action: 'approve' | 'reject') => {
    if (!roomId) return;
    setBusyId(id);
    try {
      await api.post(`/rooms/${roomId}/admin/identity-claims/${id}/${action}`, {});
      toast(action === 'approve' ? 'Claim approved' : 'Claim rejected', 'success');
      await load();
    } catch (err) {
      // The service re-checks availability and the alias cap at approval time,
      // so a stale queue produces a real message rather than a silent no-op.
      toast(err instanceof Error ? err.message : 'Could not resolve that claim', 'error');
    }
    setBusyId(null);
  };

  if (loading) return <LoadingState message="Loading identity claims..." />;

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-xl font-bold text-primary mb-1">Identity Claims</h1>
      <p className="text-sm text-muted mb-6">
        Players asking to link an iScored name that does not match their account. Approving credits
        that name&apos;s scores to them on every leaderboard, so check the score count before you do.
      </p>

      <NeonCard>
        {claims.length === 0 ? (
          <p className="text-sm text-muted p-4">No claims waiting for review.</p>
        ) : (
          <ul className="divide-y divide-border">
            {claims.map(c => (
              <li key={c.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <p className="text-sm text-primary">
                    <span className="font-medium">{c.display_name ?? c.username ?? c.claimant_user_id}</span>
                    {' wants '}
                    <span className="font-mono">{c.iscored_username}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {c.scores_in_room === 0
                      ? 'No scores under that name in this room.'
                      : `${c.scores_in_room} score${c.scores_in_room === 1 ? '' : 's'} under that name in this room.`}
                  </p>
                  <p className="mt-0.5 text-xs text-faint flex items-center gap-1">
                    <Clock size={11} /> {relativeTimeFrom(c.requested_at)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <NeonButton
                    variant="primary"
                    disabled={busyId === c.id}
                    onClick={() => resolve(c.id, 'approve')}
                  >
                    <Check size={14} /> Approve
                  </NeonButton>
                  <NeonButton
                    variant="secondary"
                    disabled={busyId === c.id}
                    onClick={() => resolve(c.id, 'reject')}
                  >
                    <X size={14} /> Reject
                  </NeonButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </NeonCard>
    </div>
  );
}
