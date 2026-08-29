import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Gamepad2, ChevronRight, Plus, Building2, BookmarkPlus, BookmarkCheck, Clock, Trophy } from 'lucide-react';
import LoadingState from '../components/LoadingState';
import { formatCompactNumber, relativeTimeFrom } from '../lib/format';
import { PlayerAvatar } from '../components/ScoreboardComponents';
import { useTheme } from '../components/ThemeProvider';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { useMyRooms } from '../hooks/useMyRooms';
import { useToast } from '../components/Toast';
import UserMenu from '../components/UserMenu';
import LoginButtons from '../components/LoginButtons';
import GlobalThemeToggle from '../components/GlobalThemeToggle';
import BrandWordmark from '../components/BrandWordmark';
import ArcaidLogoAnimated from '../components/ArcaidLogoAnimated';
import { splitLandingRooms, type PublicRoom, type RoomCardData } from '../lib/landingRooms';

type Room = PublicRoom;

interface RecentScore {
  id: string;
  score: number;
  iscored_username: string;
  /** v2.8.2: player's chosen global display name. (`display_name` on this interface
   * is the *game's* display name — keep them distinct.) */
  player_display_name: string | null;
  submitted_at: string;
  discord_user_id: string;
  global_game_id: string;
  game_name: string;
  display_name: string | null;
  local_image_path: string | null;
  wheel_image_path: string | null;
  image_url: string | null;
  avatar_hash: string | null;
  /** v2.35.0: full avatar URL for Google-identified players. */
  avatar_url: string | null;
}

function toCatalogueUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
  if (m) return `/api/catalogue-images/${m[1]}`;
  return path.startsWith('/') ? path : `/${path}`;
}

function imageForScore(s: RecentScore): string | null {
  if (s.local_image_path) return toCatalogueUrl(s.local_image_path);
  if (s.wheel_image_path) return toCatalogueUrl(s.wheel_image_path);
  if (s.image_url) return s.image_url;
  return null;
}

/* ─── Hero artwork (B2, v2.56.0 · re-lit v2.60.0) ───
 *
 * The hero mark follows the visitor's global-page polarity. Both polarities now
 * render `ArcaidLogoAnimated` — v2.60.0 added its `light` variant, a full
 * re-lighting of the same 620x560 composition for the #E8EAF0 canvas (purple
 * backdrop plate, glass-tube delta, dark glyph shadows in place of the cyan
 * halo, darkened glitch cyan). Same glitch keyframes, same cadence, so the two
 * polarities differ in colour and lighting only, never in motion.
 *
 * This replaces the v2.56.0 arrangement, which rendered a static PNG on light
 * because no animated light source had shipped with the logo pack. That loss —
 * "light mode has no glitch animation" — is gone; `/arcaid-logo-light-v1.png`
 * remains in `public/` only for `BrandWordmark`, which is deliberately static
 * in BOTH polarities (the header mark never animated).
 *
 * Both branches reserve the identical layout box (620 x 380 — the animated
 * wrap's cropped aspect), so the page below lays out the same either way and
 * the motto's proportional anchor keeps landing in the free band under the
 * mark. The light composition's plate bottom (canvas y 348) and delta tip
 * (y 383) both sit above the motto's anchor (y ~405), same as dark.
 */

const timeAgo = relativeTimeFrom;

