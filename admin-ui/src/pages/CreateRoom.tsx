import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ArrowLeft, Home } from 'lucide-react';
import { useViewerAuth, usePlayerHeaders } from '../contexts/ViewerAuthContext';
import NeonButton from '../components/NeonButton';
import LoginButtons from '../components/LoginButtons';

const inputClass = "w-full px-4 py-3 bg-raised border border-border rounded text-primary placeholder-faint focus:outline-none focus:border-neon-cyan transition-colors";

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
      <div className="min-h-screen bg-deep flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <Building2 size={40} className="text-muted/30 mx-auto mb-3" />
          <h1 className="font-display text-xl font-bold mb-2">Create a Game Room</h1>
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
      </div>
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
      });
      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-deep text-primary">
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
        <div className="flex items-center gap-2 mb-2">
          <Building2 size={20} className="text-neon-cyan" />
          <h1 className="font-display text-xl font-bold">Create a Game Room</h1>
        </div>
        <p className="text-sm text-muted mb-6">
          Your room starts web-only, with no Discord bot or iScored board attached.
          You can connect Discord and iScored later in the room's Settings.
        </p>

        {redirecting ? (
          <div className="flex flex-col items-center gap-3 py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
            <p className="text-muted text-sm">Room created — signing you in as its admin...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-faint mb-1.5">Room Name</label>
              <input
                type="text"
                placeholder="e.g. Joe's Arcade"
                value={name}
                onChange={e => setName(e.target.value)}
                className={inputClass}
                autoFocus
                maxLength={100}
              />
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-faint mb-1.5">URL Slug</label>
              <div className="flex items-center gap-1 mb-1.5 text-xs text-faint">
                <span>{window.location.origin}/</span>
              </div>
              <input
                type="text"
                placeholder="joes_arcade"
                value={effectiveSlug}
                onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
                className={inputClass}
                maxLength={50}
              />
              {effectiveSlug.length > 0 && !slugValid && (
                <p className="text-xs text-neon-magenta mt-1.5">
                  Lowercase letters, numbers, and underscores only.
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs uppercase tracking-wider text-faint mb-1.5">Description (optional)</label>
              <textarea
                placeholder="What's this room about?"
                value={description}
                onChange={e => setDescription(e.target.value)}
                className={`${inputClass} resize-none`}
                rows={3}
                maxLength={500}
              />
            </div>

            <label className="flex items-center gap-2 text-sm text-muted cursor-pointer">
              <input
                type="checkbox"
                checked={isPublic}
                onChange={e => setIsPublic(e.target.checked)}
                className="accent-neon-cyan"
              />
              List this room on the landing page
            </label>

            {error && <p className="text-neon-magenta text-sm">{error}</p>}

            <NeonButton type="submit" disabled={!canSubmit}>
              {submitting ? 'Creating...' : 'Create Room'}
            </NeonButton>
          </form>
        )}
      </div>
    </div>
  );
}
