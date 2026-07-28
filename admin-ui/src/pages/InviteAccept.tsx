import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import NeonButton from '../components/NeonButton';

interface InviteInfo {
  display_name: string;
  room_name: string;
  room_slug: string;
  expires_at: string;
}

export default function InviteAccept() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/invite/${token}`)
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Invalid invite');
        return data;
      })
      .then(setInfo)
      .catch(err => setError(err.message || 'Invalid or expired invite'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch(`/api/invite/${token}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create account');
      setSuccess(data.room_slug);
    } catch (err: any) {
      setError(err.message || 'Failed to create account');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
      </div>
    );
  }

  if (success) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm text-center">
          <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-16 h-16 mx-auto mb-4" />
          <h2 className="font-display text-xl font-bold text-neon-green mb-2">Account Created</h2>
          <p className="text-muted text-sm mb-6">
            Your admin account has been set up. You can now log in.
          </p>
          <Link
            to={`/${success}/login`}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40 rounded font-medium hover:bg-neon-cyan/30 hover:border-neon-cyan/60 transition-all no-underline"
          >
            Go to Login
          </Link>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-deep">
        <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm text-center">
          <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-16 h-16 mx-auto mb-4" />
          <p className="text-neon-magenta mb-4">{error || 'Invalid or expired invite'}</p>
          <Link to="/" className="text-neon-cyan hover:underline text-sm no-underline">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-deep">
      <div className="bg-surface border border-border rounded-lg p-8 w-full max-w-sm">
        <img src="/arcaid-logo-v2.png" alt="Arcaid" className="w-16 h-16 mx-auto mb-2" />
        <h2 className="font-display text-lg font-bold text-center text-primary mb-1">
          You're Invited
        </h2>
        <p className="text-muted text-center text-sm mb-6">
          Join <span className="text-neon-cyan font-medium">{info.room_name}</span> as an admin
        </p>

        <div className="bg-raised border border-border rounded px-4 py-3 mb-6">
          <p className="text-xs text-faint mb-1">Display Name</p>
          <p className="text-primary font-medium">{info.display_name}</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="text-xs text-faint block mb-1">Username</label>
            <input
              type="text"
              placeholder="Choose a username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs text-faint block mb-1">Password</label>
            <input
              type="password"
              placeholder="At least 8 characters"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>
          <div>
            <label className="text-xs text-faint block mb-1">Confirm Password</label>
            <input
              type="password"
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              className="w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>

          {error && <p className="text-neon-magenta text-sm">{error}</p>}

          <NeonButton type="submit" disabled={submitting || !username.trim() || !password}>
            {submitting ? 'Creating Account...' : 'Create Account'}
          </NeonButton>

          <p className="text-faint text-xs text-center">
            Invite expires {new Date(info.expires_at).toLocaleDateString()}
          </p>
        </form>
      </div>
    </div>
  );
}
