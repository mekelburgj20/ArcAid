import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Home, User as UserIcon, CheckCircle2, AlertCircle } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

interface Profile {
  discord_user_id: string;
  display_name: string | null;
  avatar_hash: string | null;
  avatar_fetched_at: string | null;
  aliases: string[];
}

type AvailabilityState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'unavailable'; reason: string };

const REASON_COPY: Record<string, string> = {
  too_short: 'Display name must be at least 2 characters.',
  too_long: 'Display name must be 32 characters or fewer.',
  invalid_chars: 'Letters, numbers, spaces, and `_ - .` only.',
  taken_display: 'Someone else has already taken this display name.',
  taken_alias: 'This name is in use as another player\'s iScored alias.',
};

export default function AccountSettings() {
  const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<number | null>(null);

  const loadProfile = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/users/me/profile', {
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        const data = (await res.json()) as Profile;
        setProfile(data);
        setDraft(data.display_name ?? '');
      }
    } catch {
      // network error — surface via empty state
    }
    setLoading(false);
  }, [playerToken]);

  useEffect(() => { loadProfile(); }, [loadProfile]);

  // Debounced availability check
  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (!playerToken) return;
    const trimmed = draft.trim();
    if (trimmed === '' || trimmed === (profile?.display_name ?? '')) {
      setAvailability({ status: 'idle' });
      return;
    }
    setAvailability({ status: 'checking' });
    debounceRef.current = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/users/me/profile/check-display-name?name=${encodeURIComponent(trimmed)}`,
          { headers: { Authorization: `Bearer ${playerToken}` } },
        );
        if (!res.ok) {
          setAvailability({ status: 'idle' });
          return;
        }
        const data = await res.json();
        if (data.available) setAvailability({ status: 'available' });
        else setAvailability({ status: 'unavailable', reason: data.reason || 'taken_display' });
      } catch {
        setAvailability({ status: 'idle' });
      }
    }, 350);
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
    };
  }, [draft, playerToken, profile?.display_name]);

  const save = async () => {
    if (!playerToken) return;
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    try {
      const trimmed = draft.trim();
      const body = JSON.stringify({ display_name: trimmed === '' ? null : trimmed });
      const res = await fetch('/api/users/me/profile', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
        body,
      });
      if (res.ok) {
        const data = await res.json();
        setProfile(p => (p ? { ...p, display_name: data.display_name } : p));
        setSaveSuccess(true);
        window.setTimeout(() => setSaveSuccess(false), 2200);
      } else if (res.status === 409) {
        const data = await res.json().catch(() => ({}));
        setSaveError(REASON_COPY[data.reason] ?? data.error ?? 'That display name is not available.');
      } else {
        const data = await res.json().catch(() => ({}));
        setSaveError(data.error ?? 'Failed to save.');
      }
    } catch {
      setSaveError('Network error.');
    }
    setSaving(false);
  };

  if (!discordUser) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center px-6">
          <UserIcon size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in with Discord to manage your account.</p>
          <button
            onClick={() => loginWithDiscord('__account__', '/account/settings')}
            className="px-4 py-2 rounded border border-[#5865F2]/40 bg-[#5865F2]/10 text-[#5865F2] text-sm font-medium hover:bg-[#5865F2]/20 cursor-pointer"
          >
            Login
          </button>
        </div>
      </div>
    );
  }

  const avatarUrl = profile?.avatar_hash
    ? `https://cdn.discordapp.com/avatars/${profile.discord_user_id}/${profile.avatar_hash}.png?size=128`
    : null;

  const draftTrimmed = draft.trim();
  const isUnchanged = draftTrimmed === (profile?.display_name ?? '');
  const canSubmit = !saving && !isUnchanged && (draftTrimmed === '' || availability.status === 'available');

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

      <main className="max-w-xl mx-auto px-4 sm:px-6 py-6">
        <h1 className="text-xl font-semibold mb-1">Account settings</h1>
        <p className="text-sm text-muted mb-6">
          Your display name appears on every leaderboard, announcement, and notification across ArcAid.
        </p>

        {loading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            <section className="mb-8 flex items-center gap-4">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  className="w-16 h-16 rounded-full border border-border"
                />
              ) : (
                <div className="w-16 h-16 rounded-full bg-neon-cyan/20 border border-border flex items-center justify-center text-xl font-bold text-neon-cyan">
                  {(profile?.display_name ?? discordUser.username).charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <p className="text-base font-medium">{profile?.display_name ?? discordUser.username}</p>
                <p className="text-xs text-faint">Avatar comes from your Discord profile.</p>
              </div>
            </section>

            <section className="mb-8">
              <label htmlFor="display-name" className="block text-sm font-medium mb-1.5">
                Display name
              </label>
              <input
                id="display-name"
                type="text"
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setSaveError(null); setSaveSuccess(false); }}
                maxLength={32}
                placeholder="Pick a name (2–32 characters)"
                className="w-full bg-surface border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-neon-cyan focus:outline-none"
              />
              <div className="mt-1.5 min-h-[1.25rem] text-xs">
                {availability.status === 'checking' && <span className="text-muted">Checking…</span>}
                {availability.status === 'available' && (
                  <span className="text-emerald-400 inline-flex items-center gap-1">
                    <CheckCircle2 size={12} /> Available
                  </span>
                )}
                {availability.status === 'unavailable' && (
                  <span className="text-amber-400 inline-flex items-center gap-1">
                    <AlertCircle size={12} /> {REASON_COPY[availability.reason] ?? 'Not available.'}
                  </span>
                )}
              </div>
              {saveError && (
                <p className="mt-2 text-xs text-rose-400 inline-flex items-center gap-1">
                  <AlertCircle size={12} /> {saveError}
                </p>
              )}
              {saveSuccess && (
                <p className="mt-2 text-xs text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 size={12} /> Saved.
                </p>
              )}
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={save}
                  disabled={!canSubmit}
                  className="px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {profile?.display_name && (
                  <button
                    type="button"
                    onClick={() => { setDraft(''); }}
                    disabled={saving}
                    className="px-3 py-1.5 rounded border border-border text-sm text-muted hover:text-primary hover:border-muted disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer bg-transparent"
                  >
                    Clear
                  </button>
                )}
              </div>
            </section>

            <section>
              <h2 className="text-sm font-medium mb-2">Linked iScored aliases</h2>
              {profile && profile.aliases.length > 0 ? (
                <ul className="space-y-1">
                  {profile.aliases.map(alias => (
                    <li
                      key={alias}
                      className="text-sm font-mono text-primary bg-surface border border-border rounded px-3 py-1.5"
                    >
                      {alias}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">
                  No aliases yet. Submit a score on iScored under any name and a room admin can link it to you.
                </p>
              )}
              <p className="mt-2 text-xs text-faint">
                Scores submitted under any of these names count for you on every leaderboard.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
