import { useRoom } from '../contexts/RoomContext';
import ActivityTimeline from '../components/ActivityTimeline';

/**
 * Room Admin -> Activity (G14, v2.227.0, ADR 0037): this room's activity log -
 * scores (landed, corrected, deleted, refused), Witness / Castcade plays and
 * device activity routed here, admin actions, bot problems and tournament
 * lifecycle - filterable, shareable by URL, exportable as CSV.
 */
export default function ActivityLog() {
  const room = useRoom();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold text-primary mb-2">Activity Log</h1>
      <p className="text-sm text-muted mb-6">
        Everything that happened in this room over the last 90 days. To answer "why didn't a score post?",
        pick the player and turn on <span className="font-semibold">Problems only</span>.
      </p>
      <ActivityTimeline mode="room" roomId={room.roomId} />
    </div>
  );
}
