import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ArrowLeft, Home, UserCheck, Trophy, Mail, Sparkles } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

type RoomMemberSource = 'submission' | 'admin_invite' | 'claim' | 'backfill';

interface RoomForUser {
  roomId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  joinedAt: string;
  source: RoomMemberSource;
  lastActivityAt: string | null;
}

const SOURCE_LABEL: Record<RoomMemberSource, string> = {
  submission: 'Submitted scores',
  admin_invite: 'Admin invite',
  claim: 'Claimed identity',
  backfill: 'Existing history',
};

const SOURCE_ICON: Record<RoomMemberSource, React.ReactNode> = {
  submission: <Trophy size={12} />,
  admin_invite: <Mail size={12} />,
  claim: <UserCheck size={12} />,
  backfill: <Sparkles size={12} />,
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  if (Number.isNaN(diffMs) || diffMs < 0) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function MyRooms() {
  const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
  const [rooms, setRooms] = useState<RoomForUser[]>([]);
  const [loading, setLoading] = useState(true);

  const loadRooms = useCallback(async () => {
    if (!playerToken) return;
    try {
      const res = await fetch('/api/me/rooms', { headers: { Authorization: `Bearer ${playerToken}` } });
      if (res.ok) setRooms(await res.json());
    } catch {}
    setLoading(false);
  }, [playerToken]);

  useEffect(() => { loadRooms(); }, [loadRooms]);

  if (!discordUser) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center">
          <Building2 size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in with Discord to see the rooms you belong to</p>
          <button
            onClick={() => loginWithDiscord('__myrooms__', '/my-rooms')}
            className="px-4 py-2 rounded border border-[#5865F2]/40 bg-[#5865F2]/10 text-[#5865F2] text-sm font-medium hover:bg-[#5865F2]/20 cursor-pointer"
          >
            Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Navigation header */}
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
        <div className="flex items-center gap-2 mb-6">
          <Building2 size={20} className="text-neon-cyan" />
          <h1 className="font-display text-xl font-bold">My Rooms</h1>
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
          </div>
        ) : rooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted">You haven't joined any rooms yet.</p>
            <p className="text-xs text-faint mt-1">Submit a score, accept an admin invite, or claim an anonymous identity to join a room.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {rooms.map(room => (
              <Link
                key={room.roomId}
                to={`/${room.slug}`}
                className="flex items-center gap-3 bg-surface border border-border rounded-lg px-4 py-3 hover:border-neon-cyan/50 transition-colors no-underline group"
              >
                {/* Logo */}
                {room.logoUrl ? (
                  <img
                    src={room.logoUrl}
                    alt=""
                    className="w-10 h-10 rounded object-cover border border-border flex-shrink-0"
                  />
                ) : (
                  <div className="w-10 h-10 rounded bg-neon-cyan/10 border border-border flex items-center justify-center flex-shrink-0">
                    <Building2 size={18} className="text-neon-cyan/60" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm text-primary group-hover:text-neon-cyan transition-colors truncate">
                    {room.name}
                  </p>
                  <p className="text-[11px] text-faint truncate">
                    {formatRelativeTime(room.lastActivityAt)}
                  </p>
                </div>

                {/* Source badge */}
                <span
                  className="flex items-center gap-1 px-2 py-1 rounded bg-raised/50 text-faint text-[10px] uppercase tracking-wider flex-shrink-0"
                  title={SOURCE_LABEL[room.source]}
                >
                  {SOURCE_ICON[room.source]}
                  <span className="hidden sm:inline">{SOURCE_LABEL[room.source]}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
