import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, X } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

/**
 * Site-wide notification nudges (Discord HQ arc, v2.72.0, contract Sections 4 + 5).
 *
 * Two closely-related messages, one component because they compete for the same
 * slot and must never both appear:
 *
 *   FAILURE (Section 4) — the server tried to DM this user and Discord refused,
 *   or knew in advance it would. Nothing about that is visible to the player
 *   otherwise: the DM path swallows failures by design, so without this banner
 *   they simply stop hearing from Arcaid and never learn why. Takes precedence.
 *
 *   ONBOARDING (Section 5) — this room has no Discord integration, so a player
 *   who just logged in here has no DM channel by default. Said once, framed as
 *   an offer rather than a warning, and only when there is nothing to warn about.
 *
 * Both are dismissible and stay dismissed. The failure flag clears server-side
 * (dismissal, or the next DM that lands); the onboarding one is local to the
 * browser, since it's a nicety rather than a fact about the account.
 */

const ONBOARD_DISMISS_KEY = 'arcaid_notif_onboard_dismissed';

interface Props {
  /**
   * Whether THIS room has Discord integration. The onboarding message only
   * makes sense where it doesn't — in a Discord-connected room the player
   * already shares a server with the bot and DMs just work.
   */
  roomDiscordEnabled?: boolean;
}

export default function NotificationNudgeBanner({ roomDiscordEnabled }: Props) {
  const { discordUser, playerToken } = useViewerAuth();
  const [nudge, setNudge] = useState<{ failedAt: string; reason: string } | null>(null);
  const [dismissedFailure, setDismissedFailure] = useState(false);
  const [dismissedOnboard, setDismissedOnboard] = useState(
    () => localStorage.getItem(ONBOARD_DISMISS_KEY) === '1',
  );

  useEffect(() => {
    if (!playerToken) { setNudge(null); return; }
    let cancelled = false;
    // Raw fetch with the PLAYER token on purpose — lib/api.ts authenticates
    // with the ADMIN token and redirects to /login on 401, the wrong realm for
    // a Discord player. Same reasoning as AccountSettings' fetches.
    fetch('/api/me/dm-nudge', { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(r => (r.ok ? r.json() : { nudge: null }))
      .then(d => { if (!cancelled) setNudge(d?.nudge ?? null); })
      .catch(() => { /* a missing nudge is the normal case — stay silent */ });
    return () => { cancelled = true; };
  }, [playerToken]);

  const dismissFailure = () => {
    setDismissedFailure(true);
    if (!playerToken) return;
    fetch('/api/me/dm-nudge/dismiss', {
      method: 'POST',
      headers: { Authorization: `Bearer ${playerToken}` },
    }).catch(() => { /* dismissed locally regardless */ });
  };

  const dismissOnboard = () => {
    setDismissedOnboard(true);
    localStorage.setItem(ONBOARD_DISMISS_KEY, '1');
  };

  if (!discordUser || !playerToken) return null;

  const showFailure = !!nudge && !dismissedFailure;
  // Deliberately suppressed while a failure banner is up: telling someone to
  // "set up notifications" directly beneath "we couldn't reach you" reads as
  // the app not knowing its own state.
  const showOnboard = !showFailure && roomDiscordEnabled === false && !dismissedOnboard;

  if (showFailure) {
    return (
      <div className="mb-4 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 text-xs text-primary">
          <p>
            We tried to send you a Discord notification but couldn't. Join the Arcaid community
            server or check your Discord privacy settings — or switch to browser notifications.
          </p>
          <Link to="/account/settings" className="mt-1 inline-block text-neon-cyan hover:underline">
            Open notification settings
          </Link>
        </div>
        <button
          type="button"
          onClick={dismissFailure}
          aria-label="Dismiss"
          className="shrink-0 text-faint hover:text-primary cursor-pointer bg-transparent border-none"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  if (showOnboard) {
    return (
      <div className="mb-4 rounded border border-border bg-surface px-3 py-2.5 flex items-start gap-2">
        <Bell size={14} className="mt-0.5 shrink-0 text-neon-cyan" />
        <div className="min-w-0 flex-1 text-xs text-primary">
          <p>Want score and pick notifications? Set them up once — it works for every room.</p>
          <Link to="/account/settings" className="mt-1 inline-block text-neon-cyan hover:underline">
            Set up notifications
          </Link>
        </div>
        <button
          type="button"
          onClick={dismissOnboard}
          aria-label="Dismiss"
          className="shrink-0 text-faint hover:text-primary cursor-pointer bg-transparent border-none"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return null;
}
