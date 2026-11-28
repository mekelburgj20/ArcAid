import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Check } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import NeonButton from '../components/NeonButton';
import AwPageShell from '../components/AwPageShell';

/**
 * W131.3 (ADR 0045, docs/shared-device-plan.md §3) - join a shared Arcaid
 * Witness device. An owner of the device made this single-use link at Account
 * Settings -> the device -> Add a player. The page says what joining means
 * (ruling 6: everyone on a device sees every play on it) before the player
 * accepts. A guest is sent to log in and returned to the same URL. The same
 * Witness look as `/pair/:code`.
 */

interface InvitePreview {
  deviceType: 'atgames' | 'desktop';
  deviceModelName: string | null;
  deviceTail: string;
  invitedBy: string | null;
  expiresAt: string;
  alreadyOnDevice: boolean;
}

const NOT_VALID = 'This invite link is not valid any more. Ask for a new one.';

function Problem({ children }: { children: string }) {
  return (
    <div>
      <p className="aw-chip aw-chip--danger" role="alert"><AlertCircle aria-hidden="true" />{children}</p>
    </div>
  );
}

export default function WitnessInvite() {
  const { code = '' } = useParams<{ code: string }>();
  const { playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<InvitePreview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    fetch(`/api/me/witness/device-invites/${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(async res => {
        if (cancelled) return;
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.invite) setInfo(body.invite as InvitePreview);
        else if (res.status === 404) setProblem(NOT_VALID);
        else setProblem(body.error || 'Could not read this invite. Try again.');
      })
      .catch(() => { if (!cancelled) setProblem('Could not read this invite. Try again.'); });
    return () => { cancelled = true; };
  }, [code, playerToken]);

  const accept = async () => {
    if (!playerToken) return;
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`/api/me/witness/device-invites/${encodeURIComponent(code)}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) { setJoined(true); return; }
      const body = await res.json().catch(() => ({}));
      setProblem(res.status === 404 ? NOT_VALID : (body.error || 'Could not join this device. Try again.'));
    } catch {
      setProblem('Could not join this device. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const what = info?.deviceType === 'desktop' ? 'PC' : 'cabinet';
  const returnPath = `/witness-invite/${code}`;

  return (
    <AwPageShell sub="JOIN A DEVICE" footer={<Link to="/witness/install">INSTALL GUIDE</Link>}>
      <section className="aw-panel" data-testid="witness-invite">
        <h1 className="aw-label">Join a shared {info ? what : 'device'}</h1>
        {!playerToken && (
          <>
            <p className="aw-body mb-4">Log in to join this Arcaid Witness device with your account.</p>
            <LoginButtons
              vertical
              onDiscordLogin={() => loginWithDiscord('__global__', returnPath)}
              onGoogleLogin={() => loginWithGoogle('__global__', returnPath)}
            />
          </>
        )}
        {playerToken && joined && (
          <>
            <div>
              <p className="aw-chip aw-chip--success"><Check aria-hidden="true" />You're on this {what}</p>
            </div>
            <p className="aw-body mt-4 mb-3">
              Pick yourself under Playing as before you play, here on arcaid.app or on the {what}, so your games go to you.
            </p>
            <p className="aw-body">
              <Link to="/account/settings#witness-devices" className="text-neon-cyan underline">Go to your devices in Account Settings</Link>
            </p>
          </>
        )}
        {playerToken && !joined && problem && !info && <Problem>{problem}</Problem>}
        {playerToken && !joined && !problem && !info && <p className="aw-body">Loading…</p>}
        {playerToken && !joined && info && (
          <>
            <div className="aw-body space-y-1 mb-3">
              <p>
                <b>{info.deviceType === 'desktop' ? 'PC' : 'Cabinet'}</b>
                {info.deviceModelName && <> · {info.deviceModelName}</>}
              </p>
              <p>Device ending in {info.deviceTail}</p>
              {info.invitedBy && <p className="break-words">Invited by {info.invitedBy}</p>}
            </div>
            {info.alreadyOnDevice ? (
              <p className="aw-body mb-3">You are already on this {what}.</p>
            ) : (
              <div>
                <p className="aw-chip aw-chip--attention">
                  <AlertTriangle aria-hidden="true" />
                  Everyone on this {what} sees every play on it, yours included, and who each one went to.
                </p>
              </div>
            )}
            {problem && <Problem>{problem}</Problem>}
            <div className="flex gap-2 mt-6">
              {!info.alreadyOnDevice && (
                <NeonButton onClick={accept} disabled={busy} className="flex-1">{busy ? 'Working…' : `Join this ${what}`}</NeonButton>
              )}
              <button
                type="button"
                onClick={() => navigate('/account/settings#witness-devices')}
                className="px-4 py-1.5 rounded border border-border text-sm text-muted hover:text-primary cursor-pointer"
              >
                {info.alreadyOnDevice ? 'Go to my devices' : 'Cancel'}
              </button>
            </div>
          </>
        )}
      </section>
    </AwPageShell>
  );
}
