import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';

/**
 * Google OAuth callback — clone-and-diverge from DiscordCallback.tsx
 * (v2.35.0, Google login contract D5). The two share the exact same
 * state-encoding conventions (`player:<slug>`, `__super__`, bare slug),
 * localStorage keys, and post-login routing logic, so this is a deliberate
 * near-duplicate rather than an extracted shared helper: DiscordCallback is
 * the battle-tested original (OAuth-cancel handling, admin-token seeding,
 * role-based redirect) and factoring it apart risked regressing that path
 * for a marginal DRY win. If a THIRD provider is ever added, extract then.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export default function GoogleCallback({ onLogin }: { onLogin: () => void }) {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState('');
  const exchanged = useRef(false);

  useEffect(() => {
    // Prevent double-execution in React strict mode
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');
    const state = searchParams.get('state'); // room slug, player:slug, or __super__

    if (errorParam) {
      // Google uses the same standard OAuth2 `access_denied` error param as
      // Discord when the user cancels consent — same cancel-handling as
      // DiscordCallback for a mid-claim submission draft.
      const isPlayerCancel = errorParam === 'access_denied' && state?.startsWith('player:');
      if (isPlayerCancel) {
        const stored = localStorage.getItem('arcaid_player_return');
        localStorage.removeItem('arcaid_player_return');
        if (stored) {
          const parsed = new URL(stored, window.location.origin);
          const stateParam = parsed.searchParams.get('submit-draft');
          if (stateParam) {
            parsed.searchParams.delete('submit-draft');
            parsed.searchParams.set('submit-cancelled', stateParam);
            window.location.href = parsed.pathname + parsed.search;
            return;
          }
          // No draft associated — drop the marker and return to origin.
          window.location.href = parsed.pathname + parsed.search;
          return;
        }
      }
      setError(`Google authorization denied: ${searchParams.get('error_description') || errorParam}`);
      return;
    }

    if (!code) {
      setError('No authorization code received from Google');
      return;
    }

    const redirectUri = `${window.location.origin}/auth/google/callback`;

    // Use raw fetch to avoid api.ts 401-redirect behavior
    fetch('/api/auth/google/callback', {
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
        const payload = decodeJwtPayload(data.token);
        const role = payload?.role as string | undefined;

        // Check if this is a player login flow (initiated from public page)
        const isPlayerFlow = state?.startsWith('player:');

        if (isPlayerFlow || role === 'player') {
          // Store player token separately — don't overwrite admin session
          localStorage.setItem('arcaid_player_token', data.token);
          if (data.refreshToken) localStorage.setItem('arcaid_player_refresh_token', data.refreshToken);
          if (data.user) {
            localStorage.setItem('arcaid_player_user', JSON.stringify(data.user));
          }
          // If the same identity is a room_admin or super_admin, also seed
          // the admin-token slot so the UserMenu "Room admin" link appears
          // and /:slug/admin/login auto-bounces past the password form.
          // Guarded on the slot being empty so a higher-privilege session
          // already active in this browser isn't silently downgraded.
          if ((role === 'room_admin' || role === 'super_admin') && !localStorage.getItem('arcaid_token')) {
            setToken(data.token);
            if (data.refreshToken) localStorage.setItem('arcaid_admin_refresh_token', data.refreshToken);
          }
          // Notify ViewerAuthContext
          window.dispatchEvent(new Event('arcaid_player_login'));

          // Redirect back to the public page
          const returnPath = localStorage.getItem('arcaid_player_return');
          localStorage.removeItem('arcaid_player_return');
          if (returnPath) {
            window.location.href = returnPath;
          } else if (state?.startsWith('player:')) {
            const slug = state.slice('player:'.length);
            window.location.href = `/${slug}/lobby`;
          } else {
            window.location.href = '/';
          }
          return;
        }

        // Admin login flow — store as admin token
        setToken(data.token);
        if (data.refreshToken) localStorage.setItem('arcaid_admin_refresh_token', data.refreshToken);
        onLogin();

        if (payload) {
          if (role === 'super_admin') {
            if (state && state !== '__super__') {
              window.location.href = `/${state}/admin/dashboard`;
            } else {
              window.location.href = '/admin/dashboard';
            }
            return;
          }

          if (role === 'room_admin') {
            const gameRoomIds = payload.gameRoomIds as string[] | undefined;
            if (state && state !== '__super__') {
              window.location.href = `/${state}/admin/dashboard`;
              return;
            }
            const roomSlugs = payload.roomSlugs as string[] | undefined;
            if (roomSlugs && roomSlugs.length > 0) {
              window.location.href = `/${roomSlugs[0]}/admin/dashboard`;
              return;
            }
            if (gameRoomIds && gameRoomIds.length > 0) {
              window.location.href = '/admin/dashboard';
              return;
            }
          }
        }

        // Default: go to super admin dashboard
        window.location.href = '/admin/dashboard';
      })
      .catch(err => {
        setError(err.message || 'Google login failed');
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
        <p className="text-muted text-sm">Authenticating with Google...</p>
      </div>
    </div>
  );
}
