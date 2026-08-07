import { lazy, Suspense, useState } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { ThemeProvider } from './components/ThemeProvider';
import { ViewerAuthProvider } from './contexts/ViewerAuthContext';
import LoadingState from './components/LoadingState';
import ChunkErrorBoundary from './components/ChunkErrorBoundary';

// Layouts
import PublicLayout from './components/PublicLayout';

// S17 — the ENTIRE admin surface (both layouts + every subtree page) is
// code-split via React.lazy: a QR-scanning player must never download admin
// code. Vite emits one chunk per lazy import, fetched on first admin
// navigation; the single <Suspense> around <Routes> shows the standard
// spinner during that fetch. Public/player pages stay static — they are the
// latency-critical path.
const SuperAdminLayout = lazy(() => import('./components/SuperAdminLayout'));
const RoomAdminLayout = lazy(() => import('./components/RoomAdminLayout'));

// Pages — Super Admin (lazy)
import LandingPage from './pages/LandingPage';
import Login from './pages/Login';
const SuperAdminDashboard = lazy(() => import('./pages/SuperAdminDashboard'));
const GameRoomManager = lazy(() => import('./pages/GameRoomManager'));
const GlobalSettings = lazy(() => import('./pages/GlobalSettings'));
const Backups = lazy(() => import('./pages/Backups'));
const Logs = lazy(() => import('./pages/Logs'));
const StyleCatalogue = lazy(() => import('./pages/StyleCatalogue'));
const GlobalCatalogue = lazy(() => import('./pages/GlobalCatalogue'));
const CatalogueApproval = lazy(() => import('./pages/CatalogueApproval'));
const Reports = lazy(() => import('./pages/Reports'));

// Pages — Room Admin (lazy)
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Tournaments = lazy(() => import('./pages/Tournaments'));
const GameLibrary = lazy(() => import('./pages/GameLibrary'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Rankings = lazy(() => import('./pages/Rankings'));
const Stats = lazy(() => import('./pages/Stats'));
const History = lazy(() => import('./pages/History'));
const Settings = lazy(() => import('./pages/Settings'));
const Help = lazy(() => import('./pages/Help'));
const ActivityLog = lazy(() => import('./pages/ActivityLog'));
const GameStates = lazy(() => import('./pages/GameStates'));
const Identity = lazy(() => import('./pages/Identity'));
const JoinRequests = lazy(() => import('./pages/JoinRequests'));
const RoomAdminMembers = lazy(() => import('./pages/RoomAdminMembers'));
const LobbyAdmin = lazy(() => import('./pages/LobbyAdmin'));

// Pages — Public
import Scoreboard from './pages/Scoreboard';
import PlayerDetail from './pages/PlayerDetail';
import GameDetail from './pages/GameDetail';
import Picks from './pages/Picks';
import MysteryAwardPage from './pages/MysteryAwardPage';
import Lobby from './pages/Lobby';
import PublicStats from './pages/PublicStats';
import PublicHistory from './pages/PublicHistory';
import TournamentDetail from './pages/TournamentDetail';
import ComparePlayers from './pages/ComparePlayers';
import MyRooms from './pages/MyRooms';
import CreateRoom from './pages/CreateRoom';
import RoomMembers from './pages/RoomMembers';

// Pages — Kiosk
import KioskScoreboard from './pages/KioskScoreboard';

// Pages — Standalone
import ScoreSubmit from './pages/ScoreSubmit';

// Pages — Global (non-room-scoped)
import GlobalScoreboard from './pages/GlobalScoreboard';
import GlobalGameDetail from './pages/GlobalGameDetail';

// Pages — Social
import Friends from './pages/Friends';

// Pages — Account
import AccountSettings from './pages/AccountSettings';

// Pages — Stats (v2.82.0, My Stats)
import MyStats from './pages/MyStats';

// Pages — Legal (static, public)
import Privacy from './pages/Privacy';
import Terms from './pages/Terms';

// Pages — Auth
import RoomLogin from './pages/RoomLogin';
import DiscordCallback from './pages/DiscordCallback';
import GoogleCallback from './pages/GoogleCallback';
import InviteAccept from './pages/InviteAccept';

function NavigateToRoomLogin() {
  const { slug } = useParams();
  return <Navigate to={`/${slug}/login`} replace />;
}

function FreeplayRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/${slug}?tab=all-games`} replace />;
}

function PlayersToStatsRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/${slug}/stats?view=players`} replace />;
}

/**
 * Sprint 9: `/:slug/games` was the winner-picks page; renamed to `/:slug/picks`.
 * Preserves query string so stale Discord DM links (`?t=<tournamentId>`) keep working.
 */
function GamesToPicksRedirect() {
  const { slug } = useParams();
  const search = window.location.search;
  return <Navigate to={`/${slug}/picks${search}`} replace />;
}

