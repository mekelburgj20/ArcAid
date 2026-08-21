import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import TourOverlay from './TourOverlay';
import { TOUR_STEPS } from '../lib/tourSteps';

const DISMISSED_KEY = 'arcaid_tutorial_dismissed';
const START_DELAY_MS = 600;

/**
 * v2.48.0 — first-login player tutorial (docs/contracts/first-login-tutorial-contract.md).
 * Mounted inside PublicLayout's resolved-room branch (after the RoomJoinGate
 * resolves), so a gated/suspended/loading room never shows it. Owns only the
 * *gating* decision — whether the tour should render at all; TourOverlay owns
 * step navigation and the finish/skip persistence writes.
 *
 * Trigger = first authenticated ROOM-page visit, not literal first login —
 * fires whenever discordUser is truthy AND the server says the tour hasn't
 * been seen AND none of the exclusions below apply.
 */
export default function TourController() {
  const { discordUser, playerToken } = useViewerAuth();
  const [searchParams] = useSearchParams();
  const [shouldShow, setShouldShow] = useState(false);

  // PendingSubmissionWatcher owns this moment — do not mark seen here; the
  // tour will appear on the player's next room visit instead.
  const hasDraftParam = searchParams.has('submit-draft') || searchParams.has('submit-cancelled');

  useEffect(() => {
    if (!discordUser || !playerToken) return;
    if (hasDraftParam) return;
    if (sessionStorage.getItem(DISMISSED_KEY)) return;

    let cancelled = false;
    let timer: number | undefined;
    fetch('/api/me/tutorial-status', { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(r => (r.ok ? r.json() : null))
      .then((data: { seenAt: string | null } | null) => {
        if (cancelled || !data || data.seenAt != null) return;
        // Short delay so the page settles before the spotlight appears.
        timer = window.setTimeout(() => {
          if (!cancelled) setShouldShow(true);
        }, START_DELAY_MS);
      })
      .catch(() => {
        // Fetch failure = bail silently; never block the page on this call.
      });
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [discordUser, playerToken, hasDraftParam]);

  if (!shouldShow || !playerToken) return null;
  return <TourOverlay steps={TOUR_STEPS} playerToken={playerToken} onClose={() => setShouldShow(false)} />;
}
