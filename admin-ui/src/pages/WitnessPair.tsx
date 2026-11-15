import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Check } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import NeonButton from '../components/NeonButton';
import AwPageShell from '../components/AwPageShell';
import { cleanCode } from '../lib/pairCode';
import WitnessModelLabel from '../components/WitnessModelLabel';

/**
 * W103 - pair by phone. `/pair` takes the six-character code the cabinet shows;
 * `/pair/:code` (what the cabinet's QR code opens) shows what is being paired
 * and lets the signed-in player approve it. The cabinet finishes pairing itself.
 * A guest is sent to log in and returned to the same URL.
 *
 * W105 (v2.251.0) - in the Arcaid Witness theme: states are kit chips (cyan
 * approved, pink the approve-only-here warning, red any problem); the flow is
 * unchanged.
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

/** A red problem chip; `role="alert"` so a screen reader announces it. */
function Problem({ children }: { children: string }) {
  return (
    <div>
      <p className="aw-chip aw-chip--danger" role="alert"><AlertCircle aria-hidden="true" />{children}</p>
    </div>
  );
}

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
    <AwPageShell sub="PAIR A CABINET" footer={<Link to="/witness/install">INSTALL GUIDE</Link>}>
      <section className="aw-panel" data-testid="pair-confirm">
        <h1 className="aw-label">Pair a cabinet</h1>
        {!playerToken && (
          <>
            <p className="aw-body mb-4">Log in to pair this cabinet with your account.</p>
            <LoginButtons
              vertical
              onDiscordLogin={() => loginWithDiscord('__global__', returnPath)}
              onGoogleLogin={() => loginWithGoogle('__global__', returnPath)}
            />
          </>
        )}
        {playerToken && approved && (
          <>
            <div>
              <p className="aw-chip aw-chip--success"><Check aria-hidden="true" />Approved</p>
            </div>
            <p className="aw-body mt-4 mb-3">The cabinet finishes pairing in a few seconds.</p>
            <p className="aw-body">
              <Link to="/account/settings#witness-devices" className="text-neon-cyan underline">Go to your devices in Account Settings</Link>
            </p>
          </>
        )}
        {playerToken && !approved && problem && !info && (
          <>
            <Problem>{problem}</Problem>
            <p className="aw-body mt-4">
              <Link to="/pair" className="text-neon-cyan underline">Type a different code</Link>
            </p>
          </>
        )}
        {playerToken && !approved && !problem && !info && <p className="aw-body">Loading…</p>}
        {playerToken && !approved && info && (
          <>
            <div className="aw-body space-y-1 mb-3">
              <p>
                <b>{info.deviceType === 'desktop' ? 'PC' : 'Cabinet'}</b>{' '}
                <WitnessModelLabel model={info.deviceModel} modelName={info.deviceModelName} className="aw-body" />
              </p>
              <p>Device ending in {info.deviceTail}</p>
              {info.atgamesUsername && <p className="break-words">AtGames name: {info.atgamesUsername}</p>}
            </div>
            {info.alreadyYours && (
              <p className="aw-body mb-3">This cabinet is already on your account. Approving pairs it again.</p>
            )}
            <div>
              <p className="aw-chip aw-chip--attention"><AlertTriangle aria-hidden="true" />Only approve if you are standing at this cabinet and this code is on its screen.</p>
            </div>
            {problem && <Problem>{problem}</Problem>}
            <div className="flex gap-2 mt-6">
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
      </section>
    </AwPageShell>
  );
}
