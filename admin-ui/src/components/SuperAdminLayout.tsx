import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Home, Settings as SettingsIcon, LogOut, HardDrive, Activity, Menu, X, DoorOpen, Palette, Globe, ClipboardList, Flag } from 'lucide-react';
import { api, isAuthenticated, getTokenRole, setToken } from '../lib/api';
import LoadingState from './LoadingState';

export default function SuperAdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ username: string; avatar: string | null } | null>(null);
  const [loading, setLoading] = useState(true);
  // v2.5.0: Catalogue Approvals nav badge — refreshed on mount + every 60s.
  const [pendingCount, setPendingCount] = useState<number>(0);
  // v2.43.0 (S22 Phase 1): Reports nav badge — same refresh idiom.
  const [reportsPendingCount, setReportsPendingCount] = useState<number>(0);

  useEffect(() => {
    if (!isAuthenticated()) {
      navigate('/login', { replace: true });
      return;
    }
    // Role guard: a non-super-admin token (e.g. a normal player who OAuth'd in
    // via the old landing "Admin" link with __super__ intent) lands here with a
    // valid-but-wrong-role token. The server 403s every /admin/* call regardless,
    // but without this the empty Super Admin shell still renders — alarming and
    // confusing. Bounce them to /login instead of painting the chrome.
    if (getTokenRole() !== 'super_admin') {
      setToken(null);
      navigate('/login', { replace: true });
      return;
    }
    api.get<{ username: string; avatar: string | null }>('/auth/me')
      .then(data => setCurrentUser({ username: data.username, avatar: data.avatar }))
      .catch(() => setCurrentUser(null))
      .finally(() => setLoading(false));

    const fetchPending = () => {
      api.get<{ count: number }>('/admin/catalogue/pending-count')
        .then(r => setPendingCount(r.count || 0))
        .catch(() => { /* nav badge is best-effort */ });
    };
    fetchPending();
    const interval = setInterval(fetchPending, 60_000);

    const fetchReportsPending = () => {
      api.get<{ pending: number }>('/admin/reports/pending-count')
        .then(r => setReportsPendingCount(r.pending || 0))
        .catch(() => { /* nav badge is best-effort */ });
    };
    fetchReportsPending();
    const reportsInterval = setInterval(fetchReportsPending, 60_000);

    return () => { clearInterval(interval); clearInterval(reportsInterval); };
  }, [navigate]);

  if (!isAuthenticated() || getTokenRole() !== 'super_admin') return null;
  if (loading) return <LoadingState message="Loading..." />;

  const handleLogout = () => {
    setToken(null);
    navigate('/login', { replace: true });
  };

  const navItems: Array<{ path: string; label: string; icon: React.ReactNode; badge?: number }> = [
    { path: '/admin/dashboard', label: 'Dashboard', icon: <Home size={18} /> },
    { path: '/admin/rooms', label: 'Game Rooms', icon: <DoorOpen size={18} /> },
    { path: '/admin/styles', label: 'Style Catalogue', icon: <Palette size={18} /> },
    { path: '/admin/catalogue', label: 'Global Catalogue', icon: <Globe size={18} /> },
    { path: '/admin/catalogue/approvals', label: 'Approvals', icon: <ClipboardList size={18} />, badge: pendingCount },
    { path: '/admin/reports', label: 'Reports', icon: <Flag size={18} />, badge: reportsPendingCount },
    { path: '/admin/backups', label: 'Backups', icon: <HardDrive size={18} /> },
    { path: '/admin/logs', label: 'Logs', icon: <Activity size={18} /> },
    { path: '/admin/settings', label: 'Global Settings', icon: <SettingsIcon size={18} /> },
  ];

  return (
    <div className="flex min-h-screen scanlines">
      {/* Mobile top bar */}
      <div className="fixed top-0 left-0 right-0 z-30 bg-surface border-b border-border flex items-center gap-3 px-4 py-3 md:hidden">
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="text-muted hover:text-primary bg-transparent border-0 cursor-pointer p-0">
          {sidebarOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
        <img src="/arcaid-logo-wide-v2.png" alt="ArcAid" className="h-9 w-auto" />
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
          <img src="/arcaid-logo-wide-v2.png" alt="ArcAid" className="h-14 w-auto" />
          <span className="text-faint text-xs">Super Admin</span>
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
  );
}
