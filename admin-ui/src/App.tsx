import { useEffect, useState } from 'react';
import { Routes, Route, Link, useLocation, Navigate } from 'react-router-dom';
import { Home, Settings as SettingsIcon, Trophy, Activity, Library, LogOut, Clock, HardDrive, BarChart3, Medal, Menu, X } from 'lucide-react';
import { api, isAuthenticated, setToken } from './lib/api';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import SetupWizard from './pages/SetupWizard';
import Logs from './pages/Logs';
import Tournaments from './pages/Tournaments';
import GameLibrary from './pages/GameLibrary';
import History from './pages/History';
import Backups from './pages/Backups';
import Leaderboard from './pages/Leaderboard';
import Stats from './pages/Stats';
import Scoreboard from './pages/Scoreboard';
import Players from './pages/Players';
import PlayerDetail from './pages/PlayerDetail';
import GameDetail from './pages/GameDetail';
import PublicLayout from './components/PublicLayout';

/** Redirect old public routes to slug-based paths */
function LegacyRedirect({ slug }: { slug: string | null }) {
  const location = useLocation();
  if (!slug) return <div className="min-h-screen bg-deep flex items-center justify-center text-muted">Portal not configured.</div>;

  // Map old paths to new slug-based paths
  const oldPath = location.pathname;
  let newPath = `/${slug}`;
  if (oldPath === '/players') newPath = `/${slug}/players`;
  else if (oldPath.startsWith('/players/')) newPath = `/${slug}${oldPath}`;
  else if (oldPath.startsWith('/games/')) newPath = `/${slug}${oldPath}`;
  // /scoreboard → /:slug

  return <Navigate to={newPath} replace />;
}

function App() {
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState(isAuthenticated());
  const [portalSlug, setPortalSlug] = useState<string | null | undefined>(undefined); // undefined = loading
  const [portalName, setPortalName] = useState<string>('ARCAID');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Known admin paths (never treated as a slug)
  const adminPaths = ['/', '/login', '/settings', '/tournaments', '/library', '/leaderboard', '/stats', '/history', '/logs', '/backups'];
  const isAdminRoute = adminPaths.includes(location.pathname);
  const isLegacyPublicRoute = location.pathname === '/scoreboard'
    || location.pathname === '/players'
    || location.pathname.startsWith('/players/')
    || location.pathname.startsWith('/games/');

  // Load portal info once
  useEffect(() => {
    fetch('/api/portal')
      .then(r => r.json())
      .then((data: { slug: string | null; name: string | null }) => {
        setPortalSlug(data.slug);
        if (data.name) setPortalName(data.name);
      })
      .catch(() => setPortalSlug(null));
  }, []);

  // Update document title based on context
  useEffect(() => {
    document.title = isAdminRoute ? 'ArcAid Admin' : portalName || 'ArcAid';
  }, [isAdminRoute, portalName, location.pathname]);

  // Check setup status for admin routes
  useEffect(() => {
    if (!isAdminRoute && !isLegacyPublicRoute) return;
    if (isLegacyPublicRoute) return;
    api.get<{ needsSetup: boolean }>('/status')
      .then(data => setNeedsSetup(data.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, [isAdminRoute]);

  // Legacy public route redirects
  if (isLegacyPublicRoute) {
    if (portalSlug === undefined) {
      return (
        <div className="min-h-screen bg-deep flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      );
    }
    return <LegacyRedirect slug={portalSlug} />;
  }

  // Determine if this is a slug-based public route
  // Any path that isn't admin and starts with /<something> could be a slug route
  const pathParts = location.pathname.split('/').filter(Boolean);
  const possibleSlug = pathParts[0];
  const isPublicRoute = !isAdminRoute && !!possibleSlug && possibleSlug !== 'login' && !location.pathname.startsWith('/api');

  // Public portal pages
  if (isPublicRoute) {
    if (portalSlug === undefined) {
      return (
        <div className="min-h-screen bg-deep flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
        </div>
      );
    }

    // If slug doesn't match, show 404
    if (possibleSlug !== portalSlug) {
      return (
        <div className="min-h-screen bg-deep flex items-center justify-center text-muted">
          <div className="text-center">
            <p className="font-pixel text-neon-cyan text-lg mb-2">404</p>
            <p>Game room not found.</p>
          </div>
        </div>
      );
    }

    return (
      <Routes>
        <Route path="/:slug" element={<PublicLayout gameRoomName={portalName} />}>
          <Route index element={<Scoreboard />} />
          <Route path="players" element={<Players />} />
          <Route path="players/:id" element={<PlayerDetail />} />
          <Route path="games/:name" element={<GameDetail />} />
        </Route>
      </Routes>
    );
  }

  // --- Admin routes below ---

  if (needsSetup === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (needsSetup) {
    return (
      <ToastProvider>
        <SetupWizard onComplete={() => setNeedsSetup(false)} />
      </ToastProvider>
    );
  }

  if (!authed) {
    return (
      <ToastProvider>
        <Login onLogin={() => setAuthed(true)} />
      </ToastProvider>
    );
  }

  const handleLogout = () => {
    setToken(null);
    setAuthed(false);
  };

  const navItems = [
    { path: '/', label: 'Dashboard', icon: <Home size={18} /> },
    { path: '/tournaments', label: 'Tournaments', icon: <Trophy size={18} /> },
    { path: '/library', label: 'Game Library', icon: <Library size={18} /> },
    { path: '/leaderboard', label: 'Leaderboard', icon: <Medal size={18} /> },
    { path: '/stats', label: 'Stats', icon: <BarChart3 size={18} /> },
    { path: '/history', label: 'History', icon: <Clock size={18} /> },
    { path: '/logs', label: 'Activity Logs', icon: <Activity size={18} /> },
    { path: '/backups', label: 'Backups', icon: <HardDrive size={18} /> },
    { path: '/settings', label: 'Settings', icon: <SettingsIcon size={18} /> },
  ];

  return (
    <ToastProvider>
      <div className="flex min-h-screen scanlines">
        {/* Mobile top bar */}
        <div className="fixed top-0 left-0 right-0 z-30 bg-surface border-b border-border flex items-center gap-3 px-4 py-3 md:hidden">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-0">
            {sidebarOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
          <img src="/arcaid-logo.png" alt="ArcAid" className="w-7 h-7" />
          <span className="font-pixel text-neon-cyan text-xs">ARCAID</span>
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
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-10 h-10" />
            <div>
              <h2 className="font-pixel text-neon-cyan text-xs">ARCAID</h2>
              <span className="text-faint text-xs">Admin Console</span>
            </div>
          </div>
          <nav className="flex-1 py-2 flex flex-col gap-0.5 overflow-y-auto">
            {navItems.map(item => {
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
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
          <button
            onClick={handleLogout}
            className="flex items-center gap-3 px-5 py-3 text-sm text-muted hover:text-neon-magenta border-t border-border transition-colors cursor-pointer bg-transparent border-l-0 border-r-0 border-b-0"
          >
            <LogOut size={18} />
            <span>Logout</span>
          </button>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 md:ml-60 p-4 md:p-6 pt-16 md:pt-6">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/tournaments" element={<Tournaments />} />
            <Route path="/library" element={<GameLibrary />} />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/history" element={<History />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/backups" element={<Backups />} />
          </Routes>
        </main>
      </div>
    </ToastProvider>
  );
}

export default App;
