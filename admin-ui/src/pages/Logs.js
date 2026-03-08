import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState, useRef } from 'react';
import { api } from '../lib/api';
export default function Logs() {
    const [logs, setLogs] = useState('Loading logs...');
    const logsEndRef = useRef(null);
    const fetchLogs = async () => {
        try {
            const data = await api.get('/logs');
            setLogs(data.logs);
        }
        catch (err) {
            setLogs('Failed to fetch logs. Is the backend running?');
        }
    };
    useEffect(() => {
        fetchLogs();
        const interval = setInterval(fetchLogs, 5000); // Poll every 5s
        return () => clearInterval(interval);
    }, []);
    useEffect(() => {
        // Auto-scroll to bottom
        logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [logs]);
    return (_jsxs("div", { className: "page", style: { height: 'calc(100vh - 4rem)', display: 'flex', flexDirection: 'column' }, children: [_jsx("h1", { children: "Activity Logs" }), _jsxs("div", { className: "card", style: {
                    flex: 1,
                    overflowY: 'auto',
                    backgroundColor: '#1e1e1e',
                    color: '#d4d4d4',
                    fontFamily: 'monospace',
                    padding: '1rem'
                }, children: [_jsx("pre", { style: { margin: 0, whiteSpace: 'pre-wrap' }, children: logs }), _jsx("div", { ref: logsEndRef })] })] }));
}
//# sourceMappingURL=Logs.js.map