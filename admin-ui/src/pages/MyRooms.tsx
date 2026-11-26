import { useState } from 'react';
import { Building2 } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import LoginButtons from '../components/LoginButtons';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';
import ArcaidPage from '../components/parts/ArcaidPage';
import Panel, { PanelGroup } from '../components/parts/Panel';
import Button, { ButtonLink } from '../components/parts/Button';
import { ListRows, ListRow } from '../components/parts/ListRow';
import { SkeletonRows } from '../components/parts/Skeleton';
import EmptyState from '../components/parts/EmptyState';
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
      <ArcaidPage title="My Rooms" bare>
        <div className="text-center px-6">
          <Building2 size={40} className="text-muted/30 mx-auto mb-3" />
          <p className="text-muted mb-4">Log in to see the rooms you belong to</p>
          <LoginButtons
            onDiscordLogin={() => loginWithDiscord('__myrooms__', '/my-rooms')}
            onGoogleLogin={() => loginWithGoogle('__myrooms__', '/my-rooms')}
            className="justify-center"
          />
        </div>
      </ArcaidPage>
    );
  }

  return (
    <ArcaidPage
      title="My Rooms"
      width="column"
      overlays={
        /* Same title / message / confirm label as PublicLayout's user-menu
           leave confirm — duplicated on purpose for now; keep the two in step. */
        confirmLeave && (
          <ConfirmModal
            title={`Leave ${confirmLeave.name}?`}
            message="You can rejoin any time. Leaving takes this room off My Game Rooms; your scores stay on its boards."
            confirmLabel="Leave room"
            tone="pink"
            onConfirm={leaveConfirmed}
            onCancel={() => setConfirmLeave(null)}
          />
        )
      }
    >
      <PanelGroup id="my-rooms" tone="cyan" title="Your rooms" sub="Tap a room to open it.">
        <Panel wide title={loading ? 'Rooms' : `Rooms (${rooms.length})`}>
          {loading ? (
            <SkeletonRows count={3} label="Loading your rooms" />
          ) : rooms.length === 0 ? (
            <EmptyState title="You haven't joined any rooms yet." action={<ButtonLink to="/">Find a room</ButtonLink>}>
              Add a room from the home page, submit a score, accept an admin invite, or claim an anonymous identity to join a room.
            </EmptyState>
          ) : (
            <ListRows label="Your rooms">
              {rooms.map(room => (
                <ListRow
                  key={room.roomId}
                  testId="my-rooms-row"
                  href={`/${room.slug}`}
                  name={room.name}
                  tile={room.logoUrl ? <img src={room.logoUrl} alt="" /> : room.name.charAt(0).toUpperCase()}
                  caption={`${formatRelativeTime(room.lastActivityAt)} · ${SOURCE_LABEL[room.source as RoomMemberSource]}`}
                  /* W21 removed a one-tap leave ICON (a tap aimed at the title left the room); W84
                     (owner, 2026-11-01) brought it back as a LABELLED, CONFIRMED control OUTSIDE the
                     row's link, so a tap on it never navigates and a tap on the title never leaves. */
                  trailing={
                    <Button
                      variant="secondary"
                      size="xs"
                      data-testid="my-rooms-leave"
                      aria-label={`Leave ${room.name}`}
                      disabled={leavingId === room.roomId}
                      onClick={() => setConfirmLeave(room)}
                    >
                      {leavingId === room.roomId ? 'Leaving…' : 'Leave'}
                    </Button>
                  }
                />
              ))}
            </ListRows>
          )}
        </Panel>
      </PanelGroup>
    </ArcaidPage>
  );
}
