import { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setToken } from '../lib/api';
import { maybeSeedAdminSlot } from '../lib/adminSlotSeed';

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

  // Read once per render so both the effect and the error-state JSX below
  // agree on whether this is a link flow (Fix 9 needs it in render, outside
  // the effect).
  const state = searchParams.get('state'); // room slug, player:slug, __super__, link:<nonce>, or connect:<nonce>
  const isLinkFlow = state?.startsWith('link:') ?? false;
  // v2.72.0 (Discord HQ) — the "connect Discord notifications" flow. Shares
  // this callback route (one registered redirect URI) but is otherwise its own
  // exchange: it never mints or replaces a token, it just adds the already
  // signed-in user to the Arcaid community server so DMs can reach them.
  const isConnectFlow = state?.startsWith('connect:') ?? false;

  useEffect(() => {
    // Prevent double-execution in React strict mode
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get('code');
    const errorParam = searchParams.get('error');

    // v2.36.0 — Google-account-link completion. The FE decodes its own
    // `state` (never trusting it server-side beyond that) and posts the
    // nonce explicitly alongside the code.
    const linkNonce = isLinkFlow ? state!.slice('link:'.length) : undefined;

    // Fix 1a (adversarial review, mirror-link-fixes.md) — FE session
    // binding. A link flow is only entered when this browser tab is the one
    // that STARTED it: the nonce embedded in `state` must match what
    // `startDiscordLink`/`startGoogleLink` stashed in sessionStorage before
    // redirecting. An attacker can craft an authorize URL with
    // `state=link:<nonce minted for the attacker's own account>`; if a
    // victim clicks it, this browser's sessionStorage won't have that nonce
    // (it never called /link/*/start), so the mismatch is caught HERE,
    // before ever falling through to a normal login. Cleared after one read
    // either way ("use" = read, not just success).
    let linkAuthToken: string | null = null;
    if (isLinkFlow) {
      const storedNonce = sessionStorage.getItem('arcaid_link_nonce');
      sessionStorage.removeItem('arcaid_link_nonce');
      if (!storedNonce || storedNonce !== linkNonce) {
        setError("This link request didn't start in this browser — please retry from Account Settings.");
        return;
      }
      // The initiator's own player token — still held by the FE throughout
      // this OAuth round-trip — proves to the server (Fix 1b) that the
      // browser completing the link is the one that started it.
      linkAuthToken = localStorage.getItem('arcaid_player_token');
    }

    // v2.72.0 — connect-notifications completion. Same browser-binding rule as
    // the link flow: the nonce in `state` must match the one this tab stashed
    // before redirecting, so a crafted authorize URL clicked by a victim can't
    // drive their account through someone else's flow.
    if (isConnectFlow) {
      const connectNonce = state!.slice('connect:'.length);
      const storedNonce = sessionStorage.getItem('arcaid_connect_nonce');
      sessionStorage.removeItem('arcaid_connect_nonce');
      const returnPath = sessionStorage.getItem('arcaid_connect_return') || '/account/settings';
      sessionStorage.removeItem('arcaid_connect_return');

      if (errorParam) {
        // Declining consent is a normal choice, not an error state to strand
        // the user in — send them back with a flag the settings page reads.
        window.location.href = `${returnPath}?connect=declined`;
        return;
      }
      if (!storedNonce || storedNonce !== connectNonce) {
        window.location.href = `${returnPath}?connect=error`;
        return;
      }
      if (!code) {
        window.location.href = `${returnPath}?connect=error`;
        return;
      }

      const playerToken = localStorage.getItem('arcaid_player_token');
      fetch('/api/auth/discord/connect-notifications/callback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(playerToken ? { Authorization: `Bearer ${playerToken}` } : {}),
        },
        body: JSON.stringify({
          code,
          redirectUri: `${window.location.origin}/auth/discord/callback`,
          nonce: connectNonce,
        }),
      })
        .then(async res => {
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          window.location.href = `${returnPath}?connect=success`;
        })
        .catch(err => {
          window.location.href =
            `${returnPath}?connect=error&reason=${encodeURIComponent(err.message || 'Connection failed')}`;
        });
      return;
    }

    if (errorParam) {
      if (isLinkFlow) {
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

    // Use raw fetch to avoid api.ts 401-redirect behavior. Fix 1b: link
    // flows attach the initiator's own bearer token so the server can assert
    // this browser session started the link (see extractBearerToken in
    // auth.ts). Absent for normal logins — unauthenticated by design.
    fetch('/api/auth/discord/callback', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(linkAuthToken ? { Authorization: `Bearer ${linkAuthToken}` } : {}),
      },
      body: JSON.stringify({ code, redirectUri, ...(linkNonce ? { linkNonce } : {}) }),
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      })
      .then(data => {
        // v2.36.0 — link-flow completion. The response is a fresh token for
        // the canonical (Discord) identity with `linked: true`. Store it like
        // a normal player login (the account IS the player's session from
        // here on, regardless of which button they clicked to log in), show
        // a brief success state, then bounce back to Account Settings.
        //
        // Fix 8 (adversarial review) — gate on the SERVER's `linked` flag,
        // not the FE-derived `isLinkFlow`. With a malformed/empty `state`
        // (`link:` with no nonce, or any other edge the FE's own parsing
        // mis-detects), a request that still reaches this branch could get a
        // NORMAL login response back (no `linked` field) — storing that
        // token here would silently seat the wrong identity as "linked".
        if (isLinkFlow) {
          if (data.linked !== true) {
            setError('Something went wrong completing the link. Please retry from Account Settings.');
            return;
          }
          localStorage.setItem('arcaid_player_token', data.token);
          if (data.refreshToken) localStorage.setItem('arcaid_player_refresh_token', data.refreshToken);
          if (data.user) localStorage.setItem('arcaid_player_user', JSON.stringify(data.user));
          // Field report fix — a linked login for a room_admin/super_admin
          // identity must ALSO seed the admin-token slot, same as a plain
          // player login below, so the "Room admin" affordance appears
          // regardless of which provider button completed the link.
          maybeSeedAdminSlot(data.token, decodeJwtPayload(data.token)?.role as string | undefined, data.refreshToken);
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
          // Seeds when the slot is empty OR its existing token has expired —
          // never overwrites a live, unexpired admin token (it may belong to
          // a higher-privilege session already active in this browser).
          maybeSeedAdminSlot(data.token, role, data.refreshToken);
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
        setError(
          isLinkFlow
            ? `Failed to link your Discord account: ${err.message || 'please try again from Account Settings.'}`
            : (err.message || 'Discord login failed'),
        );
      });
  }, [searchParams, onLogin, isLinkFlow, isConnectFlow, state]);

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
          <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-16 h-16 mx-auto mb-4" />
          <p className="text-neon-magenta mb-4">{error}</p>
          {/* Fix 9 (adversarial review) — applied symmetrically here too: a
              link-flow failure leaves the user still logged in (whichever
              identity they started as); "Back to Login" is the wrong CTA. */}
          {isLinkFlow ? (
            <a href="/account/settings" className="text-neon-cyan hover:underline text-sm">Back to Account Settings</a>
          ) : (
            <a href="/login" className="text-neon-cyan hover:underline text-sm">Back to Login</a>
          )}
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
