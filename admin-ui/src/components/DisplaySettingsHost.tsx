import { useEffect, useState, type ComponentType } from 'react';
import { useLocation } from 'react-router-dom';
import { getRoomSlugForPath } from '../lib/routeClass';
import { getPortal } from '../lib/portal';
import { lazyPart } from '../lib/lazyPart';
import { Dialog } from './parts/Dialog';
import Button from './parts/Button';
import type { DisplaySettingsPanelProps } from './displaySettings/DisplaySettingsPanel';

const PLAYER_TOKEN_KEY = 'arcaid_player_token';

/**
 * The single mount point for Display settings (v2.132.0; the live panel since
 * G34a, v2.274.0).
 *
 * Mounted beside `<App/>` under `ThemeProvider`, so "Display settings" works
 * from every user menu (room pages, the global scoreboard, the landing page)
 * and the panel stays open while the viewer moves between pages.
 *
 * The `open-scoreboard-prefs` window event is the trigger: `UserMenu`
 * dispatches it, this listens. The panel itself is a chunk of its own
 * (`displaySettings/DisplaySettingsPanel`, fetched when the browser is idle
 * for a signed-in viewer, or on the first open), so it adds nothing to the
 * start-up bundle. Its changes reach the scoreboard as
 * `display-settings-live` events and, after it saves on close,
 * `display-settings-saved` (`lib/displaySettingsLive.ts`).
 *
 * Room context is resolved here rather than read from `RoomContext` on
 * purpose: this component sits ABOVE the route table, so no room provider is
 * in scope. `getPortal` is the shared slug→room cache, so on a room page the
 * lookup is almost always already settled.
 */

interface RoomData {
  slug: string;
  roomId: string;
  name: string;
  config: Record<string, string>;
}

type PanelModule = { default: ComponentType<DisplaySettingsPanelProps> };

const panelPart = lazyPart<PanelModule>('display-settings', () => import('./displaySettings/DisplaySettingsPanel'));

export default function DisplaySettingsHost() {
  const { pathname } = useLocation();
  const slug = getRoomSlugForPath(pathname);
  const [open, setOpen] = useState(false);
  const [playerToken, setPlayerToken] = useState<string | null>(null);
  // Stored WITH the slug it belongs to, so leaving the room derives its way
  // back to empty defaults instead of needing a clearing setState in an
  // effect body (which would also flash room A's defaults inside room B).
  const [roomData, setRoomData] = useState<RoomData | null>(null);
  const [mod, setMod] = useState<PanelModule | null>(() => panelPart.loaded());
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const handler = () => {
      // Read the token at open time, not at mount: this component outlives
      // every login/logout in the session.
      let token: string | null = null;
      try { token = localStorage.getItem(PLAYER_TOKEN_KEY); } catch { /* private mode */ }
      setPlayerToken(token);
      setLoadFailed(false);
      setOpen(true);
    };
    window.addEventListener('open-scoreboard-prefs', handler);
    return () => window.removeEventListener('open-scoreboard-prefs', handler);
  }, []);

  // A signed-in viewer may open it from any page: fetch the panel when idle.
  useEffect(() => {
    let signedIn = false;
    try { signedIn = !!localStorage.getItem(PLAYER_TOKEN_KEY); } catch { /* private mode */ }
    if (signedIn) panelPart.prefetch();
  }, []);

  // Opened before the chunk is in: ask for it now (again after a failure).
  useEffect(() => {
    if (!open || mod) return;
    let live = true;
    panelPart.load().then(
      m => { if (live) setMod(m); },
      () => { if (live) setLoadFailed(true); },
    );
    return () => { live = false; };
  }, [open, mod, loadFailed]);

  // Room defaults are only needed while the panel is open on a room page —
  // fetching them on every navigation would add a request to pages that may
  // never open it at all.
  useEffect(() => {
    if (!open || !slug) return;
    let cancelled = false;
    (async () => {
      let portal: Awaited<ReturnType<typeof getPortal>> | null = null;
      try {
        portal = await getPortal(slug);
      } catch { /* the panel shows the colours; the card settings wait for the room */ }
      if (cancelled || !portal?.roomId) return;
      let cfg: Record<string, string> = {};
      try {
        const res = await fetch(`/api/rooms/${portal.roomId}/scoreboard-config`);
        cfg = res.ok ? ((await res.json()) || {}) : {};
      } catch { /* the code's own defaults stand in for the room's */ }
      if (!cancelled) setRoomData({ slug, roomId: portal.roomId, name: portal.name, config: cfg });
    })();
    return () => { cancelled = true; };
  }, [open, slug]);

  // No player token is guest mode (G34c): the panel keeps the card settings in
  // this browser instead of the account.
  if (!open) return null;

  const close = () => setOpen(false);

  if (!mod) {
    if (!loadFailed) return null;
    return (
      <Dialog
        open
        onOpenChange={next => { if (!next) close(); }}
        panel
        label="Display"
        title="Display settings"
        description="Couldn't open them. Check the connection and try again."
        footer={<Button variant="secondary" onClick={() => setLoadFailed(false)}>Try again</Button>}
      />
    );
  }

  const Panel = mod.default;
  const forThisRoom = slug && roomData?.slug === slug ? roomData : null;
  return (
    <Panel
      onClose={close}
      playerToken={playerToken}
      slug={slug}
      roomId={forThisRoom?.roomId}
      roomName={forThisRoom?.name}
      roomConfig={slug ? (forThisRoom?.config ?? null) : null}
    />
  );
}
