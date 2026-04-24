import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import LoadingState from '../components/LoadingState';

interface Room {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
}

export default function SuperAdminDashboard() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<Room[]>('/admin/rooms')
      .then(setRooms)
      .catch(() => setRooms([]))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingState message="Loading dashboard..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Super Admin Dashboard</h1>

      <NeonCard glowColor="cyan" className="mb-6" title="Overview">
        <div className="flex gap-8 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Game Rooms:</span>
            <span className="font-display font-bold text-neon-cyan text-lg">{rooms.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted text-sm">Public:</span>
            <span className="font-display font-bold text-neon-green text-lg">{rooms.filter(r => r.is_public).length}</span>
          </div>
        </div>
      </NeonCard>

      <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted mb-3">Game Rooms</h2>
      {rooms.length === 0 ? (
        <NeonCard className="text-center py-8">
          <p className="text-muted mb-3">No game rooms yet.</p>
          <Link to="/admin/rooms" className="text-neon-cyan hover:underline text-sm">Create your first game room</Link>
        </NeonCard>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rooms.map(room => (
            <NeonCard key={room.id} glowColor={room.is_public ? 'cyan' : 'none'}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-bold text-lg">{room.name}</h3>
                <span className={`text-xs px-2 py-0.5 rounded ${room.is_public ? 'bg-neon-green/10 text-neon-green border border-neon-green/30' : 'bg-raised text-faint border border-border'}`}>
                  {room.is_public ? 'Public' : 'Private'}
                </span>
              </div>
              <p className="text-muted text-sm mb-1 font-mono">/{room.slug}</p>
              {room.description && <p className="text-muted text-sm mb-3">{room.description}</p>}
              <div className="flex gap-2 pt-3 border-t border-border flex-wrap">
                <Link
                  to={`/${room.slug}/admin/dashboard`}
                  className="text-neon-cyan text-xs hover:underline no-underline"
                >
                  Open Admin
                </Link>
                <Link
                  to={`/${room.slug}/admin/activity`}
                  className="text-neon-amber text-xs hover:underline no-underline"
                  title="Per-room activity log — room_events table (scores, rotations, admin actions)"
                >
                  Activity Log
                </Link>
                <Link
                  to={`/${room.slug}/`}
                  className="text-muted text-xs hover:underline no-underline"
                >
                  View Scoreboard
                </Link>
              </div>
            </NeonCard>
          ))}
        </div>
      )}
    </div>
  );
}
