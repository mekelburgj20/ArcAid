import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
export default function Dashboard() {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        fetch('http://localhost:3001/api/status')
            .then(res => {
            if (!res.ok)
                throw new Error('Network response was not ok');
            return res.json();
        })
            .then(data => setStatus(data))
            .catch(err => setError(err.message));
    }, []);
    return (_jsxs("div", { className: "page", children: [_jsx("h1", { children: "Dashboard" }), error && (_jsxs("div", { className: "card error-card", children: [_jsx("h3", { children: "Connection Error" }), _jsx("p", { children: "Could not connect to the ArcAid backend API (http://localhost:3001)." }), _jsx("p", { className: "small", children: "Ensure the main bot process is running." })] })), status && (_jsxs("div", { className: "card status-card", children: [_jsx("h3", { children: "System Status" }), _jsxs("div", { className: "status-grid", children: [_jsxs("div", { className: "status-item", children: [_jsx("span", { className: "label", children: "Bot Status:" }), _jsx("span", { className: "value success", children: status.status })] }), _jsxs("div", { className: "status-item", children: [_jsx("span", { className: "label", children: "Terminology Mode:" }), _jsx("span", { className: "value capitalize", children: status.terminologyMode })] })] })] }))] }));
}
//# sourceMappingURL=Dashboard.js.map