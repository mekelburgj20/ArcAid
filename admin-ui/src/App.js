import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Routes, Route, Link, useLocation } from 'react-router-dom';
import { api } from './lib/api';
import { Home, Settings as SettingsIcon, Trophy, Activity } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import SetupWizard from './pages/SetupWizard';
import Logs from './pages/Logs';
import './App.css';
function App() {
    const location = useLocation();
    const [needsSetup, setNeedsSetup] = useState(null);
    useEffect(() => {
        api.get('/status')
            .then(data => setNeedsSetup(data.needsSetup))
            .catch(err => {
            console.error('Failed to check setup status:', err);
            setNeedsSetup(false); // Fallback to normal view on error so they can see the connection error
        });
    }, []);
    if (needsSetup === null)
        return _jsx("div", { style: { padding: '2rem' }, children: "Loading ArcAid..." });
    if (needsSetup) {
        return _jsx(SetupWizard, { onComplete: () => setNeedsSetup(false) });
    }
    const navItems = [
        { path: '/', label: 'Dashboard', icon: _jsx(Home, { size: 20 }) },
        { path: '/tournaments', label: 'Tournaments', icon: _jsx(Trophy, { size: 20 }) },
        { path: '/logs', label: 'Activity Logs', icon: _jsx(Activity, { size: 20 }) },
        { path: '/settings', label: 'Settings', icon: _jsx(SettingsIcon, { size: 20 }) },
    ];
    return (_jsxs("div", { className: "app-container", children: [_jsxs("aside", { className: "sidebar", children: [_jsx("div", { className: "sidebar-header", children: _jsx("h2", { children: "ArcAid Admin" }) }), _jsx("nav", { className: "sidebar-nav", children: navItems.map((item) => (_jsxs(Link, { to: item.path, className: `nav-link ${location.pathname === item.path ? 'active' : ''}`, children: [item.icon, _jsx("span", { children: item.label })] }, item.path))) })] }), _jsx("main", { className: "main-content", children: _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Dashboard, {}) }), _jsx(Route, { path: "/settings", element: _jsx(Settings, {}) }), _jsx(Route, { path: "/tournaments", element: _jsxs("div", { className: "page", children: [_jsx("h1", { children: "Tournaments" }), _jsx("p", { children: "Coming soon..." })] }) }), _jsx(Route, { path: "/logs", element: _jsx(Logs, {}) })] }) })] }));
}
export default App;
//# sourceMappingURL=App.js.map