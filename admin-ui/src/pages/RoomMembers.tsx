import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Users, Ban, ShieldCheck } from 'lucide-react';
import PlayerNameLink from '../components/PlayerNameLink';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';
import { useRoom } from '../contexts/RoomContext';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { getPortal } from '../lib/portal';
import { api, getToken } from '../lib/api';

/**
 * Room Members/Players page (v2.42.0, tmp/room-members-page-contract.md).
 *
 * `GET /:roomId/members` is registered AFTER `roomVisibilityGate` in
 * rooms.ts, so it's automatically public for 'open' rooms and
 * members/admins/super-only for 'approval' rooms — this page never needs to
 * branch on auth itself, it just renders whatever the endpoint returns (a
 * guest hitting an approval room never reaches this page at all: PublicLayout
 * shows RoomJoinGate instead of the Outlet while `isGated` is true).
 *
 * `join_policy` isn't on RoomContext, so this page reads it via
 * `getPortal(slug)` — already fetched (and cached/deduped) by PublicLayout on
 * mount, so this is not an extra network round trip in practice.
 *
 * v2.49.0 (room-bans contract) — admin-aware: a viewer whose `playerToken`
 * decodes to `room_admin`/`super_admin` for this room sees a Ban action per
 * member plus a "Banned" section. Admin detection mirrors GameDetail.tsx's
 * `decodeViewerClaims(playerToken)` precedent (not shared — that helper
 * isn't exported) — the SAME Discord-OAuth login flow that issues a plain
 * `player` token for a non-admin issues a `room_admin`/`super_admin` token
 * when the logged-in Discord identity is actually an admin (auth.ts checks
 * super_admins → game_room_admins → falls back to player, regardless of
 * which login entry point — "player:<slug>" or a bare admin login — was
 * used), so `playerToken` legitimately carries an admin role here. Public
 * (non-admin) viewers see the page exactly as before — no new fetches fire
 * for them.
 *
 * v2.49.0 fix-round (tmp/room-bans-fixes.md #10) — `playerToken` alone
 * misses two real cases: an admin who logged in at `/:slug/admin` (their JWT
 * lives under the ADMIN token slot, `arcaid_token`, read via `lib/api.ts`'s
 * `getToken()` — see PublicLayout.tsx's `hasAdminToken` for the existing
 * precedent of reading that slot from a public page), and a linked-but-
 * unlinked-Google admin whose player-flow login never happened to seed the
 * admin slot (DiscordCallback.tsx/GoogleCallback.tsx only auto-seed
 * `arcaid_token` when it was previously empty). `resolveViewerClaims` below
 * decodes BOTH slots and prefers whichever actually carries an admin role
 * for this room. This is purely a display affordance — server-side gating
 * (`requireRoomAccess`) is unchanged and authoritative regardless of which
 * slot the FE manages to read.
 */

interface MemberEntry {
  userId: string;
  displayName: string;
  username: string | null;
  iscoredUsername: string | null;
  avatarHash: string | null;
  avatarUrl: string | null;
  joinedAt?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  scoreCount?: number;
  isOwner?: boolean;
  isAdmin?: boolean;
}

interface RoomBanRow {
  id: string;
  discord_user_id: string;
  reason: string | null;
  banned_by: string;
  banned_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  lifted_by: string | null;
  game_room_id: string | null;
  discord_user_display_name: string | null;
  discord_user_username: string | null;
}

interface RoomAdminRow {
  discord_user_id: string;
}

interface ViewerClaims {
  role: 'player' | 'room_admin' | 'super_admin';
  gameRoomIds: string[];
  discordId: string | null;
}

function decodeViewerClaims(token: string | null): ViewerClaims | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      role: (payload.role as 'player' | 'room_admin' | 'super_admin') || 'player',
      gameRoomIds: Array.isArray(payload.gameRoomIds) ? payload.gameRoomIds : [],
      discordId: (payload.discordId as string) || null,
    };
  } catch {
    return null;
  }
}

function isAdminRole(claims: ViewerClaims | null): boolean {
  return !!claims && (claims.role === 'room_admin' || claims.role === 'super_admin');
}

/** v2.49.0 fix-round (#10) — decodes both the player-token and admin-token
 *  slots and prefers whichever one actually carries an admin role, so a room
 *  admin who logged in at `/:slug/admin` (or whose player login never
 *  auto-seeded the admin slot) still sees the Ban UI on this public page. */
