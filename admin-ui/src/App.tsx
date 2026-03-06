import { useEffect, useState } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { Home, Settings as SettingsIcon, Trophy, Activity, Library } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import SetupWizard from './pages/SetupWizard';
import Logs from './pages/Logs';
import Tournaments from './pages/Tournaments';
import GameLibrary from './pages/GameLibrary';
import './App.css';

function App() {
  const location = useLocation();
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('http://localhost:3001/api/status')
      .then(res => res.json())
      .then(data => setNeedsSetup(data.needsSetup))
      .catch(err => {
        console.error('Failed to check setup status:', err);
        setNeedsSetup(false); // Fallback to normal view on error so they can see the connection error
      });
  }, []);

  if (needsSetup === null) return <div style={{ padding: '2rem' }}>Loading ArcAid...</div>;

  if (needsSetup) {
    return <SetupWizard onComplete={() => setNeedsSetup(false)} />;
  }

  const navItems = [
    { path: '/', label: 'Dashboard', icon: <Home size={20} /> },
    { path: '/tournaments', label: 'Tournaments', icon: <Trophy size={20} /> },
    { path: '/library', label: 'Game Library', icon: <Library size={20} /> },
    { path: '/logs', label: 'Activity Logs', icon: <Activity size={20} /> },
    { path: '/settings', label: 'Settings', icon: <SettingsIcon size={20} /> },
  ];

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <h2>ArcAid Admin</h2>
        </div>
        <nav className="sidebar-nav">
          {navItems.map((item) => (
            <Link 
              key={item.path} 
              to={item.path} 
              className={`nav-link ${location.pathname === item.path ? 'active' : ''}`}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/library" element={<GameLibrary />} />
          <Route path="/logs" element={<Logs />} />
        </Routes>
      </main>
    </div>
  );
}

export default App;