export default function LandingPage() {
  const { discordUser, loginWithDiscord, loginWithGoogle, logoutPlayer } = useViewerAuth();
  // B2 (v2.56.0) — the hero mark swaps with polarity (see the hero-artwork note above).
  const { globalPageTheme } = useTheme();
  const isLight = globalPageTheme === 'light';
  const [rooms, setRooms] = useState<Room[]>([]);
  const [recentScores, setRecentScores] = useState<RecentScore[]>([]);
  const [loading, setLoading] = useState(true);
  // D2 (v2.38.0) — explicit join/leave. Same hook backs the bookmark toggle
  // here and the room-page affordance in PublicLayout/UserMenu.
  // v2.39.0 — requestJoin backs the "Request to join" branch for approval rooms.
  const { rooms: myRoomsRaw, join: joinRoom, leave: leaveRoom, requestJoin } = useMyRooms();
  // v2.39.0 — session-only "I already requested this room" set, so the card
  // reflects a pending request immediately after clicking without waiting on
  // a fresh /api/rooms fetch (that list doesn't carry per-viewer request state).
  const [pendingRequests, setPendingRequests] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      fetch('/api/rooms').then(r => r.json()).catch(() => []),
      fetch('/api/global/recent-scores?limit=20').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([roomData, scoreData]) => {
      setRooms((roomData as Room[]).filter(r => r.is_public));
      setRecentScores(scoreData as RecentScore[]);
    }).finally(() => setLoading(false));
  }, []);

  const { myRooms, publicRooms } = useMemo(
    () => splitLandingRooms(rooms, discordUser ? myRoomsRaw : []),
    [rooms, myRoomsRaw, discordUser]
  );

  const handleJoin = async (room: RoomCardData) => {
    const ok = await joinRoom(room.id, { name: room.name, slug: room.slug, logoUrl: room.logoUrl });
    if (!ok) toast('Could not join that room — try again.', 'error');
  };

  // v2.39.0 — approval rooms: the bookmark toggle becomes a "Request to
  // join" confirm + request instead of an instant join.
  const handleRequestJoin = async (room: RoomCardData) => {
    if (!window.confirm(`This room requires approval to join — request?`)) return;
    const status = await requestJoin(room.id);
    if (status === 'pending') {
      setPendingRequests(prev => new Set(prev).add(room.id));
      toast('Request sent — a room admin will review it.', 'success');
    } else if (status === 'member') {
      toast(`Added ${room.name} to My Game Rooms.`, 'success');
    } else {
      toast('Could not send your request — try again.', 'error');
    }
  };

  const handleLeave = async (room: RoomCardData) => {
    const ok = await leaveRoom(room.id);
    toast(ok ? `Left ${room.name}.` : 'Could not leave that room — try again.', ok ? 'info' : 'error');
  };

  const handleLogin = () => loginWithDiscord('__global__', '/');
  const handleGoogleLogin = () => loginWithGoogle('__global__', '/');

  if (loading) return <LoadingState message="Loading..." />;

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Google Fonts */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" />

      {/* Header */}
      {/* relative z-40: backdrop-blur creates a stacking context, which traps
          the UserMenu dropdown's z-50 inside it — without a z-index here the
          whole header paints below the position:relative sections that follow. */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm relative z-40">
        <div
          className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between"
          style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
        >
          <div className="flex items-center gap-3">
            {/* noLink: this page IS `/` — BrandWordmark's default self-link
                would be a no-op navigation to the current page. */}
            <BrandWordmark noLink />
          </div>
          <div className="flex items-center gap-3">
            {/* Super-admin login is intentionally NOT linked here — it's reached
                directly at /login (bookmark it). A public "Admin" link invited
                non-admins to OAuth in with __super__ intent and land on the
                (data-less, 403-gated) Super Admin shell — confusing, and needless
                attack surface. SuperAdminLayout also role-guards now. */}
            {/* Trophy icon matches the room pages' "Global" nav item
                (PublicLayout navItems) — owner ask 2026-08-28: the landing
                page's bare-text link looked like a different control. */}
            <Link to="/scoreboard" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-neon-cyan no-underline">
              <Trophy size={14} />
              Global
            </Link>
            {/* v2.50.0 (A1): the landing page is a global page, so it gets the
                same per-visitor light/dark toggle as /scoreboard. */}
            <GlobalThemeToggle />
            {discordUser ? (
              <UserMenu user={discordUser} onLogout={logoutPlayer} />
            ) : (
              <LoginButtons onDiscordLogin={handleLogin} onGoogleLogin={handleGoogleLogin} />
            )}
          </div>
        </div>
      </div>

      {/* Hero — Delta House Chrome wordmark. Prominent, first thing you see.
          v2.45.1 fix: no dedicated backdrop section — it renders directly on
          the page's own bg-deep (the same background the room grid below
          sits on) so there's no visible seam between hero and content.
          v2.56.0 (B2) / v2.60.0: the mark follows polarity — same animated
          component, its `light` variant re-lit for the pale canvas. */}
      <div style={{
        padding: '8px 16px 0',
        display: 'flex',
        justifyContent: 'center',
        /* v2.45.3 — the mark floats ABOVE the scoreboard ticker (the promo
           below pulls itself up behind the triangle's lower half via
           negative margin). pointer-events pass through: the logo is
           decorative, the tiles under it stay clickable. */
        position: 'relative',
        zIndex: 10,
        pointerEvents: 'none',
      }}>
        {/* Relative box matching the logo's bounds so the motto can anchor
            proportionally inside the mark (the free band between the
            wordmark's bottom and the ticker tiles, over the triangle tip). */}
        <div style={{ position: 'relative', width: '100%', maxWidth: 680 }}>
          <ArcaidLogoAnimated variant={isLight ? 'light' : 'dark'} maxWidth={680} />

          <p data-testid="landing-motto" style={{
            position: 'absolute',
            left: 0,
            right: 0,
            /* v2.45.5 — user restack: motto sits UNDER the delta (below the
               triangle tip ≈92% of the box), and the tiles slide under the
               motto (see the reduced pull-up at the promo call site). */
            top: '81.5%',
            margin: 0,
            textAlign: 'center',
            fontFamily: "'DM Sans', sans-serif",
            fontSize: 'clamp(10px, 2.1vw, 14px)',
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            /* B3 (v2.56.0) — polarity-driven. Dark keeps the exact
               white-at-72% + cyan glow it had; light becomes the logo plate's
               purple with the glow dropped (see --sb-motto-* in index.css). */
            color: 'var(--sb-motto-fg)',
            textShadow: 'var(--sb-motto-shadow)',
            /* v2.49.0 — user: center the motto under the WORDMARK, which sits
               a touch left of the logo box's center (the chrome ball on the
               "i" pads the right edge). Nudge + wider sentence gaps (nbsp +
               space so nowrap doesn't collapse them). */
            /* -2.5% of the box = -17px at the 680px cap — measured: wordmark
               center 703 vs box center 720 at 1440w (harness measurement). */
            transform: 'translateX(-2.5%)',
          }}>
            {'Run the room.  Settle the score.  Own the arcade.'}
          </p>
        </div>
      </div>

      {/* Global Scoreboard Promo — pulled up so the scrolling tiles slide
          behind the bottom of the triangle, just under the ARCAID wordmark
          (user layout direction, 2026-07-26). The clamp keeps the overlap
          proportional on phones (hero height scales with viewport width)
          and fixed once the hero hits its 680px cap. */}
      {recentScores.length > 0 && (
        <div style={{ marginTop: 'clamp(-18px, -2.5vw, -8px)', position: 'relative' }}>
          <ScoreboardPromo scores={recentScores} />
        </div>
      )}

      {/* My Game Rooms (D2 — signed-in only, non-empty only) */}
      {discordUser && myRooms.length > 0 && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-12">
          <div className="text-center mb-8">
            <div className="flex items-center justify-center gap-2 mb-2">
              <Building2 size={22} className="text-neon-cyan" />
              <h2 className="font-display text-2xl font-bold">My Game Rooms</h2>
            </div>
            <p className="text-muted text-sm">Rooms you belong to.</p>
          </div>
          <div className="flex flex-wrap justify-center gap-8 items-stretch">
            {myRooms.map(room => (
              <RoomCard
                key={room.id}
                room={room}
                toggle={discordUser ? { isMember: true, onToggle: () => handleLeave(room) } : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Game Rooms */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="font-display text-3xl font-bold mb-3">Game Rooms</h1>
          <p className="text-muted">Choose a game room to view its leaderboards.</p>
        </div>

        {publicRooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted mb-6">
              {rooms.length === 0 ? 'No game rooms yet — create the first one.' : "You're a member of every game room."}
            </p>
            <CreateRoomCard />
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-8 items-stretch">
            {publicRooms.map(room => {
              const isApproval = room.joinPolicy === 'approval';
              const isPending = pendingRequests.has(room.id);
              const toggle = !discordUser ? undefined : isApproval
                ? {
                  isMember: false,
                  pending: isPending,
                  onToggle: () => handleRequestJoin(room),
                }
                : { isMember: false, onToggle: () => handleJoin(room) };
              return <RoomCard key={room.id} room={room} toggle={toggle} />;
            })}
            <CreateRoomCard />
          </div>
        )}
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}

/* ─── Global Scoreboard Promo Section ─── */

/**
 * v2.128.0 (owner: "about 30% larger") — the ticker tile grew 220px → 286px.
 * Everything inside it, the row gap, and the animation DURATION are scaled by
 * the same factor so the artwork/type stay in proportion and the scroll SPEED
 * (px/s) is unchanged: the row is 1.3× wider, so it needs 1.3× as long to
 * travel its own half-width.
 */
const TICKER_SCALE = 1.3;
/** Seconds of travel per score at the pre-v2.128.0 tile size. */
const TICKER_SECONDS_PER_SCORE = 4;

function ScoreboardPromo({ scores }: { scores: RecentScore[] }) {
  // Duplicate the list so the CSS animation loops seamlessly
  const doubled = useMemo(() => [...scores, ...scores], [scores]);

  return (
    <div data-testid="landing-ticker-band" style={{
      position: 'relative',
      overflow: 'hidden',
      borderBottom: '1px solid var(--sb-ticker-edge)',
      /* v2.45.3 — fade the tint IN from transparent so the section has no
         visible top edge (the old 0.08-at-0% start painted a hard seam
         where the band met the page background above it).
         v2.56.0 (B1) — token-driven so it follows polarity. */
      background: 'var(--sb-ticker-band)',
    }}>
      {/* Scrolling ticker — its top row slides up behind the logo
          (see the negative-margin wrapper at the call site). */}
      <div style={{
        overflow: 'hidden',
        padding: '4px 0 24px',
        maskImage: 'linear-gradient(90deg, transparent 0%, black 5%, black 95%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(90deg, transparent 0%, black 5%, black 95%, transparent 100%)',
      }}>
        <Link to="/scoreboard" style={{ textDecoration: 'none', display: 'block' }}>
          <div
            style={{
              display: 'flex',
              gap: Math.round(14 * TICKER_SCALE),
              width: 'max-content',
              animation: `ticker-scroll ${scores.length * TICKER_SECONDS_PER_SCORE * TICKER_SCALE}s linear infinite`,
            }}
          >
            {doubled.map((s, i) => (
              <ScoreTickerCard key={`${s.id}-${i}`} score={s} />
            ))}
          </div>
        </Link>
      </div>

      {/* View All Scores — under the tiles, hugging the RIGHT VIEWPORT edge
          (not the max-w-5xl column): the ticker is full-bleed, so the button
          lands under the last visible tile (user direction, round 6). */}
      <div className="px-4 sm:px-8 pb-5" style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Link
          to="/scoreboard"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 20px',
            borderRadius: 10,
            background: 'var(--sb-ticker-cta-bg)',
            border: '1px solid var(--sb-ticker-cta-border)',
            color: 'var(--sb-ticker-cta-fg)',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
            letterSpacing: 0.5,
            transition: 'all 0.2s',
            fontFamily: "'DM Sans', sans-serif",
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'var(--sb-ticker-cta-bg-hover)';
            e.currentTarget.style.transform = 'translateY(-1px)';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'var(--sb-ticker-cta-bg)';
            e.currentTarget.style.transform = 'translateY(0)';
          }}
        >
          View All Scores
          <ChevronRight size={14} />
        </Link>
      </div>

      {/* Inline keyframes */}
      <style>{`
        @keyframes ticker-scroll {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          div[style*="ticker-scroll"] {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}

/* ─── Ticker Card ─── */

function ScoreTickerCard({ score }: { score: RecentScore }) {
  const navigate = useNavigate();
  const img = imageForScore(score);
  const gameName = score.display_name || score.game_name;
  const [imgError, setImgError] = useState(false);

  // v2.8.2: prefer the chosen display_name.
  const playerLabel = score.player_display_name || score.iscored_username || '?';
  // Per-player hue for the no-artwork tile. Saturation + the two gradient
  // stops' lightness come from tokens (B1) so the tile flips with polarity
  // while keeping its variety.
  const hue = playerLabel
    ? playerLabel.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360
    : 200;

  return (
    <div data-testid="landing-ticker-card" style={{
      flexShrink: 0,
      // v2.128.0: 220 → 286 (×1.3, see TICKER_SCALE). The 80vw cap only bites
      // below ~357px wide (a 390px phone still gets the full 286) — it keeps
      // the next tile peeking in on the narrowest handsets so the band still
      // reads as a scrolling row rather than one clipped card.
      width: Math.round(220 * TICKER_SCALE),
      maxWidth: '80vw',
      borderRadius: 18,
      overflow: 'hidden',
      background: 'var(--sb-ticker-card-bg)',
      border: '1px solid var(--sb-ticker-card-border)',
      boxShadow: 'var(--sb-ticker-card-shadow)',
      cursor: 'pointer',
      transition: 'transform 0.2s, box-shadow 0.2s',
      fontFamily: "'DM Sans', sans-serif",
    }}
      onClick={e => {
        if (score.global_game_id) {
          e.preventDefault();
          e.stopPropagation();
          navigate(`/games/${score.global_game_id}`);
        }
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = 'translateY(-2px)';
        e.currentTarget.style.boxShadow = 'var(--sb-ticker-card-shadow-hover)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = 'var(--sb-ticker-card-shadow)';
      }}
    >
      {/* Game image */}
      <div style={{
        height: Math.round(80 * TICKER_SCALE),
        background: 'var(--sb-ticker-art-bg)',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {img && !imgError ? (
          <img
            src={img}
            alt=""
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: 0.7,
            }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, hsl(${hue} var(--sb-ticker-art-sat) var(--sb-ticker-art-l1)), hsl(${hue} var(--sb-ticker-art-sat) var(--sb-ticker-art-l2)))`,
          }}>
            <Gamepad2 size={36} style={{ color: 'var(--sb-ticker-art-icon)' }} />
          </div>
        )}
        {/* Score overlay */}
        <div style={{
          position: 'absolute',
          bottom: 8,
          right: 10,
          /* Reuses the Global Scoreboard's on-art pill token — this chip sits
             on arbitrary game artwork and has the same legibility problem. */
          background: 'var(--sb-pill-bg)',
          backdropFilter: 'blur(8px)',
          borderRadius: 8,
          padding: '3px 10px',
          fontSize: 17,
          fontWeight: 700,
          color: 'var(--sb-ticker-score-fg)',
          fontFamily: "'DM Mono', monospace",
        }}>
          {formatCompactNumber(score.score)}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: '13px 16px 16px' }}>
        <div style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--color-primary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 8,
        }}>
          {gameName}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
            {/* B1 (v2.56.0) — the local initials/hue-hash duplicate is gone;
                this is the same avatar the scoreboards render, so anonymous
                rows get the themed silhouette instead of a coloured letter. */}
            <PlayerAvatar
              username={playerLabel}
              discordUserId={score.discord_user_id}
              avatarHash={score.avatar_hash}
              avatarUrl={score.avatar_url}
              size={23}
            />
            <span style={{
              fontSize: 14,
              color: 'var(--color-muted)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {playerLabel}
            </span>
          </div>
          <span style={{
            fontSize: 13,
            color: 'var(--color-faint)',
            flexShrink: 0,
            marginLeft: 8,
          }}>
            {timeAgo(score.submitted_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

/* ─── Create Room Card ─── */

function CreateRoomCard() {
  return (
    <div style={{ width: 340, maxWidth: '100%', fontFamily: "'DM Sans', sans-serif" }}>
      <Link
        to="/create-room"
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 20,
          border: '1px dashed rgba(99,210,151,0.35)',
          background: 'rgba(99,210,151,0.03)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          minHeight: 220,
          textDecoration: 'none',
          transition: 'transform 0.2s, box-shadow 0.2s, border-color 0.2s, background 0.2s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.borderColor = 'rgba(99,210,151,0.6)';
          e.currentTarget.style.background = 'rgba(99,210,151,0.06)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.borderColor = 'rgba(99,210,151,0.35)';
          e.currentTarget.style.background = 'rgba(99,210,151,0.03)';
        }}
      >
        <div style={{
          width: 48,
          height: 48,
          borderRadius: '50%',
          background: 'rgba(99,210,151,0.12)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 14,
        }}>
          <Plus size={24} style={{ color: '#63d297' }} />
        </div>
        <span style={{ fontSize: 16, fontWeight: 700, color: '#63d297' }}>
          Create Game Room
        </span>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
          Free — sign in with Discord to start
        </span>
      </Link>
    </div>
  );
}

/* ─── Room Card ─── */

interface RoomCardToggle {
  /** True renders the "member" (leave) state; false the "join" state. */
  isMember: boolean;
  /** v2.39.0 — approval rooms: a request already sent this session. Renders
   * a disabled "pending" state instead of the join affordance. */
  pending?: boolean;
  onToggle: () => void;
}

function RoomCard({ room, toggle }: { room: RoomCardData; toggle?: RoomCardToggle }) {
  const hasStats = room.activeGames !== undefined && room.activePlayers !== undefined;
  return (
    <div style={{
      width: 340,
      maxWidth: '100%',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div
        style={{
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 20,
          border: '1px solid rgba(255,255,255,0.06)',
          background: 'rgba(18,18,24,0.9)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          backdropFilter: 'blur(24px)',
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          cursor: 'pointer',
          transition: 'transform 0.2s, box-shadow 0.2s, border-color 0.2s',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.boxShadow = '0 12px 40px rgba(99,210,151,0.18)';
          e.currentTarget.style.borderColor = 'rgba(99,210,151,0.25)';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.transform = 'translateY(0)';
          e.currentTarget.style.boxShadow = '0 8px 32px rgba(0,0,0,0.3)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
        }}
      >
        {/* Card-wide click target → scoreboard. Inner interactives raise z-index. */}
        <Link
          to={`/${room.slug}/`}
          aria-label={`View ${room.name} scoreboard`}
          style={{ position: 'absolute', inset: 0, zIndex: 1 }}
        />

        {/* D2 (v2.38.0) — bookmark join/leave toggle. zIndex 2 + preventDefault/
            stopPropagation so it never triggers the card-wide Link above it. */}
        {toggle && (
          <button
            type="button"
            onClick={e => { e.preventDefault(); e.stopPropagation(); if (!toggle.pending) toggle.onToggle(); }}
            disabled={toggle.pending}
            aria-label={toggle.pending ? `Request pending for ${room.name}` : toggle.isMember ? `Leave ${room.name}` : `Add ${room.name} to My Game Rooms`}
            title={toggle.pending ? 'Request pending — waiting on a room admin' : toggle.isMember ? 'Leave this room' : 'Add to My Game Rooms'}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              zIndex: 2,
              width: 32,
              height: 32,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '50%',
              background: toggle.pending ? 'rgba(251,191,36,0.12)' : toggle.isMember ? 'rgba(99,210,151,0.15)' : 'rgba(255,255,255,0.06)',
              border: `1px solid ${toggle.pending ? 'rgba(251,191,36,0.4)' : toggle.isMember ? 'rgba(99,210,151,0.4)' : 'rgba(255,255,255,0.14)'}`,
              color: toggle.pending ? '#fbbf24' : toggle.isMember ? '#63d297' : 'rgba(255,255,255,0.55)',
              cursor: toggle.pending ? 'default' : 'pointer',
              transition: 'background 0.15s, border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={e => {
              if (toggle.pending) return;
              e.currentTarget.style.background = toggle.isMember ? 'rgba(99,210,151,0.25)' : 'rgba(255,255,255,0.12)';
            }}
            onMouseLeave={e => {
              if (toggle.pending) return;
              e.currentTarget.style.background = toggle.isMember ? 'rgba(99,210,151,0.15)' : 'rgba(255,255,255,0.06)';
            }}
          >
            {toggle.pending ? <Clock size={16} /> : toggle.isMember ? <BookmarkCheck size={16} /> : <BookmarkPlus size={16} />}
          </button>
        )}

        {/* Accent bar */}
        <div style={{
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
        }} />

        {/* Logo + Title area */}
        <div style={{ textAlign: 'center', padding: '28px 24px 16px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {room.logoUrl && (
            <img
              src={room.logoUrl}
              alt=""
              style={{
                display: 'block',
                margin: '0 auto 16px',
                maxWidth: 80,
                maxHeight: 80,
                objectFit: 'contain',
                filter: 'drop-shadow(0 4px 12px rgba(0,0,0,0.5))',
              }}
            />
          )}
          <h2 style={{
            fontSize: 22,
            fontWeight: 700,
            color: '#ffffff',
            lineHeight: 1.2,
            marginBottom: 8,
            fontFamily: "'DM Sans', sans-serif",
          }}>
            {room.name}
          </h2>
          {room.description && (
            <p style={{
              fontSize: 13,
              color: 'rgba(255,255,255,0.5)',
              lineHeight: 1.5,
              margin: 0,
            }}>
              {room.description}
            </p>
          )}
        </div>

        {hasStats && (
          <>
            {/* Divider */}
            <div style={{
              height: 1,
              margin: '0 20px',
              background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
            }} />

            {/* Stats */}
            <div style={{
              display: 'flex',
              justifyContent: 'center',
              gap: 32,
              padding: '16px 24px',
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
                  <Users size={14} style={{ color: '#63d297' }} />
                  <span style={{ fontSize: 20, fontWeight: 700, color: '#63d297', fontFamily: "'DM Mono', monospace" }}>
                    {room.activePlayers}
                  </span>
                </div>
                <span style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
                  Players
                </span>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 4 }}>
                  <Gamepad2 size={14} style={{ color: '#63d297' }} />
                  <span style={{ fontSize: 20, fontWeight: 700, color: '#63d297', fontFamily: "'DM Mono', monospace" }}>
                    {room.activeGames}
                  </span>
                </div>
                <span style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)' }}>
                  Active Games
                </span>
              </div>
            </div>
          </>
        )}

        {/* Divider */}
        <div style={{
          height: 1,
          margin: '0 20px',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent)',
        }} />

        {/* Footer */}
        <div style={{
          padding: '14px 24px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <Link
            to={`/${room.slug}/`}
            style={{
              fontSize: 12,
              color: '#63d297',
              fontWeight: 600,
              textDecoration: 'none',
              letterSpacing: 1,
              textTransform: 'uppercase',
              position: 'relative',
              zIndex: 2,
            }}
          >
            View Scoreboard &rarr;
          </Link>
          {room.discordInviteUrl && (
            <a
              href={room.discordInviteUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                fontSize: 11,
                color: 'rgba(255,255,255,0.4)',
                textDecoration: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                position: 'relative',
                zIndex: 2,
              }}
            >
              <svg width="16" height="12" viewBox="0 0 71 55" fill="currentColor">
                <path d="M60.1 4.9A58.5 58.5 0 0045.4.2a.2.2 0 00-.2.1 40.8 40.8 0 00-1.8 3.7 54 54 0 00-16.2 0A37.5 37.5 0 0025.4.3a.2.2 0 00-.2-.1A58.4 58.4 0 0010.5 5 59.5 59.5 0 00.4 45a.3.3 0 00.1.2 58.7 58.7 0 0017.7 9 .2.2 0 00.3-.1 42 42 0 003.6-5.9.2.2 0 00-.1-.3 38.7 38.7 0 01-5.5-2.6.2.2 0 01.5-.4l1.1.9a.2.2 0 00.3 0 41.9 41.9 0 0035.6 0 .2.2 0 00.2 0l1.1-.8a.2.2 0 01.5.3c-1.8 1-3.6 1.9-5.6 2.6a.2.2 0 00-.1.4 47.2 47.2 0 003.7 5.9.2.2 0 00.2.1 58.5 58.5 0 0017.7-9 .3.3 0 00.1-.2c1.4-14.4-2.3-26.9-9.8-38A.2.2 0 0060 5zM23.7 36.9c-3.3 0-6-3-6-6.7s2.7-6.7 6-6.7c3.4 0 6.1 3 6 6.7 0 3.7-2.6 6.7-6 6.7zm22.2 0c-3.3 0-6-3-6-6.7s2.6-6.7 6-6.7c3.4 0 6 3 6 6.7 0 3.7-2.6 6.7-6 6.7z" />
              </svg>
              Join Discord
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
