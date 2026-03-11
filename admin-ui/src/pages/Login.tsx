import { useState } from 'react';
import { api, setToken } from '../lib/api';
import NeonButton from '../components/NeonButton';

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api.post<{ token: string }>('/auth/login', { password });
      setToken(data.token);
      onLogin();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep">
      <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm">
        <img src="/arcaid-logo.png" alt="ArcAid" className="w-24 h-24 mx-auto mb-2" />
        <p className="text-muted text-center text-sm mb-8">Admin Console</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            placeholder="Admin Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
            autoFocus
          />

          {error && (
            <p className="text-neon-magenta text-sm">{error}</p>
          )}

          <NeonButton type="submit" disabled={loading || !password}>
            {loading ? 'Authenticating...' : 'Login'}
          </NeonButton>

          <p className="text-faint text-xs text-center">
            First login sets the admin password
          </p>
        </form>
      </div>
    </div>
  );
}
