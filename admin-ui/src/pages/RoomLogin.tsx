import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, setToken, getToken } from '../lib/api';
import NeonButton from '../components/NeonButton';

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

function isTokenValid(token: string): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return false;
  return (payload.exp as number) * 1000 > Date.now();
}

export default function RoomLogin({ onLogin }: { onLogin: () => void }) {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [roomName, setRoomName] = useState<string>('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [discordLoading, setDiscordLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [roomLoading, setRoomLoading] = useState(true);

  // Redirect if already authenticated with a valid token
  useEffect(() => {
    const token = getToken();
    if (token && isTokenValid(token)) {
      onLogin();
      navigate(`/${slug}/admin/dashboard`, { replace: true });
    }
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    fetch('/api/rooms')
      .then(r => r.json())
      .then((rooms: Array<{ slug: string; name: string }>) => {
        const found = rooms.find(r => r.slug.toLowerCase() === slug.toLowerCase());
        if (found) setRoomName(found.name);
      })
      .catch(() => {})
      .finally(() => setRoomLoading(false));
  }, [slug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const data = await api.post<{ token: string }>(`/auth/login/${slug}`, { username, password });
      setToken(data.token);
      onLogin();
      navigate(`/${slug}/admin/dashboard`, { replace: true });
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDiscordLogin = async () => {
    setError('');
    setDiscordLoading(true);
    try {
      const data = await api.get<{ clientId: string }>('/auth/discord');
      const redirectUri = `${window.location.origin}/auth/discord/callback`;
      const params = new URLSearchParams({
        client_id: data.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: slug || '',
      });
      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch (err: any) {
      setError(err.message || 'Discord login not available');
      setDiscordLoading(false);
    }
  };

  // v2.35.0 — a Google-identified room_admin is legitimate (role derivation
  // is table-based and provider-agnostic); mirrors handleDiscordLogin exactly.
  const handleGoogleLogin = async () => {
    setError('');
    setGoogleLoading(true);
    try {
      const data = await api.get<{ clientId: string }>('/auth/google');
      const redirectUri = `${window.location.origin}/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: data.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: slug || '',
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } catch (err: any) {
      setError(err.message || 'Google login not available');
      setGoogleLoading(false);
    }
  };

  if (roomLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep">
      <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm">
        <img src="/arcaid-logo-v2.png" alt="ArcAid" className="w-24 h-24 mx-auto mb-2" />
        <p className="text-neon-cyan text-center text-sm font-pixel mb-1">{roomName || slug}</p>
        <p className="text-muted text-center text-sm mb-8">Room Admin Login</p>

        {/* Discord OAuth Login */}
        <button
          onClick={handleDiscordLogin}
          disabled={discordLoading}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-[#5865F2] hover:bg-[#4752C4] text-white rounded font-medium transition-colors cursor-pointer border-0 disabled:opacity-50 disabled:cursor-not-allowed mb-6"
        >
          <svg width="20" height="15" viewBox="0 0 71 55" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1099 30.1693C30.1099 34.1136 27.2802 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.7018 30.1693C53.7018 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="white"/>
          </svg>
          {discordLoading ? 'Redirecting...' : 'Login with Discord'}
        </button>

        {/* Google OAuth Login (v2.35.0) */}
        <button
          onClick={handleGoogleLogin}
          disabled={googleLoading}
          className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-surface border border-border hover:bg-raised text-primary rounded font-medium transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mb-6"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.87c2.27-2.09 3.58-5.17 3.58-8.84z" />
            <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.87-3.02c-1.08.72-2.46 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.95H1.27v3.11A12 12 0 0 0 12 24z" />
            <path fill="#FBBC05" d="M5.27 14.28A7.2 7.2 0 0 1 4.89 12c0-.79.14-1.56.38-2.28V6.61H1.27A12 12 0 0 0 0 12c0 1.94.46 3.77 1.27 5.39l4-3.11z" />
            <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.6 4.59 1.79l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.27 6.61l4 3.11C6.22 6.88 8.87 4.77 12 4.77z" />
          </svg>
          {googleLoading ? 'Redirecting...' : 'Login with Google'}
        </button>

        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1 border-t border-border" />
          <span className="text-faint text-xs">or</span>
          <div className="flex-1 border-t border-border" />
        </div>

        {/* Username/Password Login */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
          />

          {error && (
            <p className="text-neon-magenta text-sm">{error}</p>
          )}

          <NeonButton type="submit" disabled={loading || !password}>
            {loading ? 'Authenticating...' : 'Login'}
          </NeonButton>
        </form>
      </div>
    </div>
  );
}
