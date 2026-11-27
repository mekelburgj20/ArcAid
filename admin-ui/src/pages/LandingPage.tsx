import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trophy } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import { useRetryingLoad } from '../hooks/useRetryingLoad';
import { useToast } from '../components/Toast';
import ArcaidPage from '../components/parts/ArcaidPage';
import { ConfirmDialog } from '../components/parts/Dialog';
import UserMenu from '../components/UserMenu';
import LoginButtons from '../components/LoginButtons';
import GlobalThemeToggle from '../components/GlobalThemeToggle';
import DisplaySettingsButton from '../components/DisplaySettingsButton';
import ArcaidLogoAnimated from '../components/ArcaidLogoAnimated';
import RoomSwitcher, { type SwitcherCurrentRoom } from '../components/RoomSwitcher';
import GlobalPanel from '../components/landing/GlobalPanel';
import { MoreRooms, YourRooms } from '../components/landing/RoomSections';
import {
  byActivityThenName, normalizePublicRoom, splitLandingRooms,
  type MemberRoom, type PublicRoom, type RoomCardData,
} from '../lib/landingRooms';

/**
 * The landing page (`/`), on the Arcaid look since G35c (owner 2026-11-26,
 * from the approved mockup): a fixed dark page on the arcade carpet
 * (`parts/ArcaidPage`) that no longer follows Light / Dark, like Account
 * Settings. Top to bottom:
 *
 * 1. The header: the Arcaid logo, the room switcher (signed in; the landing
 *    page is its `home` place, "Your rooms"), Global, the sun/moon, and the
 *    user menu or the Log in buttons with Display settings.
 * 2. The animated logo and the motto, small enough that the Global panel and
 *    the top of Your rooms sit above the fold of a 1600 x 1000 screen.
 * 3. The Global Scoreboard panel (`components/landing/GlobalPanel`).
 * 4. Your rooms (signed in, when you have any): the cards that replaced the
 *    retired My Rooms page, Leave room in each card's ⋯ menu.
 * 5. The listed rooms you have not joined (all of them signed out), concept
 *    D "What's on", then Create a game room.
 *
 * Each section reads on its own `useRetryingLoad`: a failure for now shows
 * `LoadFailedNotice` in that section only, never an empty page.
 */

/** The landing page as a place in the room switcher: no room, the grid icon, "Your rooms". */
const HOME_PLACE: SwitcherCurrentRoom = {
  kind: 'home', slug: '', name: 'Your rooms', title: 'Your rooms', logoUrl: null, roomId: null,
};

/** The hero mark's width: the Global panel and the top of Your rooms stay above a 1000 px fold. */
const HERO_WIDTH = 260;