function App() {
  const [, setAuthed] = useState(false);

  return (
    <ToastProvider>
      {/* S17: one Suspense boundary for every lazy admin chunk — the fallback
          renders while a first-visit admin chunk downloads. The error
          boundary catches stale-chunk failures after a deploy (auto-reload
          once, then a manual retry screen). */}
      <ChunkErrorBoundary>
      <Suspense fallback={<LoadingState />}>
      <Routes>
        {/* Landing page */}
        <Route path="/" element={<ViewerAuthProvider><LandingPage /></ViewerAuthProvider>} />

        {/* Super admin login */}
        <Route path="/login" element={<Login onLogin={() => setAuthed(true)} />} />

        {/* Discord OAuth callback */}
        <Route path="/auth/discord/callback" element={<DiscordCallback onLogin={() => setAuthed(true)} />} />

        {/* Google OAuth callback */}
        <Route path="/auth/google/callback" element={<GoogleCallback onLogin={() => setAuthed(true)} />} />

        {/* Invite acceptance (public) */}
        <Route path="/invite/:token" element={<InviteAccept />} />

        {/* Legal pages (static, public — must precede the /:slug dynamic route) */}
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />

        {/* Super admin routes */}
        <Route path="/admin" element={<SuperAdminLayout />}>
          <Route index element={<Navigate to="/admin/dashboard" replace />} />
          <Route path="dashboard" element={<SuperAdminDashboard />} />
          <Route path="rooms" element={<GameRoomManager />} />
          {/* Master Library consolidated into Global Catalogue (2026-07). Redirect old links. */}
          <Route path="library" element={<Navigate to="/admin/catalogue" replace />} />
          <Route path="styles" element={<StyleCatalogue />} />
          <Route path="catalogue" element={<GlobalCatalogue />} />
          <Route path="catalogue/approvals" element={<CatalogueApproval />} />
          <Route path="reports" element={<Reports />} />
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
          <Route path="games" element={<GameStates />} />
          <Route path="lobby" element={<LobbyAdmin />} />
          <Route path="styles" element={<StyleCatalogue />} />
          <Route path="identity" element={<Identity />} />
          <Route path="members" element={<RoomAdminMembers />} />
          <Route path="join-requests" element={<JoinRequests />} />
          <Route path="activity" element={<ActivityLog />} />
          <Route path="settings" element={<Settings />} />
          <Route path="help" element={<Help />} />
        </Route>

        {/* Friends (global, requires Discord login) */}
        <Route path="/friends" element={<ViewerAuthProvider><Friends /></ViewerAuthProvider>} />

        {/* Account settings (global, requires Discord login) */}
        <Route path="/account/settings" element={<ViewerAuthProvider><AccountSettings /></ViewerAuthProvider>} />

        {/* My Rooms (global, requires Discord login) */}
        <Route path="/my-rooms" element={<ViewerAuthProvider><MyRooms /></ViewerAuthProvider>} />

        {/* My Stats (global, requires Discord login; v2.82.0) */}
        <Route path="/my-stats" element={<ViewerAuthProvider><MyStats /></ViewerAuthProvider>} />

        {/* Create Room (global, requires Discord login) */}
        <Route path="/create-room" element={<ViewerAuthProvider><CreateRoom /></ViewerAuthProvider>} />

        {/* Global scoreboard (cross-room aggregate, public) */}
        <Route path="/scoreboard" element={<ViewerAuthProvider><GlobalScoreboard /></ViewerAuthProvider>} />
        <Route path="/games/:globalGameId" element={<ViewerAuthProvider><GlobalGameDetail /></ViewerAuthProvider>} />

        {/* Kiosk mode (standalone, no layout wrapper) */}
        <Route path="/:slug/kiosk" element={<KioskScoreboard />} />

        {/* QR code score submission (standalone, with viewer auth for Discord prepopulation) */}
        <Route path="/:slug/submit/:gameId" element={<ViewerAuthProvider><ScoreSubmit /></ViewerAuthProvider>} />

        {/* Public room routes */}
        <Route path="/:slug" element={<ViewerAuthProvider><PublicLayout /></ViewerAuthProvider>}>
          <Route index element={<Scoreboard />} />
          <Route path="lobby" element={<Lobby />} />
          <Route path="players" element={<PlayersToStatsRedirect />} />
          <Route path="players/:id" element={<PlayerDetail />} />
          <Route path="members" element={<RoomMembers />} />
          <Route path="picks" element={<Picks />} />
          <Route path="mystery-award" element={<MysteryAwardPage />} />
          <Route path="games" element={<GamesToPicksRedirect />} />
          <Route path="games/:name" element={<GameDetail />} />
          <Route path="freeplay" element={<FreeplayRedirect />} />
          <Route path="stats" element={<PublicStats />} />
          <Route path="history" element={<PublicHistory />} />
          <Route path="tournaments/:tournamentId" element={<TournamentDetail />} />
          <Route path="compare" element={<ComparePlayers />} />
        </Route>
      </Routes>
      </Suspense>
      </ChunkErrorBoundary>
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
