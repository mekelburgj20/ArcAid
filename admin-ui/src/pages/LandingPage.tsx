import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import LoadingState from '../components/LoadingState';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
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
      {/* Header */}
      <div className="border-b border-border bg-surface/80 backdrop-blur-sm">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
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
      <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12">
        <div className="text-center mb-12">
          <h1 className="font-display text-3xl font-bold mb-3">Game Rooms</h1>
          <p className="text-muted">Choose a game room to view scoreboards and leaderboards.</p>
        </div>

        {rooms.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted">No game rooms available yet.</p>
          </div>
        ) : (
          <div className="flex flex-wrap justify-center gap-6">
            {rooms.map(room => (
              <Link
                key={room.id}
                to={`/${room.slug}/`}
                className="no-underline group w-full sm:w-[calc(50%-0.75rem)] lg:w-[calc(33.333%-1rem)]"
              >
                <div className="bg-surface border border-border rounded-lg p-6 hover:border-neon-cyan/40 hover:shadow-[0_0_15px_rgba(0,255,255,0.1)] transition-all">
                  <h3 className="font-display text-lg font-bold text-primary group-hover:text-neon-cyan transition-colors mb-2">
                    {room.name}
                  </h3>
                  {room.description && (
                    <p className="text-muted text-sm line-clamp-2">{room.description}</p>
                  )}
                  <div className="mt-4 text-xs text-neon-cyan/60 group-hover:text-neon-cyan transition-colors">
                    View Scoreboard →
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}

      </div>

      {/* Scanline overlay */}
      <div className="fixed inset-0 pointer-events-none z-50 scanlines" />
    </div>
  );
}
