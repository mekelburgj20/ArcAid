import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';

interface DiscordUser {
  discordId: string;
  username: string;
  avatar: string | null;
}

interface ViewerAuth {
  /** Admin token (for password-protected rooms) */
  token: string | null;
  /** Discord player session */
  discordUser: DiscordUser | null;
  playerToken: string | null;
  /**
   * Initiate Discord OAuth login from a public page.
   *
   * `returnSlug` is the room slug to return to (for room pages), or
   * `__global__` for non-room pages like /scoreboard. Pass `returnPath`
   * to override the default return URL after the OAuth round trip.
   */
  loginWithDiscord: (returnSlug: string, returnPath?: string) => void;
  /** Log out the player session */
  logoutPlayer: () => void;
}

const PLAYER_TOKEN_KEY = 'arcaid_player_token';
const PLAYER_USER_KEY = 'arcaid_player_user';
const PLAYER_REFRESH_KEY = 'arcaid_player_refresh_token';

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

function isTokenExpired(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  return (payload.exp as number) * 1000 < Date.now();
}

async function tryRefreshPlayerToken(): Promise<{ token: string; refreshToken: string; user: DiscordUser } | null> {
  const refreshToken = localStorage.getItem(PLAYER_REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const payload = decodeJwtPayload(data.token);
    if (!payload) return null;
    const user: DiscordUser = {
      discordId: payload.discordId as string,
      username: payload.username as string,
      avatar: (payload.avatar as string) || null,
    };
    localStorage.setItem(PLAYER_TOKEN_KEY, data.token);
    localStorage.setItem(PLAYER_REFRESH_KEY, data.refreshToken);
    localStorage.setItem(PLAYER_USER_KEY, JSON.stringify(user));
    return { token: data.token, refreshToken: data.refreshToken, user };
  } catch {
    return null;
  }
}

function loadStoredSession(): { playerToken: string | null; discordUser: DiscordUser | null } {
  const token = localStorage.getItem(PLAYER_TOKEN_KEY);
  const userStr = localStorage.getItem(PLAYER_USER_KEY);
  if (!token || isTokenExpired(token)) {
    if (!localStorage.getItem(PLAYER_REFRESH_KEY)) {
      localStorage.removeItem(PLAYER_TOKEN_KEY);
      localStorage.removeItem(PLAYER_USER_KEY);
    }
    return { playerToken: null, discordUser: null };
  }
  let discordUser: DiscordUser | null = null;
  try { discordUser = userStr ? JSON.parse(userStr) : null; } catch {}
  return { playerToken: token, discordUser };
}

export const ViewerAuthContext = createContext<ViewerAuth>({
  token: null,
  discordUser: null,
  playerToken: null,
  loginWithDiscord: () => {},
  logoutPlayer: () => {},
});

export function useViewerAuth() {
  return useContext(ViewerAuthContext);
}

/** Build headers object for fetch calls in password-protected rooms. */
export function useViewerHeaders(): Record<string, string> {
  const { token } = useViewerAuth();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Build headers for player-authenticated API calls (Discord login). */
export function usePlayerHeaders(): Record<string, string> {
  const { playerToken } = useViewerAuth();
  return playerToken ? { Authorization: `Bearer ${playerToken}` } : {};
}

export function ViewerAuthProvider({ children }: { children: ReactNode }) {
  const stored = loadStoredSession();
  const [playerToken, setPlayerToken] = useState<string | null>(stored.playerToken);
  const [discordUser, setDiscordUser] = useState<DiscordUser | null>(stored.discordUser);

  // Listen for player login events (set by DiscordCallback)
  useEffect(() => {
    const handler = () => {
      const session = loadStoredSession();
      setPlayerToken(session.playerToken);
      setDiscordUser(session.discordUser);
    };
    window.addEventListener('arcaid_player_login', handler);
    return () => window.removeEventListener('arcaid_player_login', handler);
  }, []);

  // Auto-refresh: on mount if expired, then every 60s before expiry
  useEffect(() => {
    const refresh = async () => {
      const result = await tryRefreshPlayerToken();
      if (result) {
        setPlayerToken(result.token);
        setDiscordUser(result.user);
      } else if (localStorage.getItem(PLAYER_REFRESH_KEY)) {
        localStorage.removeItem(PLAYER_TOKEN_KEY);
        localStorage.removeItem(PLAYER_USER_KEY);
        localStorage.removeItem(PLAYER_REFRESH_KEY);
        setPlayerToken(null);
        setDiscordUser(null);
      }
    };
    const checkAndRefresh = () => {
      const token = localStorage.getItem(PLAYER_TOKEN_KEY);
      if (!token) {
        if (localStorage.getItem(PLAYER_REFRESH_KEY)) refresh();
        return;
      }
      const payload = decodeJwtPayload(token);
      if (!payload?.exp) return;
      const expiresIn = (payload.exp as number) * 1000 - Date.now();
      if (expiresIn < 5 * 60 * 1000) refresh();
    };
    checkAndRefresh();
    const interval = setInterval(checkAndRefresh, 60_000);
    return () => clearInterval(interval);
  }, []);

  const loginWithDiscord = useCallback(async (returnSlug: string, returnPath?: string) => {
    // Store return path so DiscordCallback knows where to send the user back.
    // Default for room pages: /:slug/games. Global pages pass returnPath explicitly.
    const path = returnPath || `/${returnSlug}/games`;
    localStorage.setItem('arcaid_player_return', path);

    try {
      const res = await fetch('/api/auth/discord');
      const { clientId } = await res.json();
      if (!clientId) return;

      const redirectUri = `${window.location.origin}/auth/discord/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: `player:${returnSlug}`,
      });
      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch {
      // silently fail
    }
  }, []);

  const logoutPlayer = useCallback(() => {
    localStorage.removeItem(PLAYER_TOKEN_KEY);
    localStorage.removeItem(PLAYER_USER_KEY);
    localStorage.removeItem(PLAYER_REFRESH_KEY);
    setPlayerToken(null);
    setDiscordUser(null);
  }, []);

  return (
    <ViewerAuthContext.Provider value={{ token: null, discordUser, playerToken, loginWithDiscord, logoutPlayer }}>
      {children}
    </ViewerAuthContext.Provider>
  );
}
