import { useEffect, useState, useRef } from 'react';

export default function Logs() {
  const [logs, setLogs] = useState<string>('Loading logs...');
  const logsEndRef = useRef<HTMLDivElement>(null);

  const fetchLogs = async () => {
    try {
      const res = await fetch('http://localhost:3001/api/logs');
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs);
      }
    } catch (err) {
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

  return (
    <div className="page" style={{ height: 'calc(100vh - 4rem)', display: 'flex', flexDirection: 'column' }}>
      <h1>Activity Logs</h1>
      <div 
        className="card" 
        style={{ 
          flex: 1, 
          overflowY: 'auto', 
          backgroundColor: '#1e1e1e', 
          color: '#d4d4d4', 
          fontFamily: 'monospace',
          padding: '1rem'
        }}
      >
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
          {logs}
        </pre>
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
