import { useEffect, useState } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { Home, Settings as SettingsIcon, Trophy, Activity, Library, LogOut, Clock, HardDrive, BarChart3, Medal } from 'lucide-react';
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

function App() {
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [authed, setAuthed] = useState(isAuthenticated());
  const isPublicRoute = location.pathname === '/scoreboard'
    || location.pathname === '/players'
    || location.pathname.startsWith('/players/')
    || location.pathname.startsWith('/games/');

  useEffect(() => {
    if (isPublicRoute) return;
    api.get<{ needsSetup: boolean }>('/status')
      .then(data => setNeedsSetup(data.needsSetup))
      .catch(() => setNeedsSetup(false));
  }, [isPublicRoute]);

  // Public pages — no auth required
  if (isPublicRoute) {
    return (
      <Routes>
        <Route path="/scoreboard" element={<Scoreboard />} />
        <Route path="/players" element={<Players />} />
        <Route path="/players/:id" element={<PlayerDetail />} />
        <Route path="/games/:name" element={<GameDetail />} />
      </Routes>
    );
  }

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
        {/* Sidebar */}
        <aside className="w-60 bg-surface border-r border-border flex flex-col fixed h-screen">
          <div className="p-5 border-b border-border">
            <h2 className="font-pixel text-neon-cyan text-xs">ARCAID</h2>
            <span className="text-faint text-xs">Admin Console</span>
          </div>
          <nav className="flex-1 py-2 flex flex-col gap-0.5">
            {navItems.map(item => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
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
        <main className="flex-1 ml-60 p-6">
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
