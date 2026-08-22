import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { getRoomSlugForPath } from '../lib/routeClass';
import { getPortal } from '../lib/portal';
import ScoreboardPreferencesModal from './ScoreboardPreferencesModal';

const PLAYER_TOKEN_KEY = 'arcaid_player_token';

/**
 * The single mount point for the Display settings sheet (v2.132.0).
 *
 * Before this release the sheet was rendered by `pages/Scoreboard.tsx`, so
 * the user-menu item that opens it could only be offered on ONE page — the
 * room scoreboard. It now lives beside `<App/>` under `ThemeProvider`, which
 * is why "Display settings" can appear in every user menu (room pages, the
 * global scoreboard, the landing page) and why the sheet still works after
 * navigating away from the scoreboard.
 *
 * The `open-scoreboard-prefs` window event is kept verbatim as the trigger:
 * `UserMenu` dispatches it, this listens. Saving fires
 * `display-settings-saved`, which `Scoreboard.tsx` listens for to re-merge
 * the viewer's overrides over the room config (the old direct `onSaved`
 * callback, now decoupled).
 *
 * Room context is resolved here rather than read from `RoomContext` on
 * purpose: this component sits ABOVE the route table, so no room provider is
 * in scope. `getPortal` is the shared slug→room cache, so on a room page the
 * lookup is almost always already settled.
 */
export const DISPLAY_SETTINGS_SAVED_EVENT = 'display-settings-saved';

interface RoomData {
  slug: string;
  name: string;
  config: Record<string, string>;
}

/** Stable empty object so a room-less render doesn't churn the modal's props. */
const EMPTY_CONFIG: Record<string, string> = {};

export default function DisplaySettingsHost() {
  const { pathname } = useLocation();
  const slug = getRoomSlugForPath(pathname);
  const [open, setOpen] = useState(false);
  const [playerToken, setPlayerToken] = useState<string | null>(null);
  // Stored WITH the slug it belongs to, so leaving the room derives its way
  // back to empty defaults instead of needing a clearing setState in an
  // effect body (which would also flash room A's defaults inside room B).
  const [roomData, setRoomData] = useState<RoomData | null>(null);

  useEffect(() => {
    const handler = () => {
      // Read the token at open time, not at mount: this component outlives
      // every login/logout in the session.
      setPlayerToken(localStorage.getItem(PLAYER_TOKEN_KEY));
      setOpen(true);
    };
    window.addEventListener('open-scoreboard-prefs', handler);
    return () => window.removeEventListener('open-scoreboard-prefs', handler);
  }, []);

  // Room defaults are only needed while the sheet is open on a room page —
  // fetching them on every navigation would add a request to pages that may
  // never open the sheet at all.
  useEffect(() => {
    if (!open || !slug) return;
    let cancelled = false;
    (async () => {
      try {
        const portal = await getPortal(slug);
        if (cancelled || !portal?.roomId) return;
        const res = await fetch(`/api/rooms/${portal.roomId}/scoreboard-config`);
        const cfg = res.ok ? await res.json() : {};
        if (!cancelled) setRoomData({ slug, name: portal.name, config: cfg || {} });
      } catch { /* the sheet renders fine with empty room defaults */ }
    })();
    return () => { cancelled = true; };
  }, [open, slug]);

  // Guests have no player token and therefore no stored preferences; the user
  // menu that opens this only exists for signed-in viewers anyway.
  if (!open || !playerToken) return null;

  const forThisRoom = slug && roomData?.slug === slug ? roomData : null;

  return (
    <ScoreboardPreferencesModal
      open
      onClose={() => setOpen(false)}
      playerToken={playerToken}
      roomConfig={forThisRoom?.config ?? EMPTY_CONFIG}
      roomScoped={!!slug}
      roomName={forThisRoom?.name}
      onSaved={() => window.dispatchEvent(new Event(DISPLAY_SETTINGS_SAVED_EVENT))}
    />
  );
}
