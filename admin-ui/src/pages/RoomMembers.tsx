import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import PlayerNameLink from '../components/PlayerNameLink';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import LoadingState from '../components/LoadingState';
import { useRoom } from '../contexts/RoomContext';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { getPortal } from '../lib/portal';
import { parseServerDate, relativeTimeFrom } from '../lib/format';

/**
 * Room Members/Players page (v2.42.0, docs/contracts/room-members-page-contract.md).
 *
 * `GET /:roomId/members` is registered AFTER `roomVisibilityGate` in
 * rooms.ts, so it's automatically public for 'open' rooms and
 * members/admins/super-only for 'approval' rooms. On 'approval' rooms the
 * gate decodes the Bearer token ITSELF (there is no cookie/session
 * fallback), so this fetch must attach the player token when one exists —
 * without it, even an approved MEMBER's request arrived tokenless, got
 * 403'd, and the page silently rendered an empty roster (v2.99.1 fix; the
 * page-reachability gate — PublicLayout's RoomJoinGate — only controls who
 * SEES the page, not what this fetch is allowed to read).
 *
 * `join_policy` isn't on RoomContext, so this page reads it via
 * `getPortal(slug)` — already fetched (and cached/deduped) by PublicLayout on
 * mount, so this is not an extra network round trip in practice.
 *
 * v2.49.1 — ban management (added briefly in v2.49.0) moved to the
 * room-admin `Members` page (`RoomAdminMembers.tsx`, under
 * `/:slug/admin/members`). This page is public-roster-only again; it never
 * had its own auth surface (server-side `roomVisibilityGate` gating is
 * unchanged), so nothing here needed touching except removing the admin
 * affordances.
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

function formatDate(iso: string): string {
  return parseServerDate(iso)?.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) ?? '';
}

const formatRelative = relativeTimeFrom;

function MemberRow({ slug, mode, entry }: { slug: string; mode: 'approval' | 'open'; entry: MemberEntry }) {
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
    </div>
  );
}

export default function RoomMembers() {
  const { slug } = useParams<{ slug: string }>();
  const { roomId } = useRoom();
  const { playerToken } = useViewerAuth();
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [mode, setMode] = useState<'approval' | 'open'>('open');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!roomId || !slug) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      fetch(`/api/rooms/${roomId}/members`, playerToken ? { headers: { Authorization: `Bearer ${playerToken}` } } : undefined).then(r => r.ok ? r.json() : []),
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
  }, [roomId, slug, playerToken]);

  const title = mode === 'approval' ? 'Members' : 'Players';
  const subtitle = mode === 'approval' ? 'Approved members of this room' : "Everyone who's posted a score";
  const emptyMessage = mode === 'approval' ? 'No members yet.' : 'No players yet — be the first to post a score.';

  if (loading) return <LoadingState message="Loading..." />;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
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
            <MemberRow key={m.userId} slug={slug || ''} mode={mode} entry={m} />
          ))}
        </div>
      )}
    </div>
  );
}
