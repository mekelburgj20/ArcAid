import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import NeonButton from '../components/NeonButton';

/**
 * Tournament invite landing page — `/tournament-invite/:code` (v2.179.0, W39,
 * ADR 0033 §6). An invite-only tournament's host shares this link; accepting it
 * joins the room (or files a join request when the room needs approval) and
 * puts the player on the tournament's roster (owner ruling 2026-10-26).
 *
 * Deliberately separate from `/invite/:token`, which is the room-ADMIN invite.
 */

interface InviteInfo {
  tournamentId: string;
  tournamentName: string;
  format: 'rotation' | 'event';
  roomId: string;
  roomSlug: string;
  roomName: string;
}

interface Accepted {
  tournamentId: string;
  roomSlug: string;
  room: 'member' | 'pending';
}

export default function TournamentInvite() {
  const { code = '' } = useParams<{ code: string }>();
  const { playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState<Accepted | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/tournament-invites/${encodeURIComponent(code)}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: InviteInfo | null) => {
        if (cancelled) return;
        if (data) setInfo(data); else setMissing(true);
      })
      .catch(() => { if (!cancelled) setMissing(true); });
    return () => { cancelled = true; };
  }, [code]);

  const accept = async () => {
    if (!playerToken) return;
    setAccepting(true);
    setError(null);
    try {
      const res = await fetch(`/api/tournament-invites/${encodeURIComponent(code)}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { setError(body.error || 'Could not accept the invite'); return; }
      setAccepted(body as Accepted);
    } catch {
      setError('Could not accept the invite');
    } finally {
      setAccepting(false);
    }
  };

  const returnPath = `/tournament-invite/${code}`;
  const tournamentLink = (slug: string, id: string) =>
    info?.format === 'event' ? `/${slug}/events/${id}` : `/${slug}`;

  return (
    <div className="min-h-screen bg-deep text-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-lg p-6" data-testid="tournament-invite">
        {missing && (
          <>
            <h1 className="font-display text-lg font-bold mb-2">Invite not found</h1>
            <p className="text-sm text-muted">This invite link is not valid any more. Ask the host for a new one.</p>
          </>
        )}
        {!missing && !info && <p className="text-sm text-muted">Loading…</p>}
        {info && !accepted && (
          <>
            <p className="text-xs font-display uppercase tracking-wider text-muted mb-1">You're invited</p>
            <h1 className="font-display text-xl font-bold mb-1">{info.tournamentName}</h1>
            <p className="text-sm text-muted mb-5">in {info.roomName}. Accepting puts you on the roster, so your scores count here.</p>
            {error && <p className="text-xs text-neon-magenta mb-3" role="alert">{error}</p>}
            {playerToken ? (
              <NeonButton onClick={accept} disabled={accepting} className="w-full">
                {accepting ? 'Joining…' : 'Accept invite'}
              </NeonButton>
            ) : (
              <>
                <p className="text-sm mb-3">Log in to accept.</p>
                <LoginButtons
                  vertical
                  onDiscordLogin={() => loginWithDiscord(info.roomSlug, returnPath)}
                  onGoogleLogin={() => loginWithGoogle(info.roomSlug, returnPath)}
                />
              </>
            )}
          </>
        )}
        {info && accepted && (
          <>
            <h1 className="font-display text-xl font-bold mb-2">You're in</h1>
            <p className="text-sm text-muted mb-2">You're on the roster for <strong className="text-primary">{info.tournamentName}</strong>.</p>
            {accepted.room === 'pending' && (
              <p className="text-sm text-muted mb-2">{info.roomName} approves new members by hand; your request to join the room is waiting. Your scores in this tournament count meanwhile.</p>
            )}
            <Link to={tournamentLink(accepted.roomSlug, accepted.tournamentId)} className="text-neon-cyan text-sm underline">
              Go to {info.format === 'event' ? 'the event' : info.roomName}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
