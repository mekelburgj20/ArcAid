import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Building2, ArrowLeft, Home, UserCheck, Trophy, Mail, Sparkles, BookmarkPlus } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import LoginButtons from '../components/LoginButtons';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';
import type { MemberRoom } from '../lib/landingRooms';
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
  // v2.38.0 — shared /api/me/rooms state (the same hook LandingPage/PublicLayout use).
  const { rooms, loading, leave } = useMyRooms();
  const { toast } = useToast();
  // W84 (owner, 2026-11-01) — leave from this list again, through the SAME
  // confirm the room's user menu uses (PublicLayout.handleLeaveRoom).
  const [confirmLeave, setConfirmLeave] = useState<MemberRoom | null>(null);
  const [leavingId, setLeavingId] = useState<string | null>(null);

  const leaveConfirmed = async () => {
    const room = confirmLeave;
    setConfirmLeave(null);
    if (!room) return;
    setLeavingId(room.roomId);
    try {
      // `leave` is optimistic: the row drops at once and is put back if the
      // DELETE fails, so no refetch is needed here.
      const ok = await leave(room.roomId);
      toast(
        ok ? `You left ${room.name}. You can rejoin any time.` : `Could not leave ${room.name} — try again.`,
        ok ? 'info' : 'error',
      );
    } finally {
      setLeavingId(null);
    }
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
              <div
                key={room.roomId}
                data-testid="my-rooms-row"
                className="flex items-center gap-3 bg-surface border border-border rounded-lg pr-2 has-[a:hover]:border-neon-cyan/50 transition-colors"
              >
                <Link
                  to={`/${room.slug}`}
                  className="flex flex-1 min-w-0 items-center gap-3 pl-4 py-3 no-underline group"
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
                </Link>

                {/* W21 (WWS 2026-10-23) removed a one-tap leave ICON here:
                    TomatoGrass hit it on a phone aiming for the room title. It is
                    back BY OWNER DECISION 2026-11-01 (W84) as a LABELLED, CONFIRMED
                    control OUTSIDE the row's Link (a sibling, 12px clear of the
                    badge), so a tap on it can never navigate and a tap on the
                    title can never leave. The user-menu leave inside the room
                    stays too. */}
                <button
                  type="button"
                  data-testid="my-rooms-leave"
                  aria-label={`Leave ${room.name}`}
                  disabled={leavingId === room.roomId}
                  onClick={() => setConfirmLeave(room)}
                  className="min-h-[32px] min-w-[32px] px-2 flex-shrink-0 rounded text-[11px] text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors cursor-pointer bg-transparent border-0 disabled:opacity-50 disabled:cursor-default"
                >
                  {leavingId === room.roomId ? 'Leaving…' : 'Leave'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Same title / message / confirm label as PublicLayout's user-menu
          leave confirm — duplicated on purpose for now; keep the two in step. */}
      {confirmLeave && (
        <ConfirmModal
          title={`Leave ${confirmLeave.name}?`}
          message="You can rejoin any time. Leaving takes this room off My Game Rooms; your scores stay on its boards."
          confirmLabel="Leave room"
          onConfirm={leaveConfirmed}
          onCancel={() => setConfirmLeave(null)}
        />
      )}
    </div>
  );
}
