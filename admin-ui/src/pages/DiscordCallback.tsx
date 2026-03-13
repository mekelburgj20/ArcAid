import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';

export default function DiscordCallback({ onLogin }: { onLogin: () => void }) {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState('');
  const exchanged = useRef(false);

  useEffect(() => {
    // Prevent double-execution in React strict mode
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');

    if (errorParam) {
      setError(`Discord authorization denied: ${searchParams.get('error_description') || errorParam}`);
      return;
    }

    if (!code) {
      setError('No authorization code received from Discord');
      return;
    }

    const redirectUri = `${window.location.origin}/auth/discord/callback`;

    // Use raw fetch to avoid api.ts 401-redirect behavior
    fetch('/api/auth/discord/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUri }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      })
      .then(data => {
        setToken(data.token);
        onLogin();
        window.location.href = '/';
      })
      .catch(err => {
        setError(err.message || 'Discord login failed');
      });
  }, [searchParams, onLogin]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm text-center">
          <img src="/arcaid-logo.png" alt="ArcAid" className="w-16 h-16 mx-auto mb-4" />
          <p className="text-neon-magenta mb-4">{error}</p>
          <a href="/login" className="text-neon-cyan hover:underline text-sm">Back to Login</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep">
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin mx-auto mb-4" />
        <p className="text-muted text-sm">Authenticating with Discord...</p>
      </div>
    </div>
  );
}
