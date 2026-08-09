import { useEffect, useState } from 'react';
import { Link, Outlet, useParams, useLocation, useNavigate } from 'react-router-dom';
import { Home, Settings as SettingsIcon, Trophy, Library, LogOut, Clock, BarChart3, Medal, Menu, X, Crown, HelpCircle, Activity, Wrench, Palette, MessageSquare, Users, UserCheck, UsersRound, ArrowLeft } from 'lucide-react';
import { api, isAuthenticated, setToken } from '../lib/api';
import { getPortal } from '../lib/portal';
import { RoomContext } from '../contexts/RoomContext';
import LoadingState from './LoadingState';
import UpdateNudgeBanner from './UpdateNudgeBanner';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
  /** v2.39.0 (approval rooms) — 'open' (default) | 'approval'. */
  join_policy?: 'open' | 'approval';
}

export default function RoomAdminLayout() {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [room, setRoom] = useState<Room | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ username: string; avatar: string | null } | null>(null);
  // v2.39.0 — Join Requests nav badge (approval rooms only). Same 60s-poll
  // pattern as SuperAdminLayout's Catalogue Approvals badge.
  const [pendingJoinRequests, setPendingJoinRequests] = useState<number>(0);

  useEffect(() => {
    if (!slug) return;
    // Resolve via the portal (slug→room) endpoint, NOT the public `/rooms`
    // list. The public list is `is_public = 1` only, so resolving the admin
    // shell from it made a non-public room's OWN admin get "Game room not
    // found" (v2.39.0 approval/private rooms made non-public rooms common).
    // Portal resolves any room regardless of is_public — the same resolver
    // PublicLayout already uses — and the real admin data stays gated
    // server-side by requireRoomAccess on every endpoint.
    getPortal(slug)
      .then(p => {
        setRoom({
          id: p.roomId,
          slug: p.slug,
          name: p.name,
          description: p.description ?? '',
          is_public: p.is_public ?? true,
          join_policy: p.join_policy ?? 'open',
        });
      })
      .catch(() => setError('Game room not found'))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    if (!room || room.join_policy !== 'approval') return;
    const fetchPending = () => {
      api.get<{ pending: number }>(`/rooms/${room.id}/admin/join-requests/count`)
        .then(r => setPendingJoinRequests(r.pending || 0))
        .catch(() => { /* nav badge is best-effort */ });
    };
    fetchPending();
    const interval = setInterval(fetchPending, 60_000);
    return () => clearInterval(interval);
  }, [room]);

  useEffect(() => {
    if (!isAuthenticated()) return;
    api.get<{ username: string; avatar: string | null }>('/auth/me')
      .then(data => setCurrentUser({ username: data.username, avatar: data.avatar }))
      .catch(() => setCurrentUser(null));
  }, []);

  if (!isAuthenticated()) {
    navigate(`/${slug}/login`, { replace: true });
    return null;
  }

  if (loading) return <LoadingState message="Loading game room..." />;

  if (error || !room) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center text-muted">
        <div className="text-center">
          <p className="font-pixel text-neon-magenta text-lg mb-2">Error</p>
          <p>{error || 'Game room not found'}</p>
        </div>
      </div>
    );
  }

  const handleLogout = () => {
    setToken(null);
    navigate(`/${slug}/login`, { replace: true });
  };

  const basePath = `/${slug}/admin`;
  const navItems: Array<{ path: string; label: string; icon: React.ReactNode; badge?: number } | 'separator'> = [
    // v2.87.0 — room-admin nav escape: the only way out of `/:slug/admin/*`
    // was editing the URL by hand. This jumps to the public room.
    { path: `/${slug}`, label: 'View Public Room', icon: <ArrowLeft size={18} /> },
    'separator',
    { path: `${basePath}/dashboard`, label: 'Dashboard', icon: <Home size={18} /> },
    'separator',
    { path: `${basePath}/tournaments`, label: 'Tournaments', icon: <Trophy size={18} /> },
    { path: `${basePath}/library`, label: 'Game Library', icon: <Library size={18} /> },
    { path: `${basePath}/games`, label: 'Game States', icon: <Wrench size={18} /> },
    'separator',
    { path: `${basePath}/leaderboard`, label: 'Leaderboard', icon: <Medal size={18} /> },
    { path: `${basePath}/rankings`, label: 'Rankings', icon: <Crown size={18} /> },
    { path: `${basePath}/stats`, label: 'Stats', icon: <BarChart3 size={18} /> },
    { path: `${basePath}/history`, label: 'History', icon: <Clock size={18} /> },
    'separator',
    { path: `${basePath}/lobby`, label: 'Lobby', icon: <MessageSquare size={18} /> },
    { path: `${basePath}/styles`, label: 'Style Catalogue', icon: <Palette size={18} /> },
    { path: `${basePath}/settings`, label: 'Room Settings', icon: <SettingsIcon size={18} /> },
    'separator',
    { path: `${basePath}/identity`, label: 'Identity', icon: <Users size={18} /> },
    // v2.49.1 — room-admin Members page (roster + ban management, moved off
    // the public /:slug/members page).
    { path: `${basePath}/members`, label: 'Members', icon: <UsersRound size={18} /> },
    // v2.39.0 — only shown for approval-policy rooms; badge = pending count.
    ...(room.join_policy === 'approval'
      ? [{ path: `${basePath}/join-requests`, label: 'Join Requests', icon: <UserCheck size={18} />, badge: pendingJoinRequests }]
      : []),
    { path: `${basePath}/activity`, label: 'Activity', icon: <Activity size={18} /> },
    { path: `${basePath}/help`, label: 'Help', icon: <HelpCircle size={18} /> },
  ];

  return (
    <RoomContext.Provider value={{ roomId: room.id, roomSlug: room.slug, roomName: room.name }}>
      <div className="flex min-h-screen scanlines">
        {/* Stale-PWA "new version available" nudge — fixed position. */}
        <UpdateNudgeBanner />
        {/* Mobile top bar */}
        <div className="fixed top-0 left-0 right-0 z-30 bg-surface border-b border-border flex items-center gap-3 px-4 py-3 md:hidden">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-0">
            {sidebarOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-7 h-7" />
          <span className="font-pixel text-neon-cyan text-xs truncate">{room.name}</span>
        </div>

        {/* Sidebar overlay (mobile) */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black/50 z-30 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={`
          w-60 bg-surface border-r border-border flex flex-col fixed h-screen z-40
          transition-transform duration-200 ease-in-out
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
          md:translate-x-0
        `}>
          <div className="p-5 border-b border-border flex items-center gap-3">
            <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-10 h-10" />
            <div className="min-w-0">
              <h2 className="font-pixel text-neon-cyan text-xs truncate">{room.name}</h2>
              <span className="text-faint text-xs">Room Admin</span>
            </div>
          </div>
          <nav className="flex-1 py-2 flex flex-col gap-0.5 overflow-y-auto">
            {navItems.map((item, i) => {
              if (item === 'separator') {
                return <div key={`sep-${i}`} className="border-t border-border/50 my-1 mx-4" />;
              }
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  onClick={() => setSidebarOpen(false)}
                  className={`
                    flex items-center gap-3 px-5 py-3 text-sm font-medium transition-all no-underline
                    ${isActive
                      ? 'text-neon-cyan bg-neon-cyan/10 border-r-2 border-neon-cyan'
                      : 'text-muted hover:text-primary hover:bg-raised/50'
                    }
                  `}
                >
                  {item.icon}
                  <span className="flex-1">{item.label}</span>
                  {item.badge !== undefined && item.badge > 0 && (
                    <span className="text-[10px] font-display font-bold px-1.5 py-0.5 rounded-full bg-neon-amber/20 text-neon-amber border border-neon-amber/40">
                      {item.badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="border-t border-border">
            {currentUser && (
              <div className="flex items-center gap-3 px-5 py-3">
                {currentUser.avatar ? (
                  <img src={currentUser.avatar} alt="" className="w-6 h-6 rounded-full" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-raised flex items-center justify-center text-xs text-faint">
                    {currentUser.username.charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="text-xs text-muted truncate flex-1">{currentUser.username}</span>
              </div>
            )}
            <button
              onClick={handleLogout}
              className="flex items-center gap-3 px-5 py-3 text-sm text-muted hover:text-neon-magenta transition-colors cursor-pointer bg-transparent border-0 w-full text-left"
            >
              <LogOut size={18} />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 md:ml-60 p-4 md:p-6 pt-16 md:pt-6">
          <Outlet />
        </main>
      </div>
    </RoomContext.Provider>
  );
}
