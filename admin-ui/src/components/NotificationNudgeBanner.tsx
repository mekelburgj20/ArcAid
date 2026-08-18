import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bell, MessageSquare, X } from 'lucide-react';
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
 *   DISCORD LINK (2026-08-17) — this room DOES have Discord integration, but
 *   this viewer will receive none of it: either no Discord account is linked,
 *   or one is but it shares no guild with the bot. Two different problems with
 *   two different fixes, so two different messages. Deliberately NOT triggered
 *   by "signed in with Google", which is wrong in both directions — a linked
 *   Google login works fine, and an unlinked Discord login in no shared guild
 *   does not. The server decides; it returns nothing when it cannot be sure.
 *   Dismissal is per-room and lasts 30 days rather than forever: the point is
 *   to encourage linking, and a banner on every page load only earns a reflex.
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

/**
 * Discord-link nudge dismissal, per room. Time-boxed rather than permanent:
 * the owner wants linking strongly encouraged, but a banner that reappears on
 * every visit is nagware and gets dismissed reflexively. Once a month is a
 * reminder; every page load is an irritant.
 */
const LINK_DISMISS_PREFIX = 'arcaid_discord_link_dismissed_';
const LINK_DISMISS_DAYS = 30;

function linkDismissedRecently(roomId: string | null | undefined): boolean {
  if (!roomId) return false;
  const raw = localStorage.getItem(LINK_DISMISS_PREFIX + roomId);
  if (!raw) return false;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return false;
  return Date.now() - at < LINK_DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

interface Props {
  /**
   * Room whose Discord link status to check. When set, the nudge fetch asks the
   * server whether THIS viewer is set up for THIS room's Discord features.
   */
  roomId?: string | null;
  /**
   * Whether THIS room has Discord integration. The onboarding message only
   * makes sense where it doesn't — in a Discord-connected room the player
   * already shares a server with the bot and DMs just work.
   */
  roomDiscordEnabled?: boolean;
}

export default function NotificationNudgeBanner({ roomDiscordEnabled, roomId }: Props) {
  const { discordUser, playerToken } = useViewerAuth();
  const [nudge, setNudge] = useState<{ failedAt: string; reason: string } | null>(null);
  const [dismissedFailure, setDismissedFailure] = useState(false);
  const [dismissedOnboard, setDismissedOnboard] = useState(
    () => localStorage.getItem(ONBOARD_DISMISS_KEY) === '1',
  );
  const [discordLink, setDiscordLink] = useState<
    { state: 'no_discord' | 'not_in_guild'; roomName: string | null; inviteUrl: string | null } | null
  >(null);
  const [dismissedLink, setDismissedLink] = useState(() => linkDismissedRecently(roomId));

  useEffect(() => {
    if (!playerToken) { setNudge(null); return; }
    let cancelled = false;
    // Raw fetch with the PLAYER token on purpose — lib/api.ts authenticates
    // with the ADMIN token and redirects to /login on 401, the wrong realm for
    // a Discord player. Same reasoning as AccountSettings' fetches.
    const qs = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
    fetch(`/api/me/dm-nudge${qs}`, { headers: { Authorization: `Bearer ${playerToken}` } })
      .then(r => (r.ok ? r.json() : { nudge: null, discordLink: null }))
      .then(d => {
        if (cancelled) return;
        setNudge(d?.nudge ?? null);
        setDiscordLink(d?.discordLink ?? null);
      })
      .catch(() => { /* a missing nudge is the normal case — stay silent */ });
    return () => { cancelled = true; };
  }, [playerToken, roomId]);

  useEffect(() => { setDismissedLink(linkDismissedRecently(roomId)); }, [roomId]);

  const dismissFailure = () => {
    setDismissedFailure(true);
    if (!playerToken) return;
    fetch('/api/me/dm-nudge/dismiss', {
      method: 'POST',
      headers: { Authorization: `Bearer ${playerToken}` },
    }).catch(() => { /* dismissed locally regardless */ });
  };

  const dismissLink = () => {
    setDismissedLink(true);
    if (roomId) localStorage.setItem(LINK_DISMISS_PREFIX + roomId, new Date().toISOString());
  };

  /**
   * "Don't remind me again" — a PERMANENT, per-room opt-out, distinct from the
   * X button's 30-day snooze. Stored server-side so it follows the player to
   * their other devices; hidden locally straight away so the checkbox feels
   * instant even if the request is slow.
   */
  const optOutLink = () => {
    setDismissedLink(true);
    if (roomId) localStorage.setItem(LINK_DISMISS_PREFIX + roomId, new Date().toISOString());
    if (!playerToken || !roomId) return;
    fetch('/api/me/dm-nudge/discord-link/opt-out', {
      method: 'POST',
      headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId }),
    }).catch(() => { /* hidden locally regardless; the snooze still applies */ });
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
  // Discord-link nudge: this room HAS Discord, but the viewer will not receive
  // any of it. The server only returns a status when there is something true
  // and actionable to say, so there is no "are they a Google user" test here —
  // that question is the wrong one (a linked Google login is fine; an unlinked
  // Discord login that shares no guild is not).
  const showLink = !showFailure && !!discordLink && !dismissedLink;
  const showOnboard = !showFailure && !showLink && roomDiscordEnabled === false && !dismissedOnboard;

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

  if (showLink && discordLink) {
    const room = discordLink.roomName ?? 'This game room';
    const noDiscord = discordLink.state === 'no_discord';
    return (
      <div className="mb-4 rounded border border-neon-purple/40 bg-neon-purple/10 px-3 py-2.5 flex items-start gap-2">
        <MessageSquare size={14} className="mt-0.5 shrink-0 text-neon-purple" />
        <div className="min-w-0 flex-1 text-xs text-primary">
          <p>
            {noDiscord
              ? `${room} runs its tournaments through Discord — link your Discord account to get pick alerts, tournament results and score messages.`
              : `${room} runs its tournaments through Discord, but you don't share its server with the bot yet — join it to get pick alerts and tournament messages.`}
          </p>
          <p className="mt-1 text-faint">You can keep playing and submitting scores either way.</p>
          {noDiscord ? (
            <Link to="/account/settings" className="mt-1 inline-block text-neon-cyan hover:underline">
              Link Discord
            </Link>
          ) : discordLink.inviteUrl ? (
            <a
              href={discordLink.inviteUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block text-neon-cyan hover:underline"
            >
              Join the Discord server
            </a>
          ) : (
            <span className="mt-1 inline-block text-faint">Ask a room admin for an invite.</span>
          )}
          <label className="mt-2 flex items-center gap-1.5 text-faint cursor-pointer select-none">
            <input
              type="checkbox"
              onChange={optOutLink}
              className="cursor-pointer accent-neon-purple"
            />
            <span>Don't remind me again</span>
          </label>
        </div>
        <button
          type="button"
          onClick={dismissLink}
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
