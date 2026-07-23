import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useParams, useLocation } from 'react-router-dom';
import { Monitor, Gamepad2, BarChart3, Trophy, MessageSquare } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { usePickAwardEnabled } from '../hooks/usePickAwardEnabled';
import { getPortal, type Portal } from '../lib/portal';
import { RoomContext } from '../contexts/RoomContext';
import UserMenu from './UserMenu';
import PendingSubmissionWatcher from './PendingSubmissionWatcher';
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
  const { discordUser, loginWithDiscord, logoutPlayer } = useViewerAuth();
  const { loading: pickAwardLoading, enabled: pickAwardEnabled } = usePickAwardEnabled(slug);

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
          <Link to={`/${slug}`} className="no-underline flex items-center gap-2 sm:gap-3 min-w-0">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-7 h-7 sm:w-8 sm:h-8 flex-shrink-0" />
            <span className="font-pixel text-neon-cyan text-[10px] sm:text-xs tracking-wider truncate">{roomName}</span>
          </Link>
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
              />
            ) : (
              <button
                onClick={() => slug && loginWithDiscord(slug, location.pathname + location.search)}
                className="flex items-center justify-center gap-1.5 ml-1 sm:ml-2 px-2 sm:px-3 py-1.5 min-h-11 sm:min-h-0 rounded border border-[#5865F2]/40 bg-[#5865F2]/10 text-[#5865F2] text-xs font-medium hover:bg-[#5865F2]/20 hover:border-[#5865F2]/60 transition-colors cursor-pointer"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z" />
                </svg>
                <span className="hidden sm:inline">Login</span>
              </button>
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

      {/* Slim legal footer — flex-shrink-0 so it sits below the scroll region */}
      <footer className="flex-shrink-0 border-t border-border py-1.5 px-4 flex items-center justify-center gap-3 text-[10px] text-faint z-40">
        <Link to="/privacy" className="hover:text-neon-cyan transition-colors no-underline">Privacy</Link>
        <span aria-hidden="true">·</span>
        <Link to="/terms" className="hover:text-neon-cyan transition-colors no-underline">Terms</Link>
      </footer>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
