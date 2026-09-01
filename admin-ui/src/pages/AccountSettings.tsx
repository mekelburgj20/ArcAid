import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Home, User as UserIcon, CheckCircle2, AlertCircle, AlertTriangle, Trash2, Link2, Unlink } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import LoginButtons from '../components/LoginButtons';
import AppearanceControl from '../components/AppearanceControl';
import ThemePicker from '../components/ThemePicker';
import { useTheme } from '../components/ThemeProvider';
import { resolveAvatarUrl } from '../lib/avatar';
import { isGoogleUserId } from '../lib/identityProvider';
import { buildPushErrorMessage } from '../lib/pushError';
import ThrowdownsSection from '../components/ThrowdownsSection';
import GlobalSharingSection from '../components/GlobalSharingSection';

type AvatarProvider = 'discord' | 'google';

interface ClaimState {
  aliases: string[];
  aliasCount: number;
  maxAliases: number;
  pending: { id: number; iscored_username: string; requested_at: string; room_name: string | null }[];
}

interface Profile {
  discord_user_id: string;
  display_name: string | null;
  avatar_hash: string | null;
  /** The EFFECTIVE avatar url — already resolved server-side from the preference. */
  avatar_url: string | null;
  avatar_fetched_at: string | null;
  aliases: string[];
  /** The user's stored choice; null = automatic (Discord avatar when they have one, else Google). */
  avatar_preference: AvatarProvider | null;
  /** What actually renders — differs from the preference if that provider has nothing stored. */
  avatar_effective: AvatarProvider | null;
  /** Raw per-provider avatars, for rendering the picker's options. */
  avatar_discord_hash: string | null;
  avatar_google_url: string | null;
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

/**
 * Response of GET/PUT /api/me/notification-settings (v2.72.0, Discord HQ).
 *
 * `discord` is the honest-status half: a bot may DM a user only while they
 * share a server with it, so the page states whether that's true rather than
 * showing five toggles that quietly do nothing.
 */
interface NotificationSettings {
  prefs: Record<string, boolean>;
  types: string[];
  webPushTypes: string[];
  discord: {
    available: boolean;
    reachable: boolean;
    via: 'global' | 'room_guild' | null;
    viaRoomName: string | null;
    gatewayReady: boolean;
    connectAvailable: boolean;
    inviteUrl: string | null;
  };
  nudge: { failedAt: string; type?: string; reason: string } | null;
}

const NOTIF_TYPES: { key: string; label: string; helper: string }[] = [
  { key: 'tournamentWin', label: 'Tournament Win', helper: 'When you win a tournament.' },
  { key: 'turnToPick', label: 'Turn to Pick', helper: "When it's your turn to pick the next game." },
  { key: 'tournamentStarting', label: 'Tournament Starting', helper: 'When a tournament you can join is about to begin.' },
  { key: 'rankDethroned', label: 'Rank Dethroned', helper: 'When someone knocks you off a #1 spot.' },
  { key: 'friendScore', label: 'Friend Score', helper: 'When a player you follow posts a new score.' },
  { key: 'rotationReady', label: 'Rotation Ready', helper: "When you're in the running and the next rotation is about an hour away." },
  { key: 'queueLow', label: 'Queue Running Low', helper: 'When a rotation uses one of your queued picks and your queue is nearly empty.' },
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
  const { discordUser, playerToken, loginWithDiscord, loginWithGoogle, logoutPlayer, setViewerAvatar } = useViewerAuth();
  const { personalTheme, setPersonalTheme } = useTheme();
  const navigate = useNavigate();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ status: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<number | null>(null);

  // Avatar source picker (2026-08-17).
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [avatarSaved, setAvatarSaved] = useState(false);

  // iScored alias claiming (identity arc P1, 2026-08-18).
  const [claims, setClaims] = useState<ClaimState | null>(null);
  const [claimInput, setClaimInput] = useState('');
  const [claimBusy, setClaimBusy] = useState(false);
  const [claimMsg, setClaimMsg] = useState<{ ok: boolean; text: string } | null>(null);

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

  // v2.141.0 (P7 part 3) — AtGames self-link. Ownership is proven by ONE
  // sign-in; the password goes to the server, the server goes to AtGames, and
  // only the `atgames:<account id>` link row survives — no player credential
  // is ever stored (owner ruling). The linked state itself rides in the same
  // `links` list the Google section uses; these fields are only the form.
  // v2.142.0 (P8) — Arcaid Witness cabinet pairing.
  const [witnessCode, setWitnessCode] = useState<string | null>(null);
  const [witnessDevices, setWitnessDevices] = useState<{
    atgamesUniqueId: string; atgamesUsername: string | null; lastSeenAt: string | null;
    targetRoomId: string | null; targetRoomName: string | null;
    targetTournamentId: string | null; targetTournamentName: string | null;
    globalFallback: boolean;
  }[]>([]);
  const [witnessBusy, setWitnessBusy] = useState(false);
  const [witnessError, setWitnessError] = useState<string | null>(null);
  // v2.152.0 (P9b) — where each cabinet's scores go. The room list is the
  // player's own memberships; tournaments are fetched per room, on demand and
  // cached, so opening this page costs one request regardless of how many
  // rooms they belong to.
  const [witnessRooms, setWitnessRooms] = useState<{ id: string; name: string }[]>([]);
  const [witnessTournaments, setWitnessTournaments] =
    useState<Record<string, { id: string; name: string }[]>>({});
  const loadWitnessTournaments = useCallback(async (roomId: string) => {
    if (!roomId) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/tournaments`);
      if (!res.ok) return;
      const rows = await res.json();
      setWitnessTournaments(prev => ({
        ...prev,
        [roomId]: (Array.isArray(rows) ? rows : [])
          .filter((t: { is_active?: number | boolean }) => t.is_active !== 0 && t.is_active !== false)
          .map((t: { id: string; name: string }) => ({ id: t.id, name: t.name })),
      }));
    } catch { /* the picker degrades to "any tournament in this room" */ }
  }, []);
  const loadWitnessDevices = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/me/witness/devices', { headers: { Authorization: `Bearer ${playerToken}` } });
      // Coerced, not trusted: this state is now ITERATED (not just measured for
      // length), so a non-array body would take the whole page down rather than
      // render an empty list.
      const rows = res.ok ? await res.json() : [];
      const devices = Array.isArray(rows) ? rows : [];
      setWitnessDevices(devices);
      if (devices.length === 0) return;

      // The picker's two lists are loaded HERE, off the device fetch, rather
      // than from effects watching the device state — an effect that fires a
      // fetch which sets state that the effect depends on is the cascading
      // render this file's lint rule exists to prevent.
      try {
        const roomsRes = await fetch('/api/me/rooms', { headers: { Authorization: `Bearer ${playerToken}` } });
        if (roomsRes.ok) {
          const roomRows = await roomsRes.json();
          setWitnessRooms((Array.isArray(roomRows) ? roomRows : [])
            .map((r: { id: string; name: string }) => ({ id: r.id, name: r.name })));
        }
      } catch { /* the picker still shows the current designation */ }

      // Tournament lists for rooms a cabinet already points at, so the second
      // picker renders its current value on first paint rather than after a click.
      const designated = new Set(devices
        .map((d: { targetRoomId: string | null }) => d.targetRoomId)
        .filter((id: string | null): id is string => !!id));
      await Promise.all([...designated].map(roomId => loadWitnessTournaments(roomId)));
    } catch {
      setWitnessDevices([]);
    }
  }, [playerToken, loadWitnessTournaments]);
  const setWitnessTarget = useCallback(async (
    deviceId: string, patch: { roomId?: string | null; tournamentId?: string | null },
  ) => {
    if (!playerToken) return;
    setWitnessBusy(true); setWitnessError(null);
    try {
      const res = await fetch(`/api/me/witness/devices/${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Could not save');
      await loadWitnessDevices();
    } catch (err) {
      setWitnessError((err as Error).message);
    } finally {
      setWitnessBusy(false);
    }
  }, [playerToken, loadWitnessDevices]);

  const [atgamesEmail, setAtgamesEmail] = useState('');
  const [atgamesPassword, setAtgamesPassword] = useState('');
  const [atgamesBusy, setAtgamesBusy] = useState(false);
  const [atgamesError, setAtgamesError] = useState<string | null>(null);
  const [atgamesNotice, setAtgamesNotice] = useState<string | null>(null);
  const [linksLoading, setLinksLoading] = useState(true);
  const [linkStarting, setLinkStarting] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);

