import { useState } from 'react';
import { Lock, Clock } from 'lucide-react';
import LoginButtons from './LoginButtons';
import type { Portal } from '../lib/portal';

/**
 * Approval-rooms (v2.39.0) hard view gate — the screen a non-member (or a
 * member with an outstanding request) sees instead of the room's normal
 * content. Room branding (logo/name/theme) still renders — only score/
 * leaderboard/social content is withheld, matching the server-side gate.
 *
 * `viewerStatus` starts from the portal's value but can be locally overridden
 * after a successful "Request to join" so the UI updates immediately without
 * waiting on a fresh portal fetch (the portal cache in lib/portal.ts is keyed
 * per-slug for the SPA session and won't naturally refresh mid-visit).
 */
interface Props {
  portal: Portal;
  discordUser: { discordId: string; username: string; avatar: string | null } | null;
  onLoginDiscord: () => void;
  onLoginGoogle: () => void;
  onRequestJoin: () => Promise<'pending' | 'member' | null>;
}

export default function RoomJoinGate({ portal, discordUser, onLoginDiscord, onLoginGoogle, onRequestJoin }: Props) {
  const [localStatus, setLocalStatus] = useState<'pending' | 'member' | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveStatus = localStatus ?? portal.viewer_status ?? 'none';

  const handleRequest = async () => {
    setRequesting(true);
    setError(null);
    const status = await onRequestJoin();
    setRequesting(false);
    if (status) {
      setLocalStatus(status);
    } else {
      setError('Could not send your request — please try again.');
    }
  };

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 py-16 text-center">
      {portal.logo_url && (
        <img
          src={portal.logo_url}
          alt=""
          className="w-20 h-20 object-contain mb-6"
          style={{ filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.5))' }}
        />
      )}
      <h1 className="font-display text-2xl font-bold mb-2">{portal.name}</h1>

      {effectiveStatus === 'pending' ? (
        <>
          <div className="flex items-center gap-2 text-neon-amber mb-2">
            <Clock size={18} />
            <span className="font-medium">Request pending</span>
          </div>
          <p className="text-muted text-sm max-w-sm">
            Your request to join this room is waiting on a room admin. You'll be able to see scores
            and leaderboards here as soon as it's approved.
          </p>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 text-muted mb-2">
            <Lock size={18} />
            <span className="font-medium">This room requires approval to join</span>
          </div>
          <p className="text-muted text-sm max-w-sm mb-6">
            Scores, leaderboards, and other room content are hidden until a room admin approves your request.
          </p>

          {discordUser ? (
            <button
              type="button"
              onClick={handleRequest}
              disabled={requesting}
              className="px-5 py-2.5 rounded-lg bg-neon-cyan/15 border border-neon-cyan/40 text-neon-cyan font-medium hover:bg-neon-cyan/25 transition-colors cursor-pointer disabled:opacity-60"
            >
              {requesting ? 'Requesting…' : 'Request to join'}
            </button>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-xs text-faint">Sign in to request to join.</p>
              <LoginButtons onDiscordLogin={onLoginDiscord} onGoogleLogin={onLoginGoogle} />
            </div>
          )}
          {error && <p className="text-xs text-neon-magenta mt-3">{error}</p>}
        </>
      )}
    </div>
  );
}
