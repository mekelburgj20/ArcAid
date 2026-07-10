import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, User as UserIcon, CheckCircle2, AlertCircle, AlertTriangle, Trash2 } from 'lucide-react';
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

const NOTIF_TYPES: { key: string; label: string; helper: string }[] = [
  { key: 'tournamentWin', label: 'Tournament Win', helper: 'When you win a tournament.' },
  { key: 'turnToPick', label: 'Turn to Pick', helper: "When it's your turn to pick the next game." },
  { key: 'tournamentStarting', label: 'Tournament Starting', helper: 'When a tournament you can join is about to begin.' },
  { key: 'rankDethroned', label: 'Rank Dethroned', helper: 'When someone knocks you off a #1 spot.' },
  { key: 'friendScore', label: 'Friend Score', helper: 'When a player you follow posts a new score.' },
];

export default function AccountSettings() {
  const { discordUser, playerToken, loginWithDiscord, logoutPlayer } = useViewerAuth();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<number | null>(null);

  // Delete-account (danger zone): type-to-confirm modal + player-token DELETE.
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const backdropMouseDown = useRef(false);

  // Notification preferences (independent fetch from the profile load)
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [draftPrefs, setDraftPrefs] = useState<Record<string, boolean> | null>(null);
  const [notifLoading, setNotifLoading] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaveError, setNotifSaveError] = useState<string | null>(null);
  const [notifSaved, setNotifSaved] = useState(false);

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

  const loadPrefs = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/me/notification-preferences', {
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, boolean>;
        setPrefs(data);
        setDraftPrefs(data);
      }
    } catch {
      // network error — section stays empty
    }
    setNotifLoading(false);
  }, [playerToken]);

  useEffect(() => { loadPrefs(); }, [loadPrefs]);

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

  const toggle = (key: string) => {
    setDraftPrefs(p => ({ ...(p ?? {}), [key]: !(p?.[key] === true) }));
    setNotifSaveError(null);
    setNotifSaved(false);
  };

  const notifDirty = !!prefs && !!draftPrefs && JSON.stringify(prefs) !== JSON.stringify(draftPrefs);

  const savePrefs = async () => {
    if (!playerToken || !draftPrefs) return;
    setNotifSaving(true);
    setNotifSaveError(null);
    setNotifSaved(false);
    try {
      const res = await fetch('/api/me/notification-preferences', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(draftPrefs),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, boolean>;
        setPrefs(data);
        setDraftPrefs(data);
        setNotifSaved(true);
        window.setTimeout(() => setNotifSaved(false), 2200);
      } else {
        const d = await res.json().catch(() => ({}));
        setNotifSaveError(d.error ?? 'Failed to save.');
      }
    } catch {
      setNotifSaveError('Network error.');
    }
    setNotifSaving(false);
  };

  const closeDeleteModal = () => {
    if (deleting) return;
    setShowDeleteModal(false);
    setConfirmText('');
    setDeleteError(null);
  };

  const deleteAccount = async () => {
    // Raw fetch with the PLAYER token on purpose: lib/api.ts authenticates with
    // the admin token and, on 401, refreshes the admin session and redirects to
    // /login — the wrong realm for a Discord player. See ViewerAuthContext.
    if (!playerToken || confirmText.trim() !== 'DELETE') return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch('/api/me/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        // Sessions are revoked server-side; drop the local player session + the
        // device anon id, then leave the (now anonymized) account behind.
        logoutPlayer();
        localStorage.removeItem('arcaid_anon_id');
        navigate('/');
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setDeleteError(
          data.error ??
            'You are the only super admin. Transfer that role before deleting your account.',
        );
      } else if (res.status === 401) {
        setDeleteError('Your session expired. Please log in again.');
      } else {
        setDeleteError(data.error ?? 'Could not delete your account. Please try again.');
      }
    } catch {
      setDeleteError('Network error. Please try again.');
    }
    setDeleting(false);
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

            <section className="mt-8 pt-8 border-t border-border">
              <h2 className="text-sm font-medium mb-2">Notifications</h2>
              <p className="text-xs text-muted mb-4">
                You'll receive a Discord DM when an enabled event happens. All types are off until you turn them on.
              </p>
              {notifLoading ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : (
                <>
                  <div>
                    {NOTIF_TYPES.map(({ key, label, helper }) => {
                      const checked = draftPrefs?.[key] === true;
                      return (
                        <label
                          key={key}
                          className="flex items-start justify-between gap-3 py-2.5 border-b border-border last:border-b-0 cursor-pointer"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm text-primary">{label}</span>
                            <span className="block text-xs text-faint">{helper}</span>
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={checked}
                            onClick={() => toggle(key)}
                            className={`shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors ${checked ? 'bg-neon-cyan/30 border-neon-cyan/50' : 'bg-surface border-border'}`}
                          >
                            <span
                              className={`block w-4 h-4 rounded-full bg-primary transition-transform ${checked ? 'translate-x-4' : 'translate-x-0.5'}`}
                              style={{ marginTop: '1px' }}
                            />
                          </button>
                        </label>
                      );
                    })}
                  </div>
                  {notifSaveError && (
                    <p className="mt-2 text-xs text-rose-400 inline-flex items-center gap-1">
                      <AlertCircle size={12} /> {notifSaveError}
                    </p>
                  )}
                  {notifSaved && (
                    <p className="mt-2 text-xs text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 size={12} /> Saved.
                    </p>
                  )}
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={savePrefs}
                      disabled={notifSaving || !notifDirty}
                      className="px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    >
                      {notifSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="mt-8 pt-8 border-t border-border">
              <h2 className="text-sm font-medium mb-2 inline-flex items-center gap-1.5 text-rose-400">
                <AlertTriangle size={14} /> Danger zone
              </h2>
              <p className="text-xs text-muted mb-1.5">
                Deleting your account removes your profile, avatar, chosen display name,
                proof photos, comments, ratings, and friends, and unlinks your Discord login.
              </p>
              <p className="text-xs text-muted mb-4">
                Your scores stay on the leaderboards under your game handle, but they're
                de-identified — no longer tied to your Discord account. This can't be undone.
              </p>
              <button
                type="button"
                onClick={() => { setConfirmText(''); setDeleteError(null); setShowDeleteModal(true); }}
                className="px-4 py-1.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-400 text-sm font-medium hover:bg-rose-500/20 hover:text-neon-magenta transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <Trash2 size={14} /> Delete my account
              </button>
            </section>
          </>
        )}
      </main>

      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4"
          onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
          onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) closeDeleteModal(); }}
        >
          <div
            className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-md p-6"
            onClick={e => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold mb-2 inline-flex items-center gap-2 text-rose-400">
              <AlertTriangle size={18} /> Delete your account?
            </h2>
            <p className="text-sm text-muted mb-3">
              This permanently removes your profile, avatar, display name, proof photos,
              comments, ratings, and friends, and unlinks Discord. Your scores stay on the
              leaderboards under your handle but are de-identified. This can't be undone.
            </p>
            <label htmlFor="delete-confirm" className="block text-xs text-muted mb-1.5">
              Type <span className="font-mono font-semibold text-primary">DELETE</span> to confirm.
            </label>
            <input
              id="delete-confirm"
              type="text"
              autoFocus
              value={confirmText}
              onChange={e => { setConfirmText(e.target.value); setDeleteError(null); }}
              placeholder="DELETE"
              className="w-full bg-deep border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:border-rose-500 focus:outline-none"
            />
            {deleteError && (
              <p className="mt-2 text-xs text-rose-400 inline-flex items-center gap-1">
                <AlertCircle size={12} /> {deleteError}
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={deleting}
                className="px-3 py-1.5 rounded border border-border text-sm text-muted hover:text-primary hover:border-muted disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer bg-transparent"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={deleteAccount}
                disabled={deleting || confirmText.trim() !== 'DELETE'}
                className="px-4 py-1.5 rounded border border-rose-500/50 bg-rose-500/15 text-rose-400 text-sm font-medium hover:bg-rose-500/25 hover:text-neon-magenta disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
              >
                {deleting ? 'Deleting…' : <><Trash2 size={14} /> Delete account</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