function resolveViewerClaims(playerToken: string | null): ViewerClaims | null {
  const playerClaims = decodeViewerClaims(playerToken);
  if (isAdminRole(playerClaims)) return playerClaims;
  const adminClaims = decodeViewerClaims(getToken());
  if (isAdminRole(adminClaims)) return adminClaims;
  return playerClaims ?? adminClaims;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff) || diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function MemberRow({
  slug, mode, entry, canBan, onBan,
}: {
  slug: string;
  mode: 'approval' | 'open';
  entry: MemberEntry;
  canBan: boolean;
  onBan: (entry: MemberEntry) => void;
}) {
  const secondary = mode === 'approval'
    ? (entry.joinedAt ? `Member since ${formatDate(entry.joinedAt)}` : null)
    : `${entry.scoreCount ?? 0} score${(entry.scoreCount ?? 0) === 1 ? '' : 's'} · last active ${entry.lastSeenAt ? formatRelative(entry.lastSeenAt) : '—'}`;

  const badge = entry.isOwner ? 'Owner' : entry.isAdmin ? 'Admin' : null;

  const nameBlock = (
    <>
      <span className="font-medium text-sm text-primary truncate">{entry.displayName}</span>
      {badge && (
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded flex-shrink-0 ${
          entry.isOwner ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'
        }`}>
          {badge}
        </span>
      )}
    </>
  );

  return (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-border/20 last:border-0">
      <PlayerAvatar
        username={entry.displayName}
        discordUserId={entry.userId}
        avatarHash={entry.avatarHash}
        avatarUrl={entry.avatarUrl}
        size={32}
      />
      <div className="min-w-0 flex-1">
        {entry.iscoredUsername ? (
          <PlayerNameLink
            slug={slug}
            entry={{
              iscored_username: entry.iscoredUsername,
              display_name: entry.displayName,
              discord_user_id: entry.userId,
            }}
            className="flex items-center gap-2 no-underline hover:opacity-90"
          >
            {nameBlock}
          </PlayerNameLink>
        ) : (
          <div className="flex items-center gap-2">{nameBlock}</div>
        )}
        {secondary && <p className="text-xs text-faint truncate mt-0.5">{secondary}</p>}
      </div>
      {canBan && (
        <NeonButton
          variant="ghost"
          className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta flex-shrink-0"
          onClick={() => onBan(entry)}
        >
          <Ban size={13} className="inline -mt-0.5 mr-1" />
          Ban
        </NeonButton>
      )}
    </div>
  );
}

export default function RoomMembers() {
  const { slug } = useParams<{ slug: string }>();
  const { roomId } = useRoom();
  const { playerToken } = useViewerAuth();
  const { toast } = useToast();
  const viewerClaims = resolveViewerClaims(playerToken);
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [mode, setMode] = useState<'approval' | 'open'>('open');
  const [loading, setLoading] = useState(true);

  const [roomAdminIds, setRoomAdminIds] = useState<Set<string>>(new Set());
  const [bans, setBans] = useState<RoomBanRow[]>([]);
  const [banTarget, setBanTarget] = useState<MemberEntry | null>(null);
  const [banDurationDays, setBanDurationDays] = useState('');
  const [banReason, setBanReason] = useState('');
  const [banning, setBanning] = useState(false);
  const [unbanTarget, setUnbanTarget] = useState<RoomBanRow | null>(null);
  const [unbanning, setUnbanning] = useState(false);

  const isAdmin = !!roomId && !!viewerClaims && (
    viewerClaims.role === 'super_admin' || (viewerClaims.role === 'room_admin' && viewerClaims.gameRoomIds.includes(roomId))
  );

  useEffect(() => {
    if (!roomId || !slug) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`/api/rooms/${roomId}/members`).then(r => r.ok ? r.json() : []),
      getPortal(slug).then(p => p.join_policy ?? 'open').catch(() => 'open' as const),
    ])
      .then(([m, policy]) => {
        if (cancelled) return;
        setMembers(m || []);
        setMode(policy);
      })
      .catch(() => { if (!cancelled) setMembers([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [roomId, slug]);

  const refreshAdminData = useCallback(() => {
    if (!roomId || !isAdmin) return;
    // v2.49.0 fix-round (#9) — routed through lib/api.ts (was three raw
    // fetch() calls with hand-built auth headers) so these admin-only reads
    // get the standard 401 auto-refresh instead of silently failing when the
    // admin token has expired.
    api.get<RoomBanRow[]>(`/rooms/${roomId}/admin/bans`)
      .then((rows) => setBans(rows || []))
      .catch(() => setBans([]));
    api.get<{ discordAdmins?: RoomAdminRow[] }>(`/rooms/${roomId}/admins`)
      .then((data) => {
        setRoomAdminIds(new Set((data.discordAdmins || []).map(a => a.discord_user_id)));
      })
      .catch(() => setRoomAdminIds(new Set()));
  }, [roomId, isAdmin]);

  useEffect(() => { refreshAdminData(); }, [refreshAdminData]);

  const openBanModal = (entry: MemberEntry) => {
    setBanTarget(entry);
    setBanDurationDays('');
    setBanReason('');
  };

  const handleBan = async () => {
    if (!roomId || !banTarget) return;
    setBanning(true);
    try {
      await api.post(`/rooms/${roomId}/admin/bans`, {
        discordUserId: banTarget.userId,
        durationDays: banDurationDays ? parseInt(banDurationDays, 10) : null,
        reason: banReason.trim() || undefined,
      });
      toast(`${banTarget.displayName} banned from this room`, 'success');
      setBanTarget(null);
      setMembers(prev => prev.filter(m => m.userId !== banTarget.userId));
      refreshAdminData();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to ban member', 'error');
    } finally {
      setBanning(false);
    }
  };

  const handleUnban = async () => {
    if (!roomId || !unbanTarget) return;
    setUnbanning(true);
    try {
      await api.post(`/rooms/${roomId}/admin/bans/${unbanTarget.id}/lift`, {});
      toast('Ban lifted', 'success');
      setUnbanTarget(null);
      refreshAdminData();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to lift ban', 'error');
    } finally {
      setUnbanning(false);
    }
  };

  const title = mode === 'approval' ? 'Members' : 'Players';
  const subtitle = mode === 'approval' ? 'Approved members of this room' : "Everyone who's posted a score";
  const emptyMessage = mode === 'approval' ? 'No members yet.' : 'No players yet — be the first to post a score.';

  const activeBans = bans.filter(b => !b.lifted_at && (!b.expires_at || new Date(b.expires_at).getTime() > Date.now()));
  const activeBanUserIds = new Set(activeBans.map(b => b.discord_user_id));

  const canBanMember = (entry: MemberEntry): boolean => {
    if (!isAdmin) return false;
    if (viewerClaims?.discordId && entry.userId === viewerClaims.discordId) return false;
    if (roomAdminIds.has(entry.userId)) return false;
    // v2.49.0 fix-round (#7, belt-and-braces) — the roster endpoint now
    // excludes actively-banned users server-side, so this should be
    // unreachable in practice; kept as a defensive double-check against a
    // stale/cached members response so a re-ban attempt can't surface here.
    if (activeBanUserIds.has(entry.userId)) return false;
    return true;
  };

  if (loading) return <LoadingState message="Loading..." />;

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Users size={20} className="text-neon-cyan" />
        <h2 className="font-display text-xl font-bold">{title}</h2>
      </div>
      <p className="text-muted text-sm mb-6">{subtitle}</p>

      {members.length === 0 ? (
        <p className="text-muted text-center py-12">{emptyMessage}</p>
      ) : (
        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          {members.map(m => (
            <MemberRow
              key={m.userId}
              slug={slug || ''}
              mode={mode}
              entry={m}
              canBan={canBanMember(m)}
              onBan={openBanModal}
            />
          ))}
        </div>
      )}

      {isAdmin && (
        <div className="mt-8">
          <div className="flex items-center gap-2 mb-1">
            <Ban size={18} className="text-neon-magenta" />
            <h3 className="font-display text-lg font-bold">Banned</h3>
          </div>
          <p className="text-muted text-sm mb-4">Players banned from this room — Arcaid-side only, no Discord action taken.</p>
          {activeBans.length === 0 ? (
            <p className="text-faint text-sm">No active bans in this room.</p>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {activeBans.map(b => (
                <div key={b.id} className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border/20 last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-primary truncate" title={b.discord_user_id}>
                      {b.discord_user_display_name || b.discord_user_username || b.discord_user_id}
                    </p>
                    <p className="text-xs text-faint truncate mt-0.5">
                      Banned {formatRelative(b.banned_at)}
                      {b.expires_at ? ` · expires ${formatDate(b.expires_at)}` : ' · permanent'}
                      {b.reason ? ` · "${b.reason}"` : ''}
                    </p>
                  </div>
                  <NeonButton
                    variant="ghost"
                    className="text-xs px-3 py-1.5 flex-shrink-0"
                    onClick={() => setUnbanTarget(b)}
                  >
                    <ShieldCheck size={13} className="inline -mt-0.5 mr-1" />
                    Unban
                  </NeonButton>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {banTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => setBanTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Ban from room"
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">
              Ban {banTarget.displayName} from this room?
            </h3>
            <p className="text-muted mb-4 text-sm">
              This removes them from the room's member list and blocks re-joining (or requesting to join again)
              while the ban is active. This is Arcaid-side only — it does not affect their Discord account or
              server membership. Leave duration blank for a permanent ban.
            </p>
            <label className="block text-xs text-faint mb-1">Duration (days, optional)</label>
            <input
              type="number"
              min={1}
              value={banDurationDays}
              onChange={(e) => setBanDurationDays(e.target.value)}
              placeholder="Permanent"
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-3"
            />
            <label className="block text-xs text-faint mb-1">Reason (optional)</label>
            <input
              type="text"
              value={banReason}
              onChange={(e) => setBanReason(e.target.value)}
              maxLength={500}
              className="w-full bg-raised border border-border rounded px-3 py-2 text-sm text-primary placeholder-faint focus:outline-none focus:border-neon-cyan/50 mb-4"
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => setBanTarget(null)} disabled={banning}>Cancel</NeonButton>
              <NeonButton variant="danger" onClick={handleBan} disabled={banning}>
                {banning ? 'Banning...' : 'Ban'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {unbanTarget && (
        <ConfirmModal
          title="Lift this ban?"
          message={`${unbanTarget.discord_user_display_name || unbanTarget.discord_user_username || unbanTarget.discord_user_id} will be able to re-join this room. This does not restore their prior membership automatically.`}
          confirmLabel={unbanning ? 'Lifting...' : 'Lift ban'}
          onConfirm={handleUnban}
          onCancel={() => setUnbanTarget(null)}
        />
      )}
    </div>
  );
}
