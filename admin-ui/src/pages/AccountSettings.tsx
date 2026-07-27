import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, User as UserIcon, CheckCircle2, AlertCircle, AlertTriangle, Trash2, Link2, Unlink } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import { resolveAvatarUrl } from '../lib/avatar';
import { isGoogleUserId } from '../lib/identityProvider';
import { buildPushErrorMessage } from '../lib/pushError';

interface Profile {
  discord_user_id: string;
  display_name: string | null;
  avatar_hash: string | null;
  avatar_url: string | null;
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

// PushManager.subscribe wants the VAPID public key as raw bytes, but the
// server hands out the standard base64url string — decode it.
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

export default function AccountSettings() {
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
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

  // Connected accounts (v2.36.0 — Google<->Discord identity linking).
  // A google:*-identity viewer sees a "Link Discord account" button; a
  // Discord-identity (canonical) viewer sees whichever google identities are
  // currently linked to them, with an unlink option each.
  const isGoogleIdentity = isGoogleUserId(discordUser?.discordId);
  const [links, setLinks] = useState<{ provider_user_id: string; created_at: string }[] | null>(null);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linkStarting, setLinkStarting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  // Notification preferences (independent fetch from the profile load)
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [draftPrefs, setDraftPrefs] = useState<Record<string, boolean> | null>(null);
  const [notifLoading, setNotifLoading] = useState(true);
  const [notifSaving, setNotifSaving] = useState(false);
  const [notifSaveError, setNotifSaveError] = useState<string | null>(null);
  const [notifSaved, setNotifSaved] = useState(false);

  // Browser push (S15): device-level subscription state. vapidKey null =
  // push not configured on this server → the whole sub-block stays hidden.
  const [vapidKey, setVapidKey] = useState<string | null>(null);
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

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

  // Only a Discord-identity (canonical) viewer can HAVE links pointing at
  // them in v1 — a google identity is always the link's provider side, never
  // its canonical side, so skip the fetch entirely for that case.
  const loadLinks = useCallback(async () => {
    if (!playerToken || isGoogleIdentity) { setLinksLoading(false); return; }
    try {
      const res = await fetch('/api/auth/link/discord', {
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        setLinks(data.links ?? []);
      }
    } catch {
      // network error — section stays empty
    }
    setLinksLoading(false);
  }, [playerToken, isGoogleIdentity]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  // v2.46.0 (mirror-link contract) — Discord-identity viewer starts a
  // Discord->Google link. Deliberate near-duplicate of startDiscordLink
  // below (same precedent the original noted: mirrors ViewerAuthContext's
  // OAuth-URL construction rather than a shared helper), only the endpoint,
  // provider client-id lookup, authorize URL/scope, and redirect path differ.
  const startGoogleLink = async () => {
    if (!playerToken || linkStarting) return;
    setLinkStarting(true);
    setLinkError(null);
    try {
      const res = await fetch('/api/auth/link/google/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLinkError(data.error ?? 'Could not start the link. Please try again.');
        setLinkStarting(false);
        return;
      }
      sessionStorage.setItem('arcaid_link_nonce', data.nonce);
      const clientRes = await fetch('/api/auth/google');
      const clientData = await clientRes.json();
      if (!clientData.clientId) {
        setLinkError('Google login is not configured on this server.');
        setLinkStarting(false);
        return;
      }
      const redirectUri = `${window.location.origin}/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: clientData.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state: `link:${data.nonce}`,
        // Fix 3 (adversarial review) — force Google's account chooser on
        // link flows only. Without this, a browser already signed into a
        // single Google account skips the chooser and silently links
        // whichever account is active — easy to link the wrong one on a
        // shared/kiosk machine. Normal login (ViewerAuthContext.loginWithGoogle)
        // is unchanged.
        prompt: 'select_account',
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } catch {
      setLinkError('Network error. Please try again.');
      setLinkStarting(false);
    }
  };

  const startDiscordLink = async () => {
    if (!playerToken || linkStarting) return;
    setLinkStarting(true);
    setLinkError(null);
    try {
      const res = await fetch('/api/auth/link/discord/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLinkError(data.error ?? 'Could not start the link. Please try again.');
        setLinkStarting(false);
        return;
      }
      // Mirrors ViewerAuthContext.loginWithDiscord's OAuth-URL construction
      // (deliberate near-duplicate, same precedent as GoogleCallback/
      // DiscordCallback) but with a `link:<nonce>` state instead of
      // `player:<slug>` — the nonce proves this same browser session started
      // the link when DiscordCallback posts it back explicitly.
      sessionStorage.setItem('arcaid_link_nonce', data.nonce);
      const clientRes = await fetch('/api/auth/discord');
      const clientData = await clientRes.json();
      if (!clientData.clientId) {
        setLinkError('Discord login is not configured on this server.');
        setLinkStarting(false);
        return;
      }
      const redirectUri = `${window.location.origin}/auth/discord/callback`;
      const params = new URLSearchParams({
        client_id: clientData.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'identify',
        state: `link:${data.nonce}`,
      });
      window.location.href = `https://discord.com/api/oauth2/authorize?${params}`;
    } catch {
      setLinkError('Network error. Please try again.');
      setLinkStarting(false);
    }
  };

  const confirmUnlink = async () => {
    if (!playerToken || !unlinkTarget) return;
    setUnlinking(true);
    try {
      const res = await fetch(`/api/auth/link/discord/${encodeURIComponent(unlinkTarget)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        setLinks(prev => (prev ?? []).filter(l => l.provider_user_id !== unlinkTarget));
      }
    } catch {
      // best-effort — the row stays listed, user can retry
    }
    setUnlinking(false);
    setUnlinkTarget(null);
  };

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

  // Browser push: server VAPID config + this device's current subscription.
  useEffect(() => {
    fetch('/api/push/vapid-public-key')
      .then(r => (r.ok ? r.json() : { key: null }))
      .then(d => setVapidKey(d?.key ?? null))
      .catch(() => setVapidKey(null));
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then(reg => reg.pushManager.getSubscription())
      .then(sub => {
        setPushSubscribed(!!sub);
        // Re-register the device's existing subscription under the CURRENT
        // account (the server upsert is endpoint-keyed). After an account
        // switch on a shared browser, the row would otherwise keep pointing
        // at the previous user — their alerts popping on this device, the
        // new user's never arriving, and unsubscribe deleting nothing.
        const keys = sub?.toJSON().keys;
        if (sub && keys?.p256dh && keys?.auth && playerToken) {
          fetch('/api/me/push-subscriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [pushSupported, playerToken]);

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

  // Browser push: subscribe/unsubscribe THIS device. Subscribing also flips
  // the server-side webPush channel flag (merged into notification_prefs by
  // POST /me/push-subscriptions); we mirror it into local prefs state so a
  // later Save of the draft can't clobber it.
  const togglePush = async () => {
    if (!playerToken || !vapidKey || pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      if (pushSubscribed) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/me/push-subscriptions', {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          }).catch(() => {});
          await sub.unsubscribe().catch(() => {});
        }
        setPushSubscribed(false);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setPushError(
            permission === 'denied'
              ? 'Notifications are blocked for this site. Enable them in your browser settings, then try again.'
              : 'Notification permission was not granted.'
          );
          return;
        }
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidKey),
        });
        const keys = sub.toJSON().keys;
        if (!keys?.p256dh || !keys?.auth) {
          await sub.unsubscribe().catch(() => {});
          throw new Error('Browser returned an incomplete subscription.');
        }
        const res = await fetch('/api/me/push-subscriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
        });
        if (!res.ok) {
          await sub.unsubscribe().catch(() => {});
          throw new Error('The server rejected the subscription.');
        }
        setPrefs(p => ({ ...(p ?? {}), webPush: true }));
        setDraftPrefs(p => ({ ...(p ?? {}), webPush: true }));
        setPushSubscribed(true);
      }
    } catch (e) {
      // v2.37.0 — Brave's push relay silently rejects subscribe() even with
      // permission already granted; append a Brave-aware hint for that
      // failure class rather than leaving the user with a bare AbortError.
      setPushError(buildPushErrorMessage(e, Notification.permission));
    } finally {
      setPushBusy(false);
    }
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
          <p className="text-muted mb-4">Log in to manage your account.</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__account__', '/account/settings')}
            onGoogleLogin={() => loginWithGoogle('__account__', '/account/settings')}
            className="justify-center"
          />
        </div>
      </div>
    );
  }

  const avatarUrl = resolveAvatarUrl(profile?.discord_user_id, profile?.avatar_url ?? profile?.avatar_hash ?? null);

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
              <h2 className="text-sm font-medium mb-2">Connected accounts</h2>
              {isGoogleIdentity ? (
                <>
                  <p className="text-xs text-muted mb-3">
                    You're signed in with Google. Link a Discord account to get DM
                    notifications and tournament picks — both logins will work for the
                    same account afterward.
                  </p>
                  {linkError && (
                    <p className="mb-2 text-xs text-rose-400 inline-flex items-center gap-1">
                      <AlertCircle size={12} /> {linkError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={startDiscordLink}
                    disabled={linkStarting}
                    className="px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <Link2 size={14} /> {linkStarting ? 'Redirecting…' : 'Link Discord account'}
                  </button>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted mb-3">
                    Link a Google account so you can log in with either. Your Discord
                    login stays the source of truth for DMs and tournament picks.
                  </p>
                  {linkError && (
                    <p className="mb-2 text-xs text-rose-400 inline-flex items-center gap-1">
                      <AlertCircle size={12} /> {linkError}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={startGoogleLink}
                    disabled={linkStarting}
                    className="mb-3 px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <Link2 size={14} /> {linkStarting ? 'Redirecting…' : 'Link Google account'}
                  </button>
                  {linksLoading ? (
                    <p className="text-sm text-muted">Loading…</p>
                  ) : links && links.length > 0 ? (
                    <ul className="space-y-2">
                      {links.map(l => (
                        <li
                          key={l.provider_user_id}
                          className="flex items-center justify-between gap-3 text-sm bg-surface border border-border rounded px-3 py-2"
                        >
                          <span className="font-mono text-xs text-muted truncate">{l.provider_user_id}</span>
                          {unlinkTarget === l.provider_user_id ? (
                            <span className="flex items-center gap-2 shrink-0">
                              <span className="text-[11px] text-muted hidden sm:inline">
                                Google login becomes separate.
                              </span>
                              <button
                                type="button"
                                onClick={confirmUnlink}
                                disabled={unlinking}
                                className="px-2 py-1 rounded border border-rose-500/40 text-rose-400 text-xs hover:bg-rose-500/10 disabled:opacity-50 cursor-pointer"
                              >
                                {unlinking ? '…' : 'Confirm unlink'}
                              </button>
                              <button
                                type="button"
                                onClick={() => setUnlinkTarget(null)}
                                disabled={unlinking}
                                className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-primary cursor-pointer"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setUnlinkTarget(l.provider_user_id)}
                              className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-rose-400 hover:border-rose-500/40 cursor-pointer shrink-0 inline-flex items-center gap-1"
                            >
                              <Unlink size={12} /> Unlink
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted">No linked Google accounts.</p>
                  )}
                </>
              )}
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
                  {vapidKey && (
                    <div className="mt-6 pt-4 border-t border-border">
                      <h3 className="text-sm font-medium mb-1">Browser push</h3>
                      {pushSupported ? (
                        <>
                          <label className="flex items-start justify-between gap-3 py-2.5 cursor-pointer">
                            <span className="min-w-0">
                              <span className="block text-sm text-primary">Push notifications on this device</span>
                              <span className="block text-xs text-faint">
                                Tournament Win and Rank Dethroned alerts as browser notifications, even when
                                ArcAid isn't open. Uses the matching event toggles above.
                              </span>
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={pushSubscribed}
                              disabled={pushBusy}
                              onClick={togglePush}
                              className={`shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors disabled:opacity-50 ${pushSubscribed ? 'bg-neon-cyan/30 border-neon-cyan/50' : 'bg-surface border-border'}`}
                            >
                              <span
                                className={`block w-4 h-4 rounded-full bg-primary transition-transform ${pushSubscribed ? 'translate-x-4' : 'translate-x-0.5'}`}
                                style={{ marginTop: '1px' }}
                              />
                            </button>
                          </label>
                          {pushError && (
                            <p className="mt-1 text-xs text-rose-400 inline-flex items-center gap-1">
                              <AlertCircle size={12} /> {pushError}
                            </p>
                          )}
                        </>
                      ) : (
                        <p className="text-xs text-faint">
                          Not supported in this browser. On iPhone/iPad, add ArcAid to your Home Screen
                          first, then enable push from the installed app.
                        </p>
                      )}
                    </div>
                  )}
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
