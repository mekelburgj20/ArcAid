import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ArrowLeft, Home, UserCheck, Trophy, Mail, Sparkles, BookmarkPlus, LogOut } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import { useToast } from '../components/Toast';
import LoginButtons from '../components/LoginButtons';
import { relativeTimeFrom } from '../lib/format';

type RoomMemberSource = 'submission' | 'admin_invite' | 'claim' | 'backfill' | 'self_join';

const SOURCE_LABEL: Record<RoomMemberSource, string> = {
  submission: 'Submitted scores',
  admin_invite: 'Admin invite',
  claim: 'Claimed identity',
  backfill: 'Existing history',
  self_join: 'Joined',
};

const SOURCE_ICON: Record<RoomMemberSource, React.ReactNode> = {
  submission: <Trophy size={12} />,
  admin_invite: <Mail size={12} />,
  claim: <UserCheck size={12} />,
  backfill: <Sparkles size={12} />,
  self_join: <BookmarkPlus size={12} />,
};

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const rel = relativeTimeFrom(iso);
  if (!rel) return 'No activity yet';
  // Preserve this page's capitalized "Just now" (start-of-sentence usage).
  return rel === 'just now' ? 'Just now' : rel;
}

export default function MyRooms() {
  const { discordUser, loginWithDiscord, loginWithGoogle } = useViewerAuth();
  // v2.38.0 — shared join/leave hook (was a local fetch here, now the same
  // /api/me/rooms state + optimistic mutations LandingPage/PublicLayout use).
  const { rooms, loading, leave } = useMyRooms();
  const { toast } = useToast();
  const [leavingId, setLeavingId] = useState<string | null>(null);

  const handleLeave = async (room: { roomId: string; name: string }) => {
    setLeavingId(room.roomId);
    const ok = await leave(room.roomId);
    setLeavingId(null);
    toast(ok ? `Left ${room.name}.` : 'Could not leave that room — try again.', ok ? 'info' : 'error');
  };

  if (!discordUser) {
    return (
      <div className="min-h-screen bg-deep flex items-center justify-center">
        <div className="text-center">
          <Building2 size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to see the rooms you belong to</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__myrooms__', '/my-rooms')}
            onGoogleLogin={() => loginWithGoogle('__myrooms__', '/my-rooms')}
            className="justify-center"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Navigation header */}
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
            <p className="text-xs text-faint mt-1">Add a room from the home page, submit a score, accept an admin invite, or claim an anonymous identity to join a room.</p>
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
                  title={SOURCE_LABEL[room.source as RoomMemberSource]}
                >
                  {SOURCE_ICON[room.source as RoomMemberSource]}
                  <span className="hidden sm:inline">{SOURCE_LABEL[room.source as RoomMemberSource]}</span>
                </span>

                {/* v2.38.0 — leave affordance. preventDefault/stopPropagation so
                    it never triggers the row-wide Link's navigation. */}
                <button
                  type="button"
                  onClick={e => { e.preventDefault(); e.stopPropagation(); handleLeave(room); }}
                  disabled={leavingId === room.roomId}
                  aria-label={`Leave ${room.name}`}
                  title="Leave this room"
                  className="flex items-center justify-center w-8 h-8 rounded text-faint hover:text-neon-magenta hover:bg-neon-magenta/10 transition-colors flex-shrink-0 bg-transparent border-0 cursor-pointer disabled:opacity-40 disabled:cursor-wait"
                >
                  <LogOut size={14} />
                </button>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
