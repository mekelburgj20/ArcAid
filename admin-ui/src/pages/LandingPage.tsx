import { useEffect, useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Gamepad2, Trophy, ChevronRight, Plus } from 'lucide-react';
import LoadingState from '../components/LoadingState';
import { formatCompactNumber } from '../lib/format';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
  logo_url: string | null;
  activeGames: number;
  activePlayers: number;
  discordInviteUrl: string | null;
}

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function avatarUrl(discordUserId: string, avatarHash: string): string {
  return `https://cdn.discordapp.com/avatars/${discordUserId}/${avatarHash}.png?size=64`;
}

export default function LandingPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [recentScores, setRecentScores] = useState<RecentScore[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/rooms').then(r => r.json()).catch(() => []),
      fetch('/api/global/recent-scores?limit=20').then(r => r.ok ? r.json() : []).catch(() => []),
    ]).then(([roomData, scoreData]) => {
      setRooms((roomData as Room[]).filter(r => r.is_public));
      setRecentScores(scoreData as RecentScore[]);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingState message="Loading..." />;

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Google Fonts */}
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" />

      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/arcaid-logo.png" alt="ArcAid" className="w-10 h-10" />
            <span className="font-pixel text-neon-cyan text-sm tracking-wider">ARCAID</span>
          </div>
          <Link
            to="/login"
            className="text-xs text-muted hover:text-neon-cyan transition-colors no-underline"
          >
            Admin
          </Link>
        </div>
      </div>

      {/* Global Scoreboard Promo */}
      {recentScores.length > 0 && (
        <ScoreboardPromo scores={recentScores} />
      )}

      {/* Game Rooms */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="font-display text-3xl font-bold mb-3">Game Rooms</h1>
          <p className="text-muted">Choose a game room to view its leaderboards.</p>
        </div>

        {rooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted mb-6">No game rooms yet — create the first one.</p>
            <CreateRoomCard />
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-8 items-stretch">
            {rooms.map(room => (
              <RoomCard key={room.id} room={room} />
            ))}
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

function ScoreboardPromo({ scores }: { scores: RecentScore[] }) {
  // Duplicate the list so the CSS animation loops seamlessly
  const doubled = useMemo(() => [...scores, ...scores], [scores]);

  return (
    <div style={{
      position: 'relative',
      overflow: 'hidden',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      background: 'linear-gradient(180deg, rgba(139,92,246,0.08) 0%, transparent 100%)',
    }}>
      {/* Header row */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-8 pb-4">
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Trophy size={22} style={{ color: '#fbbf24' }} />
            <h2 style={{
              fontSize: 20,
              fontWeight: 700,
              color: '#ffffff',
              fontFamily: "'DM Sans', sans-serif",
              margin: 0,
            }}>
              Global Scoreboard
            </h2>
          </div>
          <Link
            to="/scoreboard"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 20px',
              borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(139,92,246,0.5), rgba(236,72,153,0.5))',
              border: '1px solid rgba(139,92,246,0.4)',
              color: '#ffffff',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              letterSpacing: 0.5,
              transition: 'all 0.2s',
              fontFamily: "'DM Sans', sans-serif",
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139,92,246,0.7), rgba(236,72,153,0.7))';
              e.currentTarget.style.transform = 'translateY(-1px)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'linear-gradient(135deg, rgba(139,92,246,0.5), rgba(236,72,153,0.5))';
              e.currentTarget.style.transform = 'translateY(0)';
            }}
          >
            View All Scores
            <ChevronRight size={14} />
          </Link>
        </div>
        <p style={{
          fontSize: 13,
          color: 'rgba(255,255,255,0.45)',
          margin: '6px 0 0',
          fontFamily: "'DM Sans', sans-serif",
        }}>
          Recent scores from players across all game rooms
        </p>
      </div>

      {/* Scrolling ticker */}
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
              gap: 14,
              width: 'max-content',
              animation: `ticker-scroll ${scores.length * 4}s linear infinite`,
            }}
          >
            {doubled.map((s, i) => (
              <ScoreTickerCard key={`${s.id}-${i}`} score={s} />
            ))}
          </div>
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
  const [avatarError, setAvatarError] = useState(false);
  const hasAvatar = score.discord_user_id && score.avatar_hash && !avatarError;

  // Initials fallback (v2.8.2: prefer chosen display_name).
  const playerLabel = score.player_display_name || score.iscored_username || '?';
  const initial = playerLabel[0].toUpperCase();
  const hue = playerLabel
    ? playerLabel.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 360
    : 200;

  return (
    <div style={{
      flexShrink: 0,
      width: 220,
      borderRadius: 14,
      overflow: 'hidden',
      background: 'rgba(18,18,24,0.95)',
      border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
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
        e.currentTarget.style.boxShadow = '0 6px 24px rgba(139,92,246,0.2)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
      }}
    >
      {/* Game image */}
      <div style={{
        height: 80,
        background: 'rgba(255,255,255,0.03)',
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
            background: `linear-gradient(135deg, hsl(${hue}, 30%, 12%), hsl(${hue}, 30%, 8%))`,
          }}>
            <Gamepad2 size={28} style={{ color: 'rgba(255,255,255,0.15)' }} />
          </div>
        )}
        {/* Score overlay */}
        <div style={{
          position: 'absolute',
          bottom: 6,
          right: 8,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(8px)',
          borderRadius: 6,
          padding: '2px 8px',
          fontSize: 13,
          fontWeight: 700,
          color: '#fbbf24',
          fontFamily: "'DM Mono', monospace",
        }}>
          {formatCompactNumber(score.score)}
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: '10px 12px 12px' }}>
        <div style={{
          fontSize: 12,
          fontWeight: 600,
          color: '#ffffff',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          marginBottom: 6,
        }}>
          {gameName}
        </div>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            {hasAvatar ? (
              <img
                src={avatarUrl(score.discord_user_id, score.avatar_hash!)}
                alt=""
                width={18}
                height={18}
                style={{ borderRadius: '50%', flexShrink: 0 }}
                onError={() => setAvatarError(true)}
              />
            ) : (
              <div style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                flexShrink: 0,
                background: `hsl(${hue}, 50%, 35%)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 10,
                fontWeight: 700,
                color: '#fff',
              }}>
                {initial}
              </div>
            )}
            <span style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              {playerLabel}
            </span>
          </div>
          <span style={{
            fontSize: 10,
            color: 'rgba(255,255,255,0.3)',
            flexShrink: 0,
            marginLeft: 6,
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

function RoomCard({ room }: { room: Room }) {
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
        {/* Accent bar */}
        <div style={{
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
        }} />

        {/* Logo + Title area */}
        <div style={{ textAlign: 'center', padding: '28px 24px 16px', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
          {room.logo_url && (
            <img
              src={room.logo_url}
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
