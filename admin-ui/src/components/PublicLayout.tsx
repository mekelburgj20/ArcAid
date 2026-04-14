import { useEffect, useState } from 'react';
import { Link, Outlet, useParams, useLocation } from 'react-router-dom';
import { Users, Monitor, Gamepad2, BarChart3, LogOut, Joystick, Trophy, Settings, Settings2 } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

interface PublicLayoutProps {
  gameRoomName?: string;
}

export default function PublicLayout({ gameRoomName }: PublicLayoutProps) {
  const { slug } = useParams<{ slug: string }>();
  const location = useLocation();
  const [roomName, setRoomName] = useState(gameRoomName || 'ARCAID');
  const { discordUser, loginWithDiscord, logoutPlayer } = useViewerAuth();

  // Show prefs gear only on scoreboard page (/:slug with no extra segments)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const isScoreboard = pathParts.length === 1 && !!slug;

  useEffect(() => {
    if (gameRoomName) { setRoomName(gameRoomName); return; }
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ slug: string; name: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (found) setRoomName(found.name);
      })
      .catch(() => {});
  }, [slug, gameRoomName]);

  const hasAdminToken = !!localStorage.getItem('arcaid_token');

  const navItems = [
    { path: `/${slug}`, label: 'Scoreboard', icon: <Monitor size={16} />, end: true },
    { path: `/${slug}/games`, label: 'Game Picks', icon: <Gamepad2 size={16} /> },
    { path: `/${slug}/freeplay`, label: 'Freeplay', icon: <Joystick size={16} /> },
    { path: `/${slug}/players`, label: 'Players', icon: <Users size={16} /> },
    { path: `/${slug}/stats`, label: 'Stats', icon: <BarChart3 size={16} /> },
    { path: '/scoreboard', label: 'Global', icon: <Trophy size={16} /> },
  ];

  return (
    <div className="h-[100dvh] bg-deep text-primary relative flex flex-col overflow-hidden">
      {/* Public Nav Bar */}
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm z-20 flex-shrink-0">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <Link to={`/${slug}`} className="no-underline flex items-center gap-2 sm:gap-3 min-w-0">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-7 h-7 sm:w-8 sm:h-8 flex-shrink-0" />
            <span className="font-pixel text-neon-cyan text-[10px] sm:text-xs tracking-wider truncate">{roomName}</span>
          </Link>
          <div className="flex items-center gap-0.5 sm:gap-1 flex-shrink-0">
            {navItems.map(item => (
              <Link
                key={item.path}
                to={item.path}
                className="flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-2 text-xs sm:text-sm text-muted hover:text-neon-cyan rounded transition-colors no-underline"
              >
                {item.icon}
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            ))}

            {/* Admin link (visible only when admin token exists) */}
            {hasAdminToken && (
              <Link
                to={`/${slug}/admin`}
                className="flex items-center gap-1.5 px-2 sm:px-3 py-2 text-xs sm:text-sm text-muted hover:text-neon-amber rounded transition-colors no-underline"
                title="Room Admin"
              >
                <Settings size={16} />
                <span className="hidden lg:inline">Admin</span>
              </Link>
            )}

            {/* Discord login / user avatar */}
            {discordUser ? (
              <div className="flex items-center gap-1.5 ml-1 sm:ml-2">
                {discordUser.avatar ? (
                  <img
                    src={discordUser.avatar}
                    alt={discordUser.username}
                    className="w-6 h-6 rounded-full border border-border"
                  />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-neon-cyan/20 border border-border flex items-center justify-center text-[10px] font-bold text-neon-cyan">
                    {discordUser.username.charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="hidden lg:inline text-xs text-muted truncate max-w-[80px]">{discordUser.username}</span>
                {isScoreboard && (
                  <button
                    onClick={() => window.dispatchEvent(new Event('open-scoreboard-prefs'))}
                    className="p-1 text-muted hover:text-neon-cyan transition-colors cursor-pointer"
                    title="Display preferences"
                  >
                    <Settings2 size={14} />
                  </button>
                )}
                <button
                  onClick={logoutPlayer}
                  className="p-1 text-muted hover:text-neon-magenta transition-colors cursor-pointer"
                  title="Log out"
                >
                  <LogOut size={14} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => slug && loginWithDiscord(slug)}
                className="flex items-center gap-1.5 ml-1 sm:ml-2 px-2 sm:px-3 py-1.5 rounded border border-[#5865F2]/40 bg-[#5865F2]/10 text-[#5865F2] text-xs font-medium hover:bg-[#5865F2]/20 hover:border-[#5865F2]/60 transition-colors cursor-pointer"
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
        <Outlet />
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
