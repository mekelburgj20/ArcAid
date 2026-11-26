import { useMemo, useState } from 'react';
import { Building2 } from 'lucide-react';
import { useViewerAuth, usePlayerHeaders } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import ArcaidPage from '../components/parts/ArcaidPage';
import Panel, { PanelGroup } from '../components/parts/Panel';
import Button from '../components/parts/Button';
import { TextInput, TextArea } from '../components/parts/Field';

const SLUG_PATTERN = /^[a-z0-9_]+$/;

/** Lowercase, spaces/invalid chars -> underscore. Mirrors the server's
 * PublicCreateRoomSchema regex (^[a-z0-9_]+$) so the live preview never
 * shows a slug the server would reject. */
function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export default function CreateRoom() {
  const { discordUser, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  const playerHeaders = usePlayerHeaders();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState('');

  const effectiveSlug = slugTouched ? slug : slugify(name);
  const slugValid = effectiveSlug.length > 0 && SLUG_PATTERN.test(effectiveSlug);

  const canSubmit = useMemo(
    () => name.trim().length > 0 && slugValid && !submitting && !redirecting,
    [name, slugValid, submitting, redirecting],
  );

  if (!discordUser) {
    return (
      <ArcaidPage title="Create a Game Room" bare>
        <div className="text-center max-w-sm px-4">
          <Building2 size={40} className="text-muted/30 mx-auto mb-3" />
          <h1 className="text-xl font-bold mb-2">Create a Game Room</h1>
          <p className="text-muted mb-4">
            Log in to create your own game room. You'll automatically become its admin.
          </p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__createroom__', '/create-room')}
            onGoogleLogin={() => loginWithGoogle('__createroom__', '/create-room')}
            label="Sign in"
            className="justify-center"
          />
        </div>
      </ArcaidPage>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...playerHeaders },
        body: JSON.stringify({
          name: name.trim(),
          slug: effectiveSlug,
          description: description.trim(),
          is_public: isPublic,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 409) {
          setError('That URL is taken. Try a different one.');
        } else if (res.status === 403) {
          setError(data.error || 'Room creation is not available right now.');
        } else if (res.status === 400) {
          setError(data.error || 'Please check the form and try again.');
        } else if (res.status === 401) {
          setError('Your session expired. Please sign in again.');
        } else {
          setError('Something went wrong. Please try again.');
        }
        setSubmitting(false);
        return;
      }

      // Post-create: hop through the EXISTING room-admin Discord OAuth flow
      // (bare-slug state, same as RoomLogin.tsx's handleDiscordLogin) so
      // DiscordCallback.tsx mints a room_admin token and lands the new owner
      // on their room's admin dashboard. loginWithDiscord() can't be reused
      // here — it always encodes state as `player:<slug>`, which
      // DiscordCallback routes back to the public /lobby page, not the admin
      // dashboard. Replicated locally per the contract rather than touching
      // shared auth code. Since the Discord session is already authorized
      // (the user just signed in above), this hop is effectively instant.
      setSubmitting(false);
      setRedirecting(true);
      const roomSlug: string = data.room.slug;
      const discordRes = await fetch('/api/auth/discord');
      const { clientId } = await discordRes.json();
      if (!clientId) {
        setError('Room created, but Discord login is unavailable. Visit /' + roomSlug + '/login to sign in.');
        setRedirecting(false);
        return;
      }
      const redirectUri = `${window.location.origin}/auth/discord/callback`;
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: roomSlug,
        // See ViewerAuthContext — Discord re-prompts for authorization on every
        // sign-in without this. Login flows only; never the account-link flow.
        prompt: 'none',
      });
      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <ArcaidPage title="Create a Game Room" width="column">
      <PanelGroup
        id="create-room"
        tone="cyan"
        title="New room"
        sub="Your room starts web-only, with no Discord bot or iScored board attached. You can connect Discord and iScored later in the room's Settings."
      >
        <Panel wide title="Room details">
          {redirecting ? (
            <p className="text-sm text-muted py-6" role="status">Room created. Signing you in as its admin…</p>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <TextInput
                id="room-name"
                label="Room name"
                placeholder="e.g. Joe's Arcade"
                value={name}
                onChange={e => setName(e.target.value)}
                autoFocus
                maxLength={100}
              />

              <TextInput
                id="room-slug"
                label="Web address"
                hint={`${window.location.origin}/${effectiveSlug || 'your_room'}`}
                placeholder="joes_arcade"
                value={effectiveSlug}
                onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                maxLength={50}
                error={effectiveSlug.length > 0 && !slugValid ? 'Lowercase letters, numbers, and underscores only.' : undefined}
              />

              <TextArea
                id="room-desc"
                label="Description"
                optional
                rows={3}
                maxLength={500}
                placeholder="What's this room about?"
                value={description}
                onChange={e => setDescription(e.target.value)}
              />

              <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
                <input
                  type="checkbox"
                  checked={isPublic}
                  onChange={e => setIsPublic(e.target.checked)}
                  className="accent-neon-cyan"
                />
                List this room on the landing page
              </label>

              {error && <p className="text-sm ink-danger" role="alert">{error}</p>}

              <Button type="submit" className="self-start" disabled={!canSubmit}>
                {submitting ? 'Creating…' : 'Create Room'}
              </Button>
            </form>
          )}
        </Panel>
      </PanelGroup>
    </ArcaidPage>
  );
}
