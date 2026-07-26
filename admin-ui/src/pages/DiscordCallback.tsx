import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';

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

export default function DiscordCallback({ onLogin }: { onLogin: () => void }) {
  const [searchParams] = useSearchParams();
  const [error, setError] = useState('');
  const [linkSuccess, setLinkSuccess] = useState(false);
  const exchanged = useRef(false);

  useEffect(() => {
    // Prevent double-execution in React strict mode
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');
    const state = searchParams.get('state'); // room slug, player:slug, __super__, or link:<nonce>

    // v2.36.0 — Google-account-link completion. The FE decodes its own
    // `state` (never trusting it server-side beyond that) and posts the
    // nonce explicitly alongside the code.
    const isLinkFlow = state?.startsWith('link:') ?? false;
    const linkNonce = isLinkFlow ? state!.slice('link:'.length) : undefined;

    if (errorParam) {
      if (isLinkFlow) {
        sessionStorage.removeItem('arcaid_link_nonce');
        setError(`Discord authorization denied: ${searchParams.get('error_description') || errorParam}`);
        return;
      }
      // Sprint 13 (plan §10.3): if the user cancelled OAuth mid-claim flow, the
      // original page has a pending draft in sessionStorage + on the stored return
      // URL. Replace the success marker with `submit-cancelled` so the
      // PendingSubmissionWatcher opens the "Continue as guest or discard?" modal
      // instead of committing. Applies only to player flows.
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
      body: JSON.stringify({ code, redirectUri, ...(linkNonce ? { linkNonce } : {}) }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      })
      .then(data => {
        sessionStorage.removeItem('arcaid_link_nonce');

        // v2.36.0 — link-flow completion. The response is a fresh token for
        // the canonical (Discord) identity with `linked: true`. Store it like
        // a normal player login (the account IS the player's session from
        // here on, regardless of which button they clicked to log in), show
        // a brief success state, then bounce back to Account Settings.
        if (isLinkFlow) {
          localStorage.setItem('arcaid_player_token', data.token);
          if (data.refreshToken) localStorage.setItem('arcaid_player_refresh_token', data.refreshToken);
          if (data.user) localStorage.setItem('arcaid_player_user', JSON.stringify(data.user));
          window.dispatchEvent(new Event('arcaid_player_login'));
          setLinkSuccess(true);
          window.setTimeout(() => { window.location.href = '/account/settings'; }, 1200);
          return;
        }

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
          // If the same Discord identity is a room_admin or super_admin, also
          // seed the admin-token slot so the UserMenu "Room admin" link appears
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
        sessionStorage.removeItem('arcaid_link_nonce');
        setError(
          isLinkFlow
            ? `Failed to link your Discord account: ${err.message || 'please try again from Account Settings.'}`
            : (err.message || 'Discord login failed'),
        );
      });
  }, [searchParams, onLogin]);

  if (linkSuccess) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="text-center">
          <div className="w-8 h-8 rounded-full bg-neon-cyan/10 border border-neon-cyan/40 text-neon-cyan flex items-center justify-center mx-auto mb-4">
            ✓
          </div>
          <p className="text-primary text-sm">Discord account linked!</p>
          <p className="text-muted text-xs mt-1">Redirecting to Account Settings…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm text-center">
          <img src="/arcaid-logo-v2.png" alt="ArcAid" className="w-16 h-16 mx-auto mb-4" />
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
