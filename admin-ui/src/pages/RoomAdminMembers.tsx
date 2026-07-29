import { useCallback, useEffect, useState } from 'react';
import { Ban, ShieldCheck, UsersRound } from 'lucide-react';
import PlayerNameLink from '../components/PlayerNameLink';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';
import { useRoom } from '../contexts/RoomContext';
import { getPortal } from '../lib/portal';
import { api } from '../lib/api';

/**
 * Room-admin Members page (v2.49.1, tmp/members-admin-move-contract.md).
 *
 * v2.49.0 put Ban/Unban on the PUBLIC `/:slug/members` page behind a
 * cosmetic client-side admin check (`resolveViewerClaims`). Server gating on
 * the bans endpoints was and is correct (`requireAuth + requireRoomAccess`),
 * but admin controls belong in the admin area — this page moves the working
 * ban UI here and drops the client-side admin-detection dance entirely: this
 * page only ever renders inside `RoomAdminLayout` (route below `/:slug/admin`),
 * whose own `isAuthenticated()` gate + every read/write's server-side
 * `requireRoomAccess` are the real authorization boundary. The public roster
 * page (`RoomMembers.tsx`) went back to being a plain public roster.
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

export default function RoomAdminMembers() {
  const { roomId, roomSlug } = useRoom();
  const { toast } = useToast();
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [mode, setMode] = useState<'approval' | 'open'>('open');
  const [loading, setLoading] = useState(true);

  const [currentDiscordId, setCurrentDiscordId] = useState<string | null>(null);
  const [roomAdminIds, setRoomAdminIds] = useState<Set<string>>(new Set());
  const [bans, setBans] = useState<RoomBanRow[]>([]);
  const [banTarget, setBanTarget] = useState<MemberEntry | null>(null);
  const [banDurationDays, setBanDurationDays] = useState('');
  const [banReason, setBanReason] = useState('');
  const [banning, setBanning] = useState(false);
  const [unbanTarget, setUnbanTarget] = useState<RoomBanRow | null>(null);
  const [unbanning, setUnbanning] = useState(false);

  // Viewer identity for the "hide Ban on self" rule — this page renders only
  // inside RoomAdminLayout (admin JWT already established), so `/auth/me` is
  // the source of the acting admin's own discordId (mirrors the layout's own
  // `/auth/me` call for the sidebar's currentUser display).
  useEffect(() => {
    api.get<{ discordId: string | null }>('/auth/me')
      .then((data) => setCurrentDiscordId(data.discordId ?? null))
      .catch(() => setCurrentDiscordId(null));
  }, []);

  const refresh = useCallback(() => {
    if (!roomId) return;
    setLoading(true);
    Promise.all([
      api.get<MemberEntry[]>(`/rooms/${roomId}/members`).catch(() => []),
      roomSlug
        ? getPortal(roomSlug).then(p => p.join_policy ?? 'open').catch(() => 'open' as const)
        : Promise.resolve('open' as const),
      api.get<{ discordAdmins?: RoomAdminRow[] }>(`/rooms/${roomId}/admins`).catch(() => ({ discordAdmins: [] })),
      api.get<RoomBanRow[]>(`/rooms/${roomId}/admin/bans`).catch(() => []),
    ])
      .then(([m, policy, admins, banRows]) => {
        setMembers(m || []);
        setMode(policy);
        setRoomAdminIds(new Set((admins.discordAdmins || []).map(a => a.discord_user_id)));
        setBans(banRows || []);
      })
      .finally(() => setLoading(false));
  }, [roomId, roomSlug]);

  useEffect(() => { refresh(); }, [refresh]);

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
      refresh();
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
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to lift ban', 'error');
    } finally {
      setUnbanning(false);
    }
  };

  const activeBans = bans.filter(b => !b.lifted_at && (!b.expires_at || new Date(b.expires_at).getTime() > Date.now()));
  const activeBanUserIds = new Set(activeBans.map(b => b.discord_user_id));

  const canBanMember = (entry: MemberEntry): boolean => {
    if (currentDiscordId && entry.userId === currentDiscordId) return false;
    if (roomAdminIds.has(entry.userId)) return false;
    // The roster endpoint excludes actively-banned users server-side already;
    // kept as a defensive double-check against a stale/cached roster so a
    // re-ban attempt can't surface here.
    if (activeBanUserIds.has(entry.userId)) return false;
    return true;
  };

  if (loading) return <LoadingState message="Loading members..." />;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <UsersRound size={22} className="text-neon-cyan" />
        <h1 className="font-display text-2xl font-bold">Members</h1>
      </div>
      <p className="text-muted text-sm mb-6">
        Manage this room's roster and bans. Banning removes a player from the room and blocks them from
        re-joining (or requesting to join again) while the ban is active — Arcaid-side only, no Discord action taken.
      </p>

      <NeonCard title="Roster" glowColor="cyan" className="mb-4">
        {members.length === 0 ? (
          <p className="text-faint text-sm">No members yet.</p>
        ) : (
          <div className="-mx-4 sm:-mx-5 -mb-4 sm:-mb-5">
            {members.map(m => (
              <MemberRow
                key={m.userId}
                slug={roomSlug}
                mode={mode}
                entry={m}
                canBan={canBanMember(m)}
                onBan={openBanModal}
              />
            ))}
          </div>
        )}
      </NeonCard>

      <NeonCard title="Banned" glowColor="magenta">
        {activeBans.length === 0 ? (
          <p className="text-faint text-sm">No active bans in this room.</p>
        ) : (
          <div className="-mx-4 sm:-mx-5 -mb-4 sm:-mb-5">
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
      </NeonCard>

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
