import { useState } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { ThemeProvider } from './components/ThemeProvider';

// Layouts
import SuperAdminLayout from './components/SuperAdminLayout';
import RoomAdminLayout from './components/RoomAdminLayout';
import PublicLayout from './components/PublicLayout';

// Pages — Super Admin
import LandingPage from './pages/LandingPage';
import Login from './pages/Login';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import GameRoomManager from './pages/GameRoomManager';
import GlobalSettings from './pages/GlobalSettings';
import Backups from './pages/Backups';
import Logs from './pages/Logs';
import StyleCatalogue from './pages/StyleCatalogue';

// Pages — Room Admin (reused existing)
import Dashboard from './pages/Dashboard';
import Tournaments from './pages/Tournaments';
import GameLibrary from './pages/GameLibrary';
import Leaderboard from './pages/Leaderboard';
import Rankings from './pages/Rankings';
import Stats from './pages/Stats';
import History from './pages/History';
import Settings from './pages/Settings';
import Help from './pages/Help';

// Pages — Public
import Scoreboard from './pages/Scoreboard';
import Players from './pages/Players';
import PlayerDetail from './pages/PlayerDetail';
import GameDetail from './pages/GameDetail';
import GameAvailability from './pages/GameAvailability';

// Pages — Kiosk
import KioskScoreboard from './pages/KioskScoreboard';

// Pages — Auth
import RoomLogin from './pages/RoomLogin';
import DiscordCallback from './pages/DiscordCallback';
import InviteAccept from './pages/InviteAccept';

function NavigateToRoomLogin() {
  const { slug } = useParams();
  return <Navigate to={`/${slug}/login`} replace />;
}

function App() {
  const [, setAuthed] = useState(false);

  return (
    <ToastProvider>
      <Routes>
        {/* Landing page */}
        <Route path="/" element={<LandingPage />} />

        {/* Super admin login */}
        <Route path="/login" element={<Login onLogin={() => setAuthed(true)} />} />

        {/* Discord OAuth callback */}
        <Route path="/auth/discord/callback" element={<DiscordCallback onLogin={() => setAuthed(true)} />} />

        {/* Invite acceptance (public) */}
        <Route path="/invite/:token" element={<InviteAccept />} />

        {/* Super admin routes */}
        <Route path="/admin" element={<SuperAdminLayout />}>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<SuperAdminDashboard />} />
          <Route path="rooms" element={<GameRoomManager />} />
          <Route path="library" element={<GameLibrary />} />
          <Route path="styles" element={<StyleCatalogue />} />
          <Route path="backups" element={<Backups />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<GlobalSettings />} />
        </Route>

        {/* Room login */}
        <Route path="/:slug/login" element={<RoomLogin onLogin={() => setAuthed(true)} />} />

        {/* Redirect /:slug/admin/login → /:slug/login */}
        <Route path="/:slug/admin/login" element={<NavigateToRoomLogin />} />

        {/* Room admin routes */}
        <Route path="/:slug/admin" element={<RoomAdminLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="tournaments" element={<Tournaments />} />
          <Route path="library" element={<GameLibrary />} />
          <Route path="leaderboard" element={<Leaderboard />} />
          <Route path="rankings" element={<Rankings />} />
          <Route path="stats" element={<Stats />} />
          <Route path="history" element={<History />} />
          <Route path="settings" element={<Settings />} />
          <Route path="help" element={<Help />} />
        </Route>

        {/* Kiosk mode (standalone, no layout wrapper) */}
        <Route path="/:slug/kiosk" element={<KioskScoreboard />} />

        {/* Public room routes */}
        <Route path="/:slug" element={<PublicLayout />}>
          <Route index element={<Scoreboard />} />
          <Route path="players" element={<Players />} />
          <Route path="players/:id" element={<PlayerDetail />} />
          <Route path="games" element={<GameAvailability />} />
          <Route path="games/:name" element={<GameDetail />} />
        </Route>
      </Routes>
    </ToastProvider>
  );
}

function AppWithTheme() {
  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

export default AppWithTheme;
