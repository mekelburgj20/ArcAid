import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Users, Gamepad2 } from 'lucide-react';
import LoadingState from '../components/LoadingState';

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

export default function LandingPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/rooms')
      .then(r => r.json())
      .then((data: Room[]) => setRooms(data.filter(r => r.is_public)))
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingState message="Loading..." />;

  return (
    <div className="min-h-screen bg-deep text-primary">
      {/* Google Fonts for Showcase style */}
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

      {/* Content */}
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="font-display text-3xl font-bold mb-3">Game Rooms</h1>
          <p className="text-muted">Choose a game room to view scoreboards and leaderboards.</p>
        </div>

        {rooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted">No game rooms available yet.</p>
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-8">
            {rooms.map(room => (
              <RoomCard key={room.id} room={room} />
            ))}
          </div>
        )}
      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}

function RoomCard({ room }: { room: Room }) {
  return (
    <div style={{
      width: 340,
      maxWidth: '100%',
      fontFamily: "'DM Sans', sans-serif",
    }}>
      <div style={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: 20,
        border: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(18,18,24,0.9)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        backdropFilter: 'blur(24px)',
      }}>
        {/* Accent bar */}
        <div style={{
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent)',
        }} />

        {/* Logo + Title area */}
        <div style={{ textAlign: 'center', padding: '28px 24px 16px' }}>
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
