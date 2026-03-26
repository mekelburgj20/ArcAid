import { useEffect, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { Users, Monitor, Gamepad2, BarChart3 } from 'lucide-react';

interface PublicLayoutProps {
  gameRoomName?: string;
}

export default function PublicLayout({ gameRoomName }: PublicLayoutProps) {
  const { slug } = useParams<{ slug: string }>();
  const [roomName, setRoomName] = useState(gameRoomName || 'ARCAID');

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

  const navItems = [
    { path: `/${slug}`, label: 'Scoreboard', icon: <Monitor size={16} />, end: true },
    { path: `/${slug}/games`, label: 'Games', icon: <Gamepad2 size={16} /> },
    { path: `/${slug}/players`, label: 'Players', icon: <Users size={16} /> },
    { path: `/${slug}/stats`, label: 'Stats', icon: <BarChart3 size={16} /> },
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
