import { useState } from 'react';
import { Flag } from 'lucide-react';
import NeonButton from './NeonButton';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

/**
 * S22 Phase 1 content moderation (v2.43.0) — shared, target-agnostic report
 * modal. One component for both "report a room" and "report a player name"
 * (do not fork two modals — the contract is explicit about this). Uses the
 * PLAYER token (Discord/Google login on public pages), not the admin `api`
 * lib, since this renders on public room/player pages — mirrors
 * PlayerDetail.tsx's raw-fetch-with-playerToken pattern for follow/unfollow.
 */

interface ReportContentModalProps {
  /** Modal heading, e.g. "Report this room" / "Report this name". */
  title: string;
  /** One-line description of what's being reported, e.g. the room name or player name. */
  targetLabel: string;
  /** Path under /api, e.g. `/global/rooms/${roomId}/report` or `/global/report-name`. */
  endpoint: string;
  /** Extra body fields merged with `{ reason }`, e.g. `{ roomId, targetUserId, targetName }`. */
  extraBody?: Record<string, unknown>;
  onClose: () => void;
}

export default function ReportContentModal({ title, targetLabel, endpoint, extraBody, onClose }: ReportContentModalProps) {
  const { playerToken } = useViewerAuth();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<'idle' | 'success' | 'duplicate' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async () => {
    if (!playerToken || submitting) return;
    setSubmitting(true);
    setOutcome('idle');
    try {
      const res = await fetch(`/api${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${playerToken}`,
        },
        body: JSON.stringify({ reason: reason.trim() || undefined, ...extraBody }),
      });
      if (res.status === 409) {
        setOutcome('duplicate');
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setErrorMessage(body?.error || 'Failed to submit report.');
        setOutcome('error');
        return;
      }
      setOutcome('success');
    } catch {
      setErrorMessage('Failed to submit report.');
      setOutcome('error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="font-display text-lg font-bold text-primary mb-1 flex items-center gap-2">
          <Flag size={18} className="text-neon-magenta" />
          {title}
        </h3>
        <p className="text-muted text-sm mb-4">{targetLabel}</p>

        {outcome === 'success' ? (
          <>
            <p className="text-neon-green text-sm mb-6">Thanks — a moderator will review this.</p>
            <div className="flex justify-end">
              <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
            </div>
          </>
        ) : outcome === 'duplicate' ? (
          <>
            <p className="text-neon-amber text-sm mb-6">You've already reported this — it's still pending review.</p>
            <div className="flex justify-end">
              <NeonButton variant="ghost" onClick={onClose}>Close</NeonButton>
            </div>
          </>
        ) : (
          <>
            <label htmlFor="report-reason" className="block text-xs text-faint mb-1">
              Reason (optional)
            </label>
            <textarea
              id="report-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              placeholder="What's wrong?"
              rows={3}
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 resize-none mb-2"
            />
            {outcome === 'error' && errorMessage && (
              <p className="text-neon-magenta text-xs mb-2">{errorMessage}</p>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <NeonButton variant="ghost" onClick={onClose} disabled={submitting}>Cancel</NeonButton>
              <NeonButton variant="danger" onClick={handleSubmit} disabled={submitting}>
                {submitting ? 'Submitting…' : 'Submit Report'}
              </NeonButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