export default function LandingPage() {
  const { discordUser, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
  const signedIn = !!discordUser;
  const { toast } = useToast();
  // The viewer's rooms: the switcher, Your rooms, and which rooms the list below leaves out.
  const {
    rooms: myRoomsRaw, loading: myRoomsLoading, phase: myPhase, refetch: retryMyRooms,
    leave, joinDetailed, requestJoin,
  } = useMyRooms({ retry: true });

  // The listed rooms (`/api/rooms`, one call for all of them).
  const [listed, setListed] = useState<PublicRoom[]>([]);
  const { load: loadRooms, phase: roomsPhase } = useRetryingLoad(
    () => fetch('/api/rooms'),
    async res => {
      const json: unknown = await res.json();
      if (!Array.isArray(json)) throw new Error('shape');
      setListed((json as PublicRoom[]).filter(r => r.is_public));
    },
    'rooms',
  );
  useEffect(() => { loadRooms(); }, [loadRooms]);

  const mine = useMemo(
    () => (signedIn ? myRoomsRaw.filter(r => r.slug).sort(byActivityThenName) : []),
    [signedIn, myRoomsRaw],
  );
  const listedById = useMemo(() => new Map(listed.map(r => [r.id, normalizePublicRoom(r)])), [listed]);
  // The rooms you have not joined, most active players first.
  const others = useMemo(
    () => splitLandingRooms(listed, signedIn ? myRoomsRaw : []).publicRooms
      .sort((a, b) => (b.activePlayers ?? 0) - (a.activePlayers ?? 0)),
    [listed, signedIn, myRoomsRaw],
  );
  // Signed in, the list waits for your rooms (or it would show yours for a moment); a failing read of them does not hold it up.
  const othersPhase = roomsPhase === 'ready' && signedIn && myPhase === 'loading' ? 'loading' : roomsPhase;

  // Leave room (a card's ⋯ menu), with the retired My Rooms page's confirm and words.
  const [confirmLeave, setConfirmLeave] = useState<MemberRoom | null>(null);
  const leaveConfirmed = async () => {
    const room = confirmLeave;
    setConfirmLeave(null);
    if (!room) return;
    // `leave` is optimistic: the card goes at once and comes back if the request fails.
    const ok = await leave(room.roomId);
    toast(
      ok ? `You left ${room.name}. You can rejoin any time.` : `Could not leave ${room.name} — try again.`,
      ok ? 'info' : 'error',
    );
  };

  // Join (an open or Discord-role room) and Ask to join (an approval room), as before G35c.
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(new Set());
  const [askJoin, setAskJoin] = useState<RoomCardData | null>(null);
  const handleJoin = async (room: RoomCardData) => {
    // v2.213.0 - a "Discord role required" room can refuse with a reason or queue the request; say which.
    const outcome = await joinDetailed(room.id, { name: room.name, slug: room.slug, logoUrl: room.logoUrl });
    if (!outcome.ok) toast(outcome.message, 'error');
    else if (outcome.status === 'pending') toast('Request sent - a room admin will review it.', 'info');
  };
  const sendRequestJoin = async (room: RoomCardData) => {
    const status = await requestJoin(room.id);
    if (status === 'pending') {
      setPendingRequests(prev => new Set(prev).add(room.id));
      toast('Request sent — a room admin will review it.', 'success');
    } else if (status === 'member') {
      toast(`Added ${room.name} to your rooms.`, 'success');
    } else {
      toast('Could not send your request — try again.', 'error');
    }
  };

  const switcher = (variant: 'inline' | 'brandrow') => (
    <RoomSwitcher variant={variant} current={HOME_PLACE} rooms={myRoomsRaw} loading={myRoomsLoading} signedIn />
  );

  const header = (
    <header className="lp-head">
      <div className="lp-head__row">
        <div className="lp-head__l">
          {/* This page IS `/`: the logo is not a link to itself. */}
          <img className="lp-head__mark" src="/arcaid-logo-wide-v2.png" alt="Arcaid" />
          {signedIn && <div className="hidden sm:block min-w-0">{switcher('inline')}</div>}
        </div>
        {/* No admin link here: super-admin login is reached directly (see Login). */}
        <nav className="lp-head__r" aria-label="Site">
          <Link to="/scoreboard" className="lp-navlink" aria-label="Global Scoreboard">
            <Trophy aria-hidden="true" />
            {/* A phone shows the trophy only, as the mockup. */}
            <span className="max-sm:sr-only">Global</span>
          </Link>
          <GlobalThemeToggle className="lp-iconbtn" />
          {!signedIn && <DisplaySettingsButton className="lp-iconbtn" />}
          {discordUser ? (
            <UserMenu user={discordUser} onLogout={logoutPlayer} />
          ) : (
            <LoginButtons
              onDiscordLogin={() => loginWithDiscord('__global__', '/')}
              onGoogleLogin={() => loginWithGoogle('__global__', '/')}
              // A phone's touch target is 44 px.
              buttonClassName="justify-center max-sm:min-h-11 max-sm:min-w-11"
            />
          )}
        </nav>
      </div>
      {/* A phone's header row is full: the switcher gets its own centred row under it. */}
      {signedIn && <div className="sm:hidden flex justify-center min-w-0 lp-head__row2">{switcher('brandrow')}</div>}
    </header>
  );

  return (
    <ArcaidPage
      title="Game rooms"
      header={header}
      width="wide"
      overlays={(
        <>
          {confirmLeave && (
            <ConfirmDialog
              open
              tone="pink"
              title={`Leave ${confirmLeave.name}?`}
              message="You can rejoin any time. Leaving takes this room off My Game Rooms; your scores stay on its boards."
              confirmLabel="Leave room"
              onConfirm={() => { void leaveConfirmed(); }}
              onCancel={() => setConfirmLeave(null)}
            />
          )}
          {askJoin && (
            <ConfirmDialog
              open
              tone="pink"
              title="Request to join?"
              message="This room requires approval to join — request?"
              confirmLabel="Request to join"
              onCancel={() => setAskJoin(null)}
              onConfirm={() => { const room = askJoin; setAskJoin(null); void sendRequestJoin(room); }}
            />
          )}
        </>
      )}
    >
      <div className="lp-hero">
        <h1 className="sr-only">Arcaid</h1>
        <ArcaidLogoAnimated variant="dark" maxWidth={HERO_WIDTH} />
        <p className="lp-hero__motto">Run the room. Settle the score. Own the arcade.</p>
      </div>

      <GlobalPanel />

      {signedIn && (
        <YourRooms
          rooms={mine}
          listedById={listedById}
          listedReady={roomsPhase === 'ready'}
          phase={myPhase}
          onRetry={() => { void retryMyRooms(); }}
          onLeave={setConfirmLeave}
        />
      )}

      <MoreRooms
        signedIn={signedIn}
        rooms={others}
        listedCount={listed.length}
        phase={othersPhase}
        onRetry={loadRooms}
        pending={pendingRequests}
        onJoin={room => { void handleJoin(room); }}
        onAskJoin={setAskJoin}
      />
    </ArcaidPage>
  );
}
