import { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import LoadFailedNotice from '../components/LoadFailedNotice';
import ArcaidPage from '../components/parts/ArcaidPage';
import Panel, { PanelGroup } from '../components/parts/Panel';
import Button from '../components/parts/Button';
import { TextInput } from '../components/parts/Field';
import { ListRows, ListRow } from '../components/parts/ListRow';
import { SkeletonRows } from '../components/parts/Skeleton';
import EmptyState from '../components/parts/EmptyState';
import { useRetryingLoad } from '../hooks/useRetryingLoad';
import { resolveAvatarUrl } from '../lib/avatar';

interface Friend {
  id: string;
  friend_user_id: string;
  friend_discord_username: string | null;
  iscored_username: string | null;
  /** v2.8.0: friend's chosen global display name. */
  display_name: string | null;
  avatar_hash: string | null;
  /** v2.35.0: full avatar URL for Google-identified friends. */
  avatar_url: string | null;
  created_at: string;
}

function friendName(f: Friend): string {
  return f.display_name || f.iscored_username || f.friend_discord_username || f.friend_user_id;
}

/** The avatar, or the name's first letter when there is none or it does not load. */
function FriendTile({ friend }: { friend: Friend }) {
  const [broken, setBroken] = useState(false);
  const url = resolveAvatarUrl(friend.friend_user_id, friend.avatar_url ?? friend.avatar_hash);
  if (url && !broken) return <img src={url} alt="" onError={() => setBroken(true)} />;
  return <>{friendName(friend).charAt(0).toUpperCase()}</>;
}

export default function Friends() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [username, setUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const authHeaders: Record<string, string> = playerToken
    ? { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };

  // A load that fails for now tries again by itself; the empty text waits for an answer (G31).
  const { load, phase } = useRetryingLoad(
    () => fetch('/api/me/friends', { headers: { Authorization: `Bearer ${playerToken}` } }),
    async res => {
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error('shape');
      setFriends(body);
    },
    playerToken,
  );
  useEffect(() => { if (playerToken) load(); }, [playerToken, load]);

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
        load();
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
    load();
  };

  if (!discordUser) {
    return (
      <ArcaidPage title="Friends" bare>
        <div className="text-center px-6">
          <Users size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to manage your friends list</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__friends__')}
            onGoogleLogin={() => loginWithGoogle('__friends__')}
            className="justify-center"
          />
        </div>
      </ArcaidPage>
    );
  }

  const noAnswerYet = phase !== 'ready' && friends.length === 0;

  return (
    <ArcaidPage title="Friends" width="column">
      <PanelGroup id="friends-add" tone="cyan" title="Add a friend">
        <Panel wide title="By username">
          <div className="flex flex-col sm:flex-row sm:items-end gap-2">
            <TextInput
              id="friend-username"
              label="Their username"
              placeholder="Username"
              className="flex-1 min-w-0"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(''); }}
              onKeyDown={e => e.key === 'Enter' && addFriend()}
              error={error || undefined}
            />
            <Button className="self-start sm:self-auto min-h-11" onClick={addFriend} disabled={adding || !username.trim()}>Add</Button>
          </div>
        </Panel>
      </PanelGroup>

      <PanelGroup id="friends-list" tone="pink" title="Your friends" sub="Their scores show in your lobby feed.">
        <Panel wide title={`Friends (${friends.length})`}>
          {noAnswerYet ? (
            phase === 'retrying'
              ? <LoadFailedNotice what="your friends" onRetry={load} className="py-8" />
              : <SkeletonRows count={3} label="Loading your friends" />
          ) : friends.length === 0 ? (
            <EmptyState title="No friends added yet." tone="pink">
              Add a friend above by their username to see their scores in your lobby feed.
            </EmptyState>
          ) : (
            <ListRows label="Your friends">
              {friends.map(f => {
                const name = friendName(f);
                return (
                  <ListRow
                    key={f.id}
                    name={name}
                    tile={<FriendTile friend={f} />}
                    caption={f.friend_discord_username && f.iscored_username && f.friend_discord_username !== f.iscored_username
                      ? f.friend_discord_username
                      : undefined}
                    trailing={
                      <Button variant="secondary" size="xs" aria-label={`Remove ${name}`} onClick={() => removeFriend(f.friend_user_id)}>
                        Remove
                      </Button>
                    }
                  />
                );
              })}
            </ListRows>
          )}
        </Panel>
      </PanelGroup>
    </ArcaidPage>
  );
}
