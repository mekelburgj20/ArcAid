import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, Trash2, Users, ArrowLeft, Home } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

interface Friend {
  id: string;
  friend_user_id: string;
  friend_discord_username: string | null;
  iscored_username: string | null;
  avatar_hash: string | null;
  created_at: string;
}

export default function Friends() {
  const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [loading, setLoading] = useState(true);
  const [username, setUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const authHeaders: Record<string, string> = playerToken
    ? { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };

  const loadFriends = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/me/friends', { headers: { Authorization: `Bearer ${playerToken}` } });
      if (res.ok) setFriends(await res.json());
    } catch {}
    setLoading(false);
  }, [playerToken]);

  useEffect(() => { loadFriends(); }, [loadFriends]);

  const addFriend = async () => {
    if (!username.trim() || !playerToken) return;
    setAdding(true);
    setError('');
    try {
      const res = await fetch('/api/me/friends', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ discordUsername: username.trim() }),
      });
      if (res.ok) {
        setUsername('');
        loadFriends();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to add friend');
      }
    } catch {
      setError('Network error');
    }
    setAdding(false);
  };

  const removeFriend = async (friendUserId: string) => {
    if (!playerToken) return;
    await fetch(`/api/me/friends/${friendUserId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    loadFriends();
  };

  if (!discordUser) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center">
          <Users size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in with Discord to manage your friends list</p>
          <button
            onClick={() => loginWithDiscord('__friends__')}
            className="px-4 py-2 rounded border border-[#5865F2]/40 bg-[#5865F2]/10 text-[#5865F2] text-sm font-medium hover:bg-[#5865F2]/20 cursor-pointer"
          >
            Login with Discord
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Navigation header */}
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <button
            onClick={() => window.history.back()}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors cursor-pointer bg-transparent border-0 p-0"
          >
            <ArrowLeft size={16} />
            Back
          </button>
          <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
            <Home size={16} />
            Home
          </Link>
        </div>
      </nav>

      <div className="max-w-xl mx-auto px-4 sm:px-6 py-8">
        <div className="flex items-center gap-2 mb-6">
          <Users size={20} className="text-neon-cyan" />
          <h1 className="font-display text-xl font-bold">Friends</h1>
        </div>

        {/* Add friend */}
        <div className="bg-surface border border-border rounded-lg p-4 mb-6">
          <label className="text-xs text-muted block mb-2">Add a friend by their username</label>
          <div className="flex gap-2">
            <input
              value={username}
              onChange={e => { setUsername(e.target.value); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && addFriend()}
              placeholder="Username..."
              className="flex-1 bg-raised border border-border rounded px-3 py-2 text-sm text-primary"
            />
            <button
              onClick={addFriend}
              disabled={adding || !username.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/40 rounded text-sm font-medium hover:bg-neon-cyan/30 cursor-pointer disabled:opacity-50"
            >
              <UserPlus size={14} />
              Add
            </button>
          </div>
          {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
        </div>

        {/* Friends list */}
        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : friends.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted">No friends added yet.</p>
            <p className="text-xs text-faint mt-1">Add friends to see their scores in your lobby feed.</p>
          </div>
        ) : (
          <div className="bg-surface border border-border rounded-lg divide-y divide-border/30">
            {friends.map(f => (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                {/* Avatar */}
                {f.avatar_hash && f.friend_user_id ? (
                  <img
                    src={`https://cdn.discordapp.com/avatars/${f.friend_user_id}/${f.avatar_hash}.webp?size=64`}
                    alt=""
                    className="w-8 h-8 rounded-full border border-border"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-neon-cyan/10 border border-border flex items-center justify-center text-[10px] font-bold text-neon-cyan">
                    {(f.friend_discord_username || f.iscored_username || '?').charAt(0).toUpperCase()}
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-primary truncate">
                    {f.iscored_username || f.friend_discord_username || f.friend_user_id}
                  </p>
                  {f.friend_discord_username && f.iscored_username && f.friend_discord_username !== f.iscored_username && (
                    <p className="text-[10px] text-faint truncate">{f.friend_discord_username}</p>
                  )}
                </div>

                {/* Remove */}
                <button
                  onClick={() => removeFriend(f.friend_user_id)}
                  className="text-neon-magenta/50 hover:text-neon-magenta cursor-pointer bg-transparent border-0 p-1"
                  title="Remove friend"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
