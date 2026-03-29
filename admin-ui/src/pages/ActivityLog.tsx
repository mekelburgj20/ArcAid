import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import NeonCard from '../components/NeonCard';
import LoadingState from '../components/LoadingState';

interface RoomEvent {
  id: number;
  game_room_id: string;
  event_type: string;
  event_data: Record<string, any>;
  created_at: string;
}

const EVENT_BADGES: Record<string, { label: string; color: string }> = {
  score_submission:      { label: 'Score',       color: 'bg-neon-green/20 text-neon-green' },
  game_rotation:         { label: 'Rotation',    color: 'bg-neon-blue/20 text-neon-blue' },
  tournament_completion: { label: 'Completed',   color: 'bg-neon-purple/20 text-neon-purple' },
  settings_change:       { label: 'Settings',    color: 'bg-neon-amber/20 text-neon-amber' },
  admin_login:           { label: 'Login',       color: 'bg-neon-cyan/20 text-neon-cyan' },
};

function formatEventSummary(event: RoomEvent): string {
  const d = event.event_data;
  switch (event.event_type) {
    case 'score_submission':
      return `${d.username || 'Unknown'} scored ${(d.score || 0).toLocaleString()} on ${d.gameName || 'unknown game'}`;
    case 'game_rotation':
      return `${d.tournamentName || 'Tournament'}: ${d.oldGame || '?'} -> ${d.newGame || '?'}`;
    case 'tournament_completion':
      return `Game completed in ${d.tournamentName || 'tournament'}`;
    case 'settings_change':
      return `Settings updated: ${(d.keys || []).join(', ') || 'unknown keys'}`;
    case 'admin_login':
      return `Admin login: ${d.username || 'unknown'}`;
    default:
      return JSON.stringify(d);
  }
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso + 'Z');
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function ActivityLog() {
  const room = useRoom();
  const [events, setEvents] = useState<RoomEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const limit = 50;

  useEffect(() => {
    setLoading(true);
    api.get<RoomEvent[]>(`/rooms/${room.roomId}/admin/activity?limit=${limit}`)
      .then(data => {
        setEvents(data);
        setHasMore(data.length >= limit);
      })
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [room.roomId]);

  const loadMore = () => {
    setLoadingMore(true);
    api.get<RoomEvent[]>(`/rooms/${room.roomId}/admin/activity?limit=${limit}&offset=${events.length}`)
      .then(data => {
        setEvents(prev => [...prev, ...data]);
        setHasMore(data.length >= limit);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <LoadingState message="Loading activity..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold text-primary mb-6">Activity Log</h1>

      <NeonCard>
        {events.length === 0 ? (
          <p className="text-muted text-sm py-8 text-center">No activity recorded yet.</p>
        ) : (
          <div className="space-y-0">
            {events.map(event => {
              const badge = EVENT_BADGES[event.event_type] || { label: event.event_type, color: 'bg-raised text-muted' };
              return (
                <div key={event.id} className="flex items-start gap-3 py-3 border-b border-border/30 last:border-0">
                  <span className="text-xs text-faint w-28 flex-shrink-0 pt-0.5">
                    {formatTimestamp(event.created_at)}
                  </span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded ${badge.color} flex-shrink-0`}>
                    {badge.label}
                  </span>
                  <span className="text-sm text-primary min-w-0 break-words">
                    {formatEventSummary(event)}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {hasMore && events.length > 0 && (
          <div className="mt-4 text-center">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="text-sm text-neon-cyan hover:text-neon-cyan/80 transition-colors cursor-pointer bg-transparent border border-neon-cyan/30 rounded px-4 py-2 disabled:opacity-50"
            >
              {loadingMore ? 'Loading...' : 'Load more'}
            </button>
          </div>
        )}
      </NeonCard>
    </div>
  );
}