  // Notification preferences (independent fetch from the profile load)
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [draftPrefs, setDraftPrefs] = useState<Record<string, boolean> | null>(null);
  // v2.72.0 (Discord HQ) — the deliverability verdict + community-server
  // config that rides along with the prefs.
  const [notifSettings, setNotifSettings] = useState<NotificationSettings | null>(null);
  const [connectBusy, setConnectBusy] = useState(false);
  const [connectNotice, setConnectNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
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

  const loadClaims = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/users/me/identity/claims', {
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) setClaims(await res.json());
    } catch { /* the card simply stays hidden */ }
  }, [playerToken]);

  useEffect(() => { loadClaims(); }, [loadClaims]);

  const submitClaim = async () => {
    if (!playerToken || !claimInput.trim()) return;
    setClaimBusy(true);
    setClaimMsg(null);
    try {
      const res = await fetch('/api/users/me/identity/claims', {
        method: 'POST',
        headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ iscoredUsername: claimInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setClaimInput('');
        setClaimMsg({
          ok: true,
          text: data.result === 'auto_approved'
            ? `Linked — that matched ${data.matchedOn}.`
            : data.result === 'already_yours'
              ? 'You already hold that name.'
              : 'Sent to a room admin for review.',
        });
        await loadClaims();
        await loadProfile();
      } else {
        setClaimMsg({ ok: false, text: data.error ?? 'Could not claim that name.' });
      }
    } catch {
      setClaimMsg({ ok: false, text: 'Network error.' });
    }
    setClaimBusy(false);
  };

  const releaseAlias = async (alias: string) => {
    if (!playerToken) return;
    setClaimBusy(true);
    setClaimMsg(null);
    try {
      const res = await fetch(`/api/users/me/identity/aliases/${encodeURIComponent(alias)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) { await loadClaims(); await loadProfile(); }
      else setClaimMsg({ ok: false, text: 'Could not remove that name.' });
    } catch {
      setClaimMsg({ ok: false, text: 'Network error.' });
    }
    setClaimBusy(false);
  };

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

  useEffect(() => { loadLinks(); void loadWitnessDevices(); }, [loadLinks, loadWitnessDevices]);


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
      // v2.72.0 — /notification-settings supersedes /notification-preferences:
      // same prefs blob, plus the Discord DM deliverability verdict the status
      // line below needs. The old endpoint still exists for anything else
      // reading it; both write through the same server-side merge.
      const res = await fetch('/api/me/notification-settings', {
        headers: { Authorization: `Bearer ${playerToken}` },
      });
      if (res.ok) {
        const data = (await res.json()) as NotificationSettings;
        setPrefs(data.prefs ?? {});
        setDraftPrefs(data.prefs ?? {});
        setNotifSettings(data);
      }
    } catch {
      // network error — section stays empty
    }
    setNotifLoading(false);
  }, [playerToken]);

  useEffect(() => { loadPrefs(); }, [loadPrefs]);

  // v2.72.0 — read the connect-flow outcome DiscordCallback bounced back with,
  // then strip it from the URL so a refresh doesn't re-announce it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('connect');
    if (!outcome) return;
    if (outcome === 'success') {
      setConnectNotice({ kind: 'success', text: "You're connected — Arcaid can send you Discord DMs now." });
    } else if (outcome === 'declined') {
      setConnectNotice({
        kind: 'error',
        text: 'Connection cancelled. You can try again, join manually, or use browser notifications instead.',
      });
    } else {
      setConnectNotice({ kind: 'error', text: params.get('reason') || 'Something went wrong connecting to Discord.' });
    }
    window.history.replaceState({}, '', window.location.pathname);
    // Reload so the deliverability line reflects the new membership.
    loadPrefs();
  }, [loadPrefs]);

  // Start the connect flow: ask the server for an authorize URL, stash the
  // nonce so DiscordCallback can prove this tab started it, then redirect.
  const startConnect = async () => {
    if (!playerToken || connectBusy) return;
    setConnectBusy(true);
    setConnectNotice(null);
    try {
      const redirectUri = `${window.location.origin}/auth/discord/callback`;
      const res = await fetch(
        `/api/auth/discord/connect-notifications?redirectUri=${encodeURIComponent(redirectUri)}`,
        { headers: { Authorization: `Bearer ${playerToken}` } },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not start the connection.');
      sessionStorage.setItem('arcaid_connect_nonce', data.nonce);
      sessionStorage.setItem('arcaid_connect_return', '/account/settings');
      window.location.href = data.authorizeUrl;
    } catch (e) {
      setConnectNotice({ kind: 'error', text: (e as Error).message || 'Could not start the connection.' });
      setConnectBusy(false);
    }
  };

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

  /**
   * Persist the avatar source. The server re-derives the effective avatar, so
   * the response is authoritative — we fold it back in rather than guessing,
   * which keeps the picker honest if the chosen provider turns out to have
   * nothing stored.
   */
  const saveAvatarPreference = async (preference: AvatarProvider) => {
    if (!playerToken) return;
    setAvatarSaving(true);
    setAvatarError(null);
    try {
      const res = await fetch('/api/users/me/avatar-preference', {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ preference }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const effectiveUrl = data.avatar_effective === 'google'
          ? (data.avatar_google_url ?? null)
          : null;
        setProfile(p => (p ? {
          ...p,
          avatar_preference: data.avatar_preference ?? null,
          avatar_effective: data.avatar_effective ?? null,
          // Keep the header avatar in step with the choice without a refetch.
          avatar_url: effectiveUrl,
        } : p));
        // The nav renders the CACHED login avatar, not user_profiles — without
        // this the change was invisible everywhere outside this page until the
        // token refreshed (owner field report, 2026-08-18).
        setViewerAvatar(
          resolveAvatarUrl(profile?.discord_user_id ?? discordUser?.discordId, effectiveUrl ?? data.avatar_discord_hash ?? null),
        );
        // There is no Save button here — the choice applies on click — so say
        // so, or it reads as nothing having happened.
        setAvatarSaved(true);
        window.setTimeout(() => setAvatarSaved(false), 2200);
      } else {
        setAvatarError(data.error ?? 'Failed to save.');
      }
    } catch {
      setAvatarError('Network error.');
    }
    setAvatarSaving(false);
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
      const res = await fetch('/api/me/notification-settings', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs: draftPrefs }),
      });
      if (res.ok) {
        const data = (await res.json()) as NotificationSettings;
        setPrefs(data.prefs ?? {});
        setDraftPrefs(data.prefs ?? {});
        setNotifSettings(data);
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
  // Only offer the picker when there is a genuine choice to make.
  const hasAvatarChoice = !!profile?.avatar_discord_hash && !!profile?.avatar_google_url;

  const draftTrimmed = draft.trim();
  const isUnchanged = draftTrimmed === (profile?.display_name ?? '');
  const canSubmit = !saving && !isUnchanged && (draftTrimmed === '' || availability.status === 'available');

  return (
    <div className="min-h-screen bg-deep text-primary">
      <nav className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div
          className="max-w-xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between"
          style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}
        >
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
          Your display name appears on every leaderboard, announcement, and notification across Arcaid.
        </p>

        {/* v2.130.0 — Appearance is deliberately the FIRST section and sits
            OUTSIDE the `loading` gate: it is a local preference that applies
            instantly, so it must not wait on the profile fetch. */}
        <section className="mb-8">
          <h2 className="text-sm font-medium mb-2">Appearance</h2>
          <AppearanceControl />
          <p className="text-xs text-faint mt-2">
            Auto follows each room&rsquo;s theme and your device setting on global pages.
          </p>
        </section>

        {/* v2.132.0 — the personal theme, reachable without being inside a
            game room. Same component and same write as the Display settings
            sheet's "My theme"; deliberately SECOND, because Appearance above
            still has the last word on light vs dark. Outside the `loading`
            gate for the same reason Appearance is: it applies instantly and
            must not wait on the profile fetch. */}
        <section className="mb-8">
          <h2 className="text-sm font-medium mb-2">My theme</h2>
          <ThemePicker
            value={personalTheme}
            onChange={setPersonalTheme}
            nullLabel={"Use each room's default"}
            aria-label="My theme"
            data-testid="personal-theme-picker"
            className="w-full max-w-sm px-3 py-2 bg-raised border border-border rounded text-primary text-sm"
          />
          <p className="text-xs text-faint mt-2">
            Applies to every game room and your admin pages. Appearance (above) still wins on
            light/dark.
          </p>
        </section>

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
                <p className="text-xs text-faint">
                  {hasAvatarChoice
                    ? 'Choose which linked account supplies your picture.'
                    : 'Your picture comes from the account you signed in with.'}
                </p>
              </div>
            </section>

            {/* Avatar source picker — only worth showing when the user actually
                has more than one to choose from. Before this existed, a user
                linked to both providers always got their Google picture and had
                no way to get their Discord avatar back. */}
            {hasAvatarChoice && (
              <section className="mb-8">
                <p className="block text-sm font-medium mb-1.5">Profile picture</p>
                <div className="flex flex-wrap gap-3">
                  {([
                    { key: 'discord' as const, label: 'Discord', src: resolveAvatarUrl(profile?.discord_user_id, profile?.avatar_discord_hash ?? null) },
                    { key: 'google' as const, label: 'Google', src: profile?.avatar_google_url ?? null },
                  ]).filter(o => !!o.src).map(option => {
                    const selected = (profile?.avatar_effective ?? null) === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        onClick={() => saveAvatarPreference(option.key)}
                        disabled={avatarSaving}
                        aria-pressed={selected}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border transition-colors cursor-pointer disabled:cursor-default ${
                          selected
                            ? 'bg-neon-cyan/15 border-neon-cyan/50 text-neon-cyan'
                            : 'border-border text-muted hover:text-primary hover:border-border/80'
                        }`}
                      >
                        <img src={option.src!} alt="" className="w-8 h-8 rounded-full border border-border" />
                        <span className="text-sm font-medium">{option.label}</span>
                      </button>
                    );
                  })}
                </div>
                {avatarError && <p className="mt-2 text-xs text-neon-red">{avatarError}</p>}
                {avatarSaved && !avatarError && <p className="mt-2 text-xs text-neon-green">Saved — this is your picture everywhere on Arcaid.</p>}
                {!avatarSaved && !avatarError && (
                  <p className="mt-2 text-xs text-faint">Applies as soon as you pick one — there's nothing to save.</p>
                )}
              </section>
            )}

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

            <GlobalSharingSection />

            <ThrowdownsSection />

            <section>
              <h2 className="text-sm font-medium mb-2">Linked iScored aliases</h2>
              <p className="text-xs text-muted mb-3">
                Scores submitted under any of these names count for you on every leaderboard.
                You can hold up to {claims?.maxAliases ?? 3}.
              </p>

              {claims && claims.aliases.length > 0 ? (
                <ul className="space-y-1">
                  {claims.aliases.map(alias => (
                    <li
                      key={alias}
                      className="flex items-center justify-between gap-3 text-sm font-mono text-primary bg-surface border border-border rounded px-3 py-1.5"
                    >
                      <span className="truncate">{alias}</span>
                      <button
                        onClick={() => releaseAlias(alias)}
                        disabled={claimBusy}
                        className="shrink-0 text-xs font-sans text-faint hover:text-neon-red cursor-pointer disabled:cursor-default bg-transparent border-none"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted">
                  No aliases yet. If you have posted scores on iScored under a different name, claim it below.
                </p>
              )}

              {claims && claims.pending.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {claims.pending.map(p => (
                    <li
                      key={p.id}
                      className="text-xs text-primary bg-neon-amber/10 border border-neon-amber/40 rounded px-3 py-1.5"
                    >
                      <span className="font-mono">{p.iscored_username}</span> — awaiting review
                      {p.room_name ? ` by a ${p.room_name} admin` : ''}.
                    </li>
                  ))}
                </ul>
              )}

              {/* Claiming is guarded: an exact (case-insensitive) match against a
                  name you already answer to is granted straight away; anything
                  else goes to a room admin. Before this existed, /map-user let
                  anyone self-claim any unclaimed name with no check at all. */}
              {claims && claims.aliasCount < claims.maxAliases && (
                <div className="mt-3">
                  <label htmlFor="claim-name" className="block text-xs text-muted mb-1">
                    Claim an iScored name
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="claim-name"
                      value={claimInput}
                      onChange={e => { setClaimInput(e.target.value); setClaimMsg(null); }}
                      placeholder="Name exactly as it appears on iScored"
                      className="flex-1 min-w-0 px-3 py-1.5 rounded bg-surface border border-border text-sm text-primary"
                    />
                    <button
                      onClick={submitClaim}
                      disabled={claimBusy || !claimInput.trim()}
                      className="shrink-0 px-3 py-1.5 rounded text-xs font-medium border border-border text-muted hover:text-primary cursor-pointer disabled:cursor-default disabled:opacity-50 bg-transparent"
                    >
                      Claim
                    </button>
                  </div>
                  {claimMsg && (
                    <p className={`mt-2 text-xs ${claimMsg.ok ? 'text-neon-green' : 'text-neon-red'}`}>
                      {claimMsg.text}
                    </p>
                  )}
                  <p className="mt-1 text-xs text-faint">
                    Names that match your account are linked immediately. Anything else is reviewed by a room admin.
                  </p>
                </div>
              )}
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
                  ) : links && links.some(l => !l.provider_user_id.startsWith('atgames:')) ? (
                    <ul className="space-y-2">
                      {/* google:* rows only — atgames:* rows render in their own
                          block below, whose unlink also re-anonymises scores
                          (the generic delete here would not). */}
                      {links.filter(l => !l.provider_user_id.startsWith('atgames:')).map(l => (
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

              {/* v2.141.0 — AtGames cabinet account. Unlike Google/Discord this
                  is not a login method: it exists so scores Arcaid pulls off an
                  AtGames tournament land on YOUR account instead of an
                  anonymous AtGames handle. */}
              <div className="mt-6 pt-4 border-t border-border">
                <h3 className="text-sm font-medium mb-1">AtGames cabinet account</h3>
                {(() => {
                  const atgamesLinks = (links ?? []).filter(l => l.provider_user_id.startsWith('atgames:'));
                  if (atgamesLinks.length > 0) {
                    return (
                      <>
                        <p className="text-xs text-muted mb-2">
                          Linked — tournament scores from your cabinet count for you automatically.
                        </p>
                        <ul className="space-y-2 mb-2">
                          {atgamesLinks.map(l => (
                            <li key={l.provider_user_id} className="flex items-center justify-between gap-3 text-sm bg-surface border border-border rounded px-3 py-2">
                              <span className="font-mono text-xs text-muted truncate">AtGames account {l.provider_user_id.slice('atgames:'.length)}</span>
                              <button
                                type="button"
                                disabled={atgamesBusy}
                                onClick={async () => {
                                  setAtgamesBusy(true); setAtgamesError(null);
                                  try {
                                    const res = await fetch('/api/auth/link/atgames', {
                                      method: 'DELETE',
                                      headers: { Authorization: `Bearer ${playerToken}` },
                                    });
                                    if (!res.ok) throw new Error((await res.json()).error || 'Could not unlink');
                                    setAtgamesNotice('AtGames account unlinked. Its scores return to the AtGames name.');
                                    await loadLinks();
                                  } catch (err) {
                                    setAtgamesError((err as Error).message);
                                  } finally {
                                    setAtgamesBusy(false);
                                  }
                                }}
                                className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-rose-400 hover:border-rose-500/40 cursor-pointer shrink-0 inline-flex items-center gap-1"
                              >
                                <Unlink size={12} /> Unlink
                              </button>
                            </li>
                          ))}
                        </ul>
                        {atgamesNotice && <p className="text-xs text-neon-cyan">{atgamesNotice}</p>}
                        {atgamesError && (
                          <p className="text-xs text-rose-400 inline-flex items-center gap-1"><AlertCircle size={12} /> {atgamesError}</p>
                        )}
                      </>
                    );
                  }
                  return (
                    <>
                      <p className="text-xs text-muted mb-3">
                        Link your AtGames account and tournament scores from your cabinet count for
                        you automatically. You sign in ONCE to prove it's yours — Arcaid keeps only
                        the account link, never your AtGames password.
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2 mb-2">
                        <input
                          type="email" placeholder="AtGames email" value={atgamesEmail}
                          onChange={e => setAtgamesEmail(e.target.value)}
                          autoComplete="off"
                          className="flex-1 px-3 py-2 bg-surface border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
                        />
                        <input
                          type="password" placeholder="AtGames password" value={atgamesPassword}
                          onChange={e => setAtgamesPassword(e.target.value)}
                          autoComplete="new-password"
                          className="flex-1 px-3 py-2 bg-surface border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan"
                        />
                        <button
                          type="button"
                          disabled={atgamesBusy || !atgamesEmail.trim() || !atgamesPassword}
                          onClick={async () => {
                            setAtgamesBusy(true); setAtgamesError(null); setAtgamesNotice(null);
                            try {
                              const res = await fetch('/api/auth/link/atgames', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
                                body: JSON.stringify({ email: atgamesEmail.trim(), password: atgamesPassword }),
                              });
                              const data = await res.json();
                              if (!res.ok) throw new Error(data.error || 'Could not link the AtGames account');
                              // The password's job is done the moment the link
                              // exists — clear it from the DOM immediately.
                              setAtgamesEmail(''); setAtgamesPassword('');
                              setAtgamesNotice(
                                data.rowsAttributed > 0
                                  ? `Linked! ${data.rowsAttributed} of your past tournament score${data.rowsAttributed === 1 ? '' : 's'} now count for you.`
                                  : 'Linked! Your cabinet scores will count for you from here on.',
                              );
                              await loadLinks();
                            } catch (err) {
                              setAtgamesError((err as Error).message);
                            } finally {
                              setAtgamesBusy(false);
                            }
                          }}
                          className="px-4 py-2 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >{atgamesBusy ? 'Linking…' : 'Link AtGames'}</button>
                      </div>
                      {atgamesNotice && <p className="text-xs text-neon-cyan">{atgamesNotice}</p>}
                      {atgamesError && (
                        <p className="text-xs text-rose-400 inline-flex items-center gap-1"><AlertCircle size={12} /> {atgamesError}</p>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* v2.142.0 (P8) — Arcaid Witness cabinet pairing. Not a login
                  and not the AtGames account link above: this pairs the
                  on-device Witness app so it can report table LAUNCH times
                  (the anti-gear-up signal). Player mints a code here, types it
                  into the app on the cabinet. */}
              <div className="mt-6 pt-4 border-t border-border">
                <h3 className="text-sm font-medium mb-1">Arcaid Witness cabinets</h3>
                <p className="text-xs text-muted mb-3">
                  Pair the Arcaid Witness app on your cabinet so your tournament scores are backed by
                  when you actually started each table. Get a code here, then enter it in the Witness
                  app on the machine.
                </p>
                {witnessCode ? (
                  <div className="mb-3 p-3 rounded border border-neon-cyan/40 bg-neon-cyan/10">
                    <p className="text-xs text-muted mb-1">Enter this in the Witness app (expires in ~10 min):</p>
                    <p className="font-mono text-2xl font-bold tracking-[0.3em] text-neon-cyan">{witnessCode}</p>
                  </div>
                ) : null}
                <button
                  type="button"
                  disabled={witnessBusy}
                  onClick={async () => {
                    setWitnessBusy(true); setWitnessError(null);
                    try {
                      const res = await fetch('/api/me/witness/pairing-code', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
                      });
                      const data = await res.json();
                      if (!res.ok) throw new Error(data.error || 'Could not create a pairing code');
                      setWitnessCode(data.code);
                    } catch (err) {
                      setWitnessError((err as Error).message);
                    } finally {
                      setWitnessBusy(false);
                    }
                  }}
                  className="mb-3 px-4 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-sm font-medium hover:bg-neon-cyan/20 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer inline-flex items-center gap-1.5"
                >
                  <Link2 size={14} /> {witnessBusy ? 'Working…' : witnessCode ? 'New code' : 'Pair a cabinet'}
                </button>
                {witnessError && (
                  <p className="mb-2 text-xs text-rose-400 inline-flex items-center gap-1"><AlertCircle size={12} /> {witnessError}</p>
                )}
                {witnessDevices.length > 0 ? (
                  <ul className="space-y-2">
                    {witnessDevices.map(d => (
                      <li key={d.atgamesUniqueId} className="text-sm bg-surface border border-border rounded px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          <span className="text-primary">{d.atgamesUsername || 'Cabinet'}</span>
                          <span className="font-mono text-xs text-muted ml-2">{d.atgamesUniqueId.slice(0, 8)}…</span>
                          {d.lastSeenAt && <span className="text-xs text-faint ml-2">last seen {new Date(d.lastSeenAt).toLocaleDateString()}</span>}
                        </span>
                        <button
                          type="button"
                          disabled={witnessBusy}
                          onClick={async () => {
                            setWitnessBusy(true); setWitnessError(null);
                            try {
                              const res = await fetch(`/api/me/witness/devices/${encodeURIComponent(d.atgamesUniqueId)}`, {
                                method: 'DELETE', headers: { Authorization: `Bearer ${playerToken}` },
                              });
                              if (!res.ok) throw new Error((await res.json()).error || 'Could not unpair');
                              await loadWitnessDevices();
                            } catch (err) {
                              setWitnessError((err as Error).message);
                            } finally {
                              setWitnessBusy(false);
                            }
                          }}
                          className="px-2 py-1 rounded border border-border text-xs text-muted hover:text-rose-400 hover:border-rose-500/40 cursor-pointer shrink-0 inline-flex items-center gap-1"
                        >
                          <Unlink size={12} /> Unpair
                        </button>
                        </div>

                        {/* Where this cabinet's scores go. Undesignated is a
                            real, useful default — not an unfinished state —
                            so the empty option says what it actually does. */}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted">Send scores to</span>
                          <select
                            value={d.targetRoomId ?? ''}
                            disabled={witnessBusy}
                            onChange={e => {
                              const roomId = e.target.value || null;
                              if (roomId) void loadWitnessTournaments(roomId);
                              void setWitnessTarget(d.atgamesUniqueId, { roomId, tournamentId: null });
                            }}
                            className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary cursor-pointer"
                          >
                            <option value="">Global Scoreboard only</option>
                            {witnessRooms.map(r => (
                              <option key={r.id} value={r.id}>{r.name}</option>
                            ))}
                            {d.targetRoomId && !witnessRooms.some(r => r.id === d.targetRoomId) && (
                              <option value={d.targetRoomId}>{d.targetRoomName || 'Current room'}</option>
                            )}
                          </select>

                          {d.targetRoomId && (
                            <select
                              value={d.targetTournamentId ?? ''}
                              disabled={witnessBusy}
                              onChange={e => void setWitnessTarget(d.atgamesUniqueId, {
                                roomId: d.targetRoomId, tournamentId: e.target.value || null,
                              })}
                              className="bg-raised border border-border rounded px-2 py-1 text-xs text-primary cursor-pointer"
                            >
                              <option value="">Any tournament in this room</option>
                              {(witnessTournaments[d.targetRoomId] ?? []).map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                            </select>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-faint">
                          {d.targetRoomId
                            ? `Scores from this cabinet go to ${d.targetRoomName || 'that room'}${
                                d.targetTournamentName ? ` → ${d.targetTournamentName}` : ''
                              }. Anything that doesn't match an open game there goes to the Global Scoreboard.`
                            : 'Scores go to your Global Scoreboard record, plus any event you have joined. Pick a room to have them count towards a rotation tournament.'}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">No cabinets paired yet.</p>
                )}
              </div>
            </section>

            <section className="mt-8 pt-8 border-t border-border">
              <h2 className="text-sm font-medium mb-2">Notifications</h2>
              <p className="text-xs text-muted mb-4">
                Pick the events you want to hear about, then choose how they reach you. Everything
                is off until you turn it on.
              </p>
              {notifLoading ? (
                <p className="text-sm text-muted">Loading…</p>
              ) : (
                <>
                  <div>
                    {NOTIF_TYPES.map(({ key, label, helper }) => {
                      const checked = draftPrefs?.[key] === true;
                      // v2.72.0 — the five opt-ins are ONE stored set shared by
                      // both delivery channels (and by the
                      // /arcaid-notifications Discord command), so they render
                      // once here rather than being duplicated per channel.
                      // The chips say which channels can carry each event:
                      // browser push only handles the time-sensitive subset the
                      // server reports in `webPushTypes`.
                      const pushable = notifSettings?.webPushTypes?.includes(key) ?? false;
                      return (
                        <label
                          key={key}
                          className="flex items-start justify-between gap-3 py-2.5 border-b border-border last:border-b-0 cursor-pointer"
                        >
                          <span className="min-w-0">
                            <span className="block text-sm text-primary">
                              {label}
                              <span className="ml-2 inline-flex gap-1 align-middle">
                                <span className="px-1.5 py-px rounded text-[10px] border border-border text-faint">DM</span>
                                {pushable && (
                                  <span className="px-1.5 py-px rounded text-[10px] border border-border text-faint">Push</span>
                                )}
                              </span>
                            </span>
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
                  {/* v2.125.0 — Arcaid Chat Responses. Rendered BELOW the list
                      and outside its map on purpose: every entry above is an
                      outbound DM defaulting to OFF, while this is an inbound
                      reply defaulting to ON, so `draftPrefs?.[key] === true`
                      (the list's test) would show it off for anyone who has
                      never touched it. It also has no delivery-channel chips —
                      it isn't delivered anywhere, it's a reply in the channel
                      the person is already typing in. */}
                  <label
                    className="flex items-start justify-between gap-3 py-2.5 mt-3 pt-3 border-t border-border cursor-pointer"
                    data-testid="chat-responses-pref"
                  >
                    <span className="min-w-0">
                      <span className="block text-sm text-primary">
                        Arcaid chat responses to my messages
                      </span>
                      <span className="block text-xs text-faint">
                        Lets the bot reply in Discord when you say something it recognises — a table
                        name, or a question like &ldquo;how long left?&rdquo;. Turn it off and it
                        will ignore you everywhere. You can also say &ldquo;Arcaid, shush&rdquo; in
                        chat.
                      </span>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draftPrefs?.chatResponses !== false}
                      aria-label="Arcaid chat responses to my messages"
                      onClick={() => setDraftPrefs(prev => ({
                        ...(prev ?? {}),
                        chatResponses: !(prev?.chatResponses !== false),
                      }))}
                      className={`shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors ${
                        draftPrefs?.chatResponses !== false
                          ? 'bg-neon-cyan/30 border-neon-cyan/50'
                          : 'bg-surface border-border'
                      }`}
                    >
                      <span
                        className={`block w-4 h-4 rounded-full bg-primary transition-transform ${
                          draftPrefs?.chatResponses !== false ? 'translate-x-4' : 'translate-x-0.5'
                        }`}
                        style={{ marginTop: '1px' }}
                      />
                    </button>
                  </label>
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
                  {/* v2.72.0 (Discord HQ) — the two delivery channels, side by
                      side, each owning its own status. Browser push is a
                      per-device switch; Discord DMs depend on something the
                      user can't see (whether they share a server with the bot),
                      so that block states the verdict plainly instead of
                      implying the toggles above are enough. */}
                  <div className="mt-6 pt-4 border-t border-border grid gap-4 sm:grid-cols-2">
                    {vapidKey && (
                      <div className="rounded border border-border p-3">
                        <h3 className="text-sm font-medium mb-1">Browser push</h3>
                        {pushSupported ? (
                          <>
                            <label className="flex items-start justify-between gap-3 py-2 cursor-pointer">
                              <span className="min-w-0">
                                <span className="block text-sm text-primary">Push on this device</span>
                                <span className="block text-xs text-faint">
                                  Time-sensitive events arrive as browser notifications, even when Arcaid
                                  isn't open. No Discord account needed.
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
                              <p className="mt-1 text-xs text-rose-400 inline-flex items-start gap-1">
                                <AlertCircle size={12} className="mt-0.5 shrink-0" /> {pushError}
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-faint">
                            Not supported in this browser. On iPhone/iPad, add Arcaid to your Home Screen
                            first, then enable push from the installed app.
                          </p>
                        )}
                      </div>
                    )}

                    <div className="rounded border border-border p-3">
                      <h3 className="text-sm font-medium mb-1">Discord DMs</h3>
                      {!notifSettings?.discord.available ? (
                        <p className="text-xs text-faint">
                          You're signed in with Google. Link a Discord account above if you'd like DMs —
                          browser push works without one.
                        </p>
                      ) : !notifSettings.discord.gatewayReady ? (
                        <p className="text-xs text-faint inline-flex items-start gap-1">
                          <AlertCircle size={12} className="mt-0.5 shrink-0" />
                          Couldn't check delivery status right now. Your settings are saved either way.
                        </p>
                      ) : notifSettings.discord.reachable ? (
                        <p className="text-xs text-emerald-400 inline-flex items-start gap-1">
                          <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                          <span>
                            Enabled{' '}
                            {notifSettings.discord.via === 'global'
                              ? '(Arcaid community server)'
                              : notifSettings.discord.viaRoomName
                                ? `(you share ${notifSettings.discord.viaRoomName}'s server)`
                                : "(you share a server with the Arcaid bot)"}
                          </span>
                        </p>
                      ) : (
                        <>
                          <p className="text-xs text-amber-400 inline-flex items-start gap-1">
                            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                            <span>
                              Discord can only deliver DMs if you share a server with the Arcaid bot.
                            </span>
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            {notifSettings.discord.connectAvailable && (
                              <button
                                type="button"
                                onClick={startConnect}
                                disabled={connectBusy}
                                className="px-3 py-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan text-xs font-medium hover:bg-neon-cyan/20 disabled:opacity-50 cursor-pointer inline-flex items-center gap-1.5"
                              >
                                <Link2 size={12} />
                                {connectBusy ? 'Connecting…' : 'Connect Discord notifications'}
                              </button>
                            )}
                            {notifSettings.discord.inviteUrl && (
                              <a
                                href={notifSettings.discord.inviteUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-neon-cyan hover:underline"
                              >
                                or join the server yourself
                              </a>
                            )}
                          </div>
                          <p className="mt-2 text-xs text-faint">
                            Prefer not to? Turn on browser push instead — it needs nothing from Discord.
                          </p>
                        </>
                      )}
                      {connectNotice && (
                        <p
                          className={`mt-2 text-xs inline-flex items-start gap-1 ${connectNotice.kind === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}
                        >
                          {connectNotice.kind === 'success'
                            ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                            : <AlertCircle size={12} className="mt-0.5 shrink-0" />}
                          {connectNotice.text}
                        </p>
                      )}
                    </div>
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
