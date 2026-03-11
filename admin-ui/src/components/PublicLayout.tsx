import { Link, Outlet, useParams } from 'react-router-dom';
import { Users, Monitor } from 'lucide-react';

interface PublicLayoutProps {
  gameRoomName: string;
}

export default function PublicLayout({ gameRoomName }: PublicLayoutProps) {
  const { slug } = useParams<{ slug: string }>();

  const navItems = [
    { path: `/${slug}`, label: 'Scoreboard', icon: <Monitor size={16} />, end: true },
    { path: `/${slug}/players`, label: 'Players', icon: <Users size={16} /> },
  ];

  return (
    <div className="min-h-screen bg-deep text-primary relative">
      {/* Public Nav Bar */}
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm sticky top-0 z-20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <Link to={`/${slug}`} className="no-underline flex items-center gap-2 sm:gap-3 min-w-0">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-7 h-7 sm:w-8 sm:h-8 flex-shrink-0" />
            <span className="font-pixel text-neon-cyan text-[10px] sm:text-xs tracking-wider truncate">{gameRoomName}</span>
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
      <Outlet />

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
