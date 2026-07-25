import { useCallback, useEffect, useState } from 'react';
import { Check, X, Clock } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';
import { resolveAvatarUrl } from '../lib/avatar';

/**
 * Approval-rooms (v2.39.0) — room-admin join-request queue. Mirrors
 * Identity.tsx's structure (useRoom + api + refresh pattern, NeonCard/
 * NeonButton, deliberately minimal UI): a pending list with Approve/Deny,
 * resolved history below.
 */

interface JoinRequestEntry {
  id: number;
  userId: string;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  avatarHash: string | null;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function RequesterRow({ entry }: { entry: JoinRequestEntry }) {
  const avatarSrc = resolveAvatarUrl(entry.userId, entry.avatarUrl ?? entry.avatarHash);
  const label = entry.displayName || entry.userId;
  return (
    <div className="flex items-center gap-3">
      {avatarSrc ? (
        <img src={avatarSrc} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
      ) : (
        <div className="w-8 h-8 rounded-full bg-raised flex items-center justify-center text-xs text-faint flex-shrink-0">
          {label.charAt(0).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium text-primary truncate">{label}</p>
        {entry.displayName && <p className="text-xs text-faint font-mono truncate">{entry.userId}</p>}
      </div>
    </div>
  );
}

export default function JoinRequests() {
  const { roomId } = useRoom();
  const { toast } = useToast();
  const [pending, setPending] = useState<JoinRequestEntry[]>([]);
  const [resolved, setResolved] = useState<JoinRequestEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    try {
      const [p, r] = await Promise.all([
        api.get<JoinRequestEntry[]>(`/rooms/${roomId}/admin/join-requests?status=pending`),
        api.get<JoinRequestEntry[]>(`/rooms/${roomId}/admin/join-requests?status=resolved`),
      ]);
      setPending(p);
      setResolved(r);
    } catch {
      toast('Could not load join requests', 'error');
    } finally {
      setLoading(false);
    }
  }, [roomId, toast]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleApprove = async (entry: JoinRequestEntry) => {
    setActingOn(entry.id);
    try {
      await api.post(`/rooms/${roomId}/admin/join-requests/${entry.id}/approve`, {});
      toast(`Approved ${entry.displayName || entry.userId}`, 'success');
      await refresh();
    } catch {
      toast('Failed to approve', 'error');
    } finally {
      setActingOn(null);
    }
  };

  const handleDeny = async (entry: JoinRequestEntry) => {
    setActingOn(entry.id);
    try {
      await api.post(`/rooms/${roomId}/admin/join-requests/${entry.id}/deny`, {});
      toast(`Denied ${entry.displayName || entry.userId}`, 'success');
      await refresh();
    } catch {
      toast('Failed to deny', 'error');
    } finally {
      setActingOn(null);
    }
  };

  if (loading) return <LoadingState message="Loading join requests…" />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-4">Join Requests</h1>
      <p className="text-muted text-sm mb-6">
        This room requires approval to join. Requests below are waiting on your decision — approving grants
        room membership immediately.
      </p>

      <NeonCard title="Pending" glowColor="amber" className="mb-4">
        {pending.length === 0 ? (
          <p className="text-faint text-sm">No pending requests.</p>
        ) : (
          <div className="space-y-2">
            {pending.map(entry => (
              <div key={entry.id} className="flex items-center justify-between gap-4 bg-raised border border-border rounded px-4 py-3">
                <RequesterRow entry={entry} />
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs text-faint hidden sm:inline">{timeAgo(entry.requestedAt)}</span>
                  <NeonButton
                    className="text-xs px-3 py-1.5"
                    onClick={() => handleApprove(entry)}
                    disabled={actingOn === entry.id}
                  >
                    <Check size={14} className="inline -mt-0.5 mr-1" />
                    Approve
                  </NeonButton>
                  <NeonButton
                    variant="ghost"
                    className="text-xs px-3 py-1.5 text-neon-magenta hover:text-neon-magenta"
                    onClick={() => handleDeny(entry)}
                    disabled={actingOn === entry.id}
                  >
                    <X size={14} className="inline -mt-0.5 mr-1" />
                    Deny
                  </NeonButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </NeonCard>

      <NeonCard title="Resolved history" glowColor="cyan">
        {resolved.length === 0 ? (
          <p className="text-faint text-sm">No resolved requests yet.</p>
        ) : (
          <div className="space-y-2">
            {resolved.map(entry => (
              <div key={entry.id} className="flex items-center justify-between gap-4 bg-raised border border-border rounded px-4 py-3">
                <RequesterRow entry={entry} />
                <div className="flex items-center gap-2 flex-shrink-0 text-xs">
                  {entry.status === 'approved' ? (
                    <span className="flex items-center gap-1 text-neon-green">
                      <Check size={14} /> Approved
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-neon-magenta">
                      <X size={14} /> Denied
                    </span>
                  )}
                  {entry.resolvedAt && (
                    <span className="text-faint flex items-center gap-1">
                      <Clock size={12} /> {timeAgo(entry.resolvedAt)}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </NeonCard>
    </div>
  );
}
