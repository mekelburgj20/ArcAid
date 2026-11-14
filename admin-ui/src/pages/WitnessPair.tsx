import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import NeonButton from '../components/NeonButton';
import { cleanCode } from '../lib/pairCode';
import WitnessModelLabel from '../components/WitnessModelLabel';

/**
 * W102 - pair by phone. `/pair` takes the six-character code the cabinet shows;
 * `/pair/:code` (what the cabinet's QR code opens) shows what is being paired
 * and lets the signed-in player approve it. The cabinet finishes pairing itself.
 * A guest is sent to log in and returned to the same URL.
 */

interface PairRequest {
  code: string;
  deviceType: 'atgames' | 'desktop';
  deviceModel: string | null;
  deviceModelName: string | null;
  deviceTail: string;
  atgamesUsername: string | null;
  expiresAt: string;
  status: 'pending' | 'approved';
  alreadyYours: boolean;
}

const NOT_VALID = 'That code is not valid or has expired. Start again on the cabinet.';

export default function WitnessPair() {
  const { code: rawCode = '' } = useParams<{ code: string }>();
  const code = cleanCode(rawCode);
  const { playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const navigate = useNavigate();
  const [info, setInfo] = useState<PairRequest | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);

  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    fetch(`/api/me/witness/pair-requests/${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(async res => {
        if (cancelled) return;
        if (res.ok) {
          const body = await res.json() as PairRequest;
          setInfo(body);
          if (body.status === 'approved') setApproved(true);
        } else if (res.status === 404) {
          setProblem(NOT_VALID);
        } else {
          const body = await res.json().catch(() => ({}));
          setProblem(body.error || 'Could not read that code. Try again.');
        }
      })
      .catch(() => { if (!cancelled) setProblem('Could not read that code. Try again.'); });
    return () => { cancelled = true; };
  }, [code, playerToken]);

  const approve = async () => {
    if (!playerToken) return;
    setBusy(true); setProblem(null);
    try {
      const res = await fetch(`/api/me/witness/pair-requests/${encodeURIComponent(code)}/approve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) { setApproved(true); return; }
      const body = await res.json().catch(() => ({}));
      if (res.status === 404) setProblem(NOT_VALID);
      else setProblem(body.error || 'Could not pair this cabinet. Try again.');
    } catch {
      setProblem('Could not pair this cabinet. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const returnPath = `/pair/${code}`;

  return (
    <div className="min-h-screen bg-deep text-primary flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-surface border border-border rounded-lg p-6" data-testid="pair-confirm">
        <h1 className="font-display text-xl font-bold mb-3">Pair a cabinet</h1>
        {!playerToken && (
          <>
            <p className="text-sm mb-3">Log in to pair this cabinet with your account.</p>
            <LoginButtons
              vertical
              onDiscordLogin={() => loginWithDiscord('__global__', returnPath)}
              onGoogleLogin={() => loginWithGoogle('__global__', returnPath)}
            />
          </>
        )}
        {playerToken && approved && (
          <>
            <p className="text-sm mb-3">Approved. The cabinet finishes pairing in a few seconds.</p>
            <Link to="/account/settings#witness-devices" className="text-neon-cyan text-sm underline">Go to your devices in Account Settings</Link>
          </>
        )}
        {playerToken && !approved && problem && !info && (
          <>
            <p className="text-sm text-neon-magenta mb-3" role="alert">{problem}</p>
            <Link to="/pair" className="text-neon-cyan text-sm underline">Type a different code</Link>
          </>
        )}
        {playerToken && !approved && !problem && !info && <p className="text-sm text-muted">Loading…</p>}
        {playerToken && !approved && info && (
          <>
            <div className="mb-3 space-y-1 text-sm">
              <p>
                {info.deviceType === 'desktop' ? 'PC' : 'Cabinet'}{' '}
                <WitnessModelLabel model={info.deviceModel} modelName={info.deviceModelName} />
              </p>
              <p className="text-muted">Device ending in {info.deviceTail}</p>
              {info.atgamesUsername && <p className="text-muted break-words">AtGames name: {info.atgamesUsername}</p>}
            </div>
            {info.alreadyYours && (
              <p className="text-sm text-muted mb-3">This cabinet is already on your account. Approving pairs it again.</p>
            )}
            <p className="text-sm mb-4">Only approve if you are standing at this cabinet and this code is on its screen.</p>
            {problem && <p className="text-sm text-neon-magenta mb-3" role="alert">{problem}</p>}
            <div className="flex gap-2">
              <NeonButton onClick={approve} disabled={busy} className="flex-1">{busy ? 'Working…' : 'Pair this cabinet'}</NeonButton>
              <button
                type="button"
                onClick={() => navigate('/account/settings#witness-devices')}
                className="px-4 py-1.5 rounded border border-border text-sm text-muted hover:text-primary cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
