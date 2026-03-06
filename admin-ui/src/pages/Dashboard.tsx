import { useEffect, useState } from 'react';

export default function Dashboard() {
  const [status, setStatus] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('http://localhost:3001/api/status')
      .then(res => {
        if (!res.ok) throw new Error('Network response was not ok');
        return res.json();
      })
      .then(data => setStatus(data))
      .catch(err => setError(err.message));
  }, []);

  return (
    <div className="page">
      <h1>Dashboard</h1>
      
      {error && (
        <div className="card error-card">
          <h3>Connection Error</h3>
          <p>Could not connect to the ArcAid backend API (http://localhost:3001).</p>
          <p className="small">Ensure the main bot process is running.</p>
        </div>
      )}

      {status && (
        <div className="card status-card">
          <h3>System Status</h3>
          <div className="status-grid">
            <div className="status-item">
              <span className="label">Bot Status:</span>
              <span className="value success">{status.status}</span>
            </div>
            <div className="status-item">
              <span className="label">Terminology Mode:</span>
              <span className="value capitalize">{status.terminologyMode}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
