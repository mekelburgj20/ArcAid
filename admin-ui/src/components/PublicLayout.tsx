import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useParams, useLocation } from 'react-router-dom';
import { Monitor, Gamepad2, BarChart3, Trophy, MessageSquare } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { useMyRooms } from '../hooks/useMyRooms';
import { useToast } from './Toast';
import { getPortal, type Portal } from '../lib/portal';
import { RoomContext } from '../contexts/RoomContext';
import UserMenu from './UserMenu';
import LoginButtons from './LoginButtons';
import PendingSubmissionWatcher from './PendingSubmissionWatcher';
import ScoreboardTicker from './ScoreboardTicker';
import LoadingState from './LoadingState';
import { PlayerQuickViewProvider } from '../contexts/PlayerQuickViewContext';

interface PublicLayoutProps {
  gameRoomName?: string;
}

export default function PublicLayout({ gameRoomName }: PublicLayoutProps) {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const [portal, setPortal] = useState<Portal | null>(null);
  const [portalError, setPortalError] = useState(false);
  const { discordUser, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
  const { loading: pickAwardLoading, enabled: pickAwardEnabled } = usePickAwardEnabled(slug);
  // D2 (v2.38.0) — room-page join/leave affordance, surfaced as a UserMenu
  // contextual item (chosen over a header button: s20/s21 already made mobile
  // header space tight, and the menu item needs no extra layout work here).
  const { isMember: isRoomMember, join: joinRoom, leave: leaveRoom } = useMyRooms();
  const { toast } = useToast();

  const [lobbyHasNew, setLobbyHasNew] = useState(false);

  // Show prefs gear only on scoreboard page (/:slug with no extra segments)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const isScoreboard = pathParts.length === 1 && !!slug;
  const isLobbyPage = pathParts.length === 2 && pathParts[1] === 'lobby';

  // Single portal fetch for the whole public subtree — getPortal() dedupes
  // concurrent resolvers of the same slug, so this is the only network call
  // no matter how many other consumers (nav's usePickAwardEnabled, child
  // pages) resolve the same slug on the same mount.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    // Reset so the loading gate re-engages on cross-room slug changes — children
    // must never render under a stale room's context with the new slug's URL.
    setPortal(null);
    setPortalError(false);
    getPortal(slug)
      .then(p => { if (!cancelled) setPortal(p); })
      .catch(() => { if (!cancelled) setPortalError(true); });
    return () => { cancelled = true; };
  }, [slug]);

  const roomName = portal?.name ?? gameRoomName ?? 'ARCAID';
  const resolvedRoomId = portal?.roomId ?? null;
  // Stable identity across re-renders (lobby-dot/discordUser/pickAward state
  // changes) so RoomContext consumers don't re-render on every parent update.
  const roomCtx = useMemo(
    () => ({ roomId: resolvedRoomId ?? '', roomSlug: slug || '', roomName }),
    [resolvedRoomId, slug, roomName],
  );

  // Lobby activity indicator — depends on resolvedRoomId rather than fetching
  // its own portal; guard until it's set.
  useEffect(() => {
    if (!slug) return;
    // When on lobby page, mark as seen
    if (isLobbyPage) {
      localStorage.setItem(`lobby_last_seen_${slug}`, new Date().toISOString());
      setLobbyHasNew(false);
      return;
    }
    // Otherwise, check if there are newer events
    if (!resolvedRoomId) return;
    fetch(`/api/rooms/${resolvedRoomId}/lobby/feed?limit=1`)
      .then(r => r.ok ? r.json() : null)
      .then(events => {
        if (!events?.length) return;
        const lastSeen = localStorage.getItem(`lobby_last_seen_${slug}`);
        if (!lastSeen || new Date(events[0].created_at) > new Date(lastSeen)) {
          setLobbyHasNew(true);
        }
      })
      .catch(() => {});
  }, [resolvedRoomId, location.pathname]);

  const hasAdminToken = !!localStorage.getItem('arcaid_token');

  const handleJoinRoom = async () => {
    if (!resolvedRoomId) return;
    const ok = await joinRoom(resolvedRoomId, { name: roomName, slug, logoUrl: portal?.logo_url ?? null });
    toast(ok ? `Added ${roomName} to My Game Rooms.` : 'Could not join this room — try again.', ok ? 'success' : 'error');
  };

  const handleLeaveRoom = async () => {
    if (!resolvedRoomId) return;
    const ok = await leaveRoom(resolvedRoomId);
    toast(ok ? `Left ${roomName}.` : 'Could not leave this room — try again.', ok ? 'info' : 'error');
  };

  // Sprint 7 nav: Lobby | Scores | Picks* | Stats | Global
  // Picks is suppressed when ENABLE_GAME_PICK_AWARD is off. Keep it hidden
  // during the initial fetch to avoid a flash of mismatched nav.
  const navItems: Array<{ path: string; label: string; icon: React.ReactNode; end?: boolean }> = [
    { path: `/${slug}/lobby`, label: 'Lobby', icon: <MessageSquare size={16} /> },
    { path: `/${slug}`, label: 'Scores', icon: <Monitor size={16} />, end: true },
  ];
  if (!pickAwardLoading && pickAwardEnabled) {
    navItems.push({ path: `/${slug}/picks`, label: 'Picks', icon: <Gamepad2 size={16} /> });
  }
  navItems.push({ path: `/${slug}/stats`, label: 'Stats', icon: <BarChart3 size={16} /> });
  navItems.push({ path: '/scoreboard', label: 'Global', icon: <Trophy size={16} /> });

  return (
    <div className="h-[100dvh] bg-deep text-primary relative flex flex-col overflow-hidden">
      {/* Sprint 10 — resumes an anonymous submission draft after Discord OAuth. */}
      <PendingSubmissionWatcher roomSlug={slug} />
      {/* Public Nav Bar */}
      <nav aria-label="Room navigation" className="border-b border-border bg-surface/80 backdrop-blur-sm z-40 flex-shrink-0">
        {/* s20: top-of-screen bar under viewport-fit=cover — paddingTop grows
            for the status-bar/notch safe area without shrinking below the
            existing py-3 baseline on non-notched devices. */}
        <div
          className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link to="/" className="no-underline flex-shrink-0" aria-label="All game rooms" title="All game rooms">
              <img src="/arcaid-logo.png" alt="ArcAid" className="w-7 h-7 sm:w-8 sm:h-8 flex-shrink-0" />
            </Link>
            <Link to={`/${slug}`} className="no-underline min-w-0">
              <span className="font-pixel text-neon-cyan text-[10px] sm:text-xs tracking-wider truncate block">{roomName}</span>
            </Link>
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
            {navItems.map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.end}
                aria-label={item.label}
                className={({ isActive }) =>
                  `flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-2 min-h-11 min-w-11 px-1.5 sm:px-3 py-1 sm:py-2 rounded transition-colors no-underline ${
                    isActive ? 'text-neon-cyan bg-neon-cyan/10' : 'text-muted hover:text-neon-cyan'
                  }`
                }
              >
                {item.label === 'Lobby' && lobbyHasNew ? (
                  <span className="relative">
                    {item.icon}
                    <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-neon-cyan rounded-full" />
                  </span>
                ) : item.icon}
                {/* s20: label now always visible — small stacked caption on mobile
                    (was icon-only, unlabeled for screen readers relying on visible
                    text), inline row label unchanged on sm+. */}
                <span className="text-[10px] sm:text-sm leading-none">{item.label}</span>
              </NavLink>
            ))}

            {/* Discord login / user menu */}
            {discordUser ? (
              <UserMenu
                user={discordUser}
                slug={slug}
                showScoreboardPrefs={isScoreboard}
                hasAdminToken={hasAdminToken}
                onLogout={logoutPlayer}
                roomMembership={resolvedRoomId ? {
                  roomName,
                  isMember: isRoomMember(resolvedRoomId),
                  onJoin: handleJoinRoom,
                  onLeave: handleLeaveRoom,
                } : undefined}
              />
            ) : (
              <LoginButtons
                onDiscordLogin={() => slug && loginWithDiscord(slug, location.pathname + location.search)}
                onGoogleLogin={() => slug && loginWithGoogle(slug, location.pathname + location.search)}
                label="Login"
                className="ml-1 sm:ml-2"
                buttonClassName="min-h-11 sm:min-h-0"
                nudgeTitle={portal?.discord_enabled !== false ? 'Sign in with Discord to get DM notifications and tournament picks.' : undefined}
              />
            )}
          </div>
        </div>
      </nav>

      {/* Page Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {portalError ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2 text-center px-4">
            <p className="font-pixel text-neon-magenta text-lg mb-1">Room not found</p>
            <p className="text-muted text-sm">We couldn't find a room at this address.</p>
          </div>
        ) : !portal || !resolvedRoomId ? (
          <LoadingState message="Loading room..." />
        ) : (
          /* v2.13.16 — PlayerQuickViewProvider so PlayerNameLink calls from
              any public page can open the player preview modal.
              S18 — RoomContext is provided here (outside PlayerQuickViewProvider)
              so every page under the Outlet gets slug→room resolution for free. */
          <RoomContext.Provider value={roomCtx}>
            <PlayerQuickViewProvider>
              <Outlet />
            </PlayerQuickViewProvider>
          </RoomContext.Provider>
        )}
      </div>

      {/* s21 — lobby feed ticker, scoreboard page only. In-flow above the
          footer (was fixed-bottom inside Scoreboard.tsx, painting over the
          Privacy/Terms links). Renders null while the feed is empty. */}
      {isScoreboard && resolvedRoomId && !portalError && (
        <ScoreboardTicker roomId={resolvedRoomId} />
      )}

      {/* Slim legal footer — flex-shrink-0 so it sits below the scroll region.
          s21: owns the safe-area bottom inset under viewport-fit=cover (was on
          the fixed ticker). */}
      <footer
        className="flex-shrink-0 border-t border-border py-1.5 px-4 flex items-center justify-center gap-3 text-[10px] text-faint z-40"
        style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
      >
        <Link to="/privacy" className="hover:text-neon-cyan transition-colors no-underline">Privacy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/terms" className="hover:text-neon-cyan transition-colors no-underline">Terms</Link>
      </footer>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
