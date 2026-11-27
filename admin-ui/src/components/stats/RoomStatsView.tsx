import RoomRecordsSection from './RoomRecordsSection';

/**
 * The Stats page's "Room" tab (`?view=room`): the room as a whole, in sections
 * stacked top to bottom. Records come first (B31.4). WORK.md B7 (most selected
 * tables, ratings, a per-tournament breakdown) adds its sections BELOW this one,
 * each its own component in this folder, so a section never needs the others.
 */
export default function RoomStatsView({ roomId, slug }: { roomId: string; slug: string }) {
  return (
    <div className="grid gap-5" data-testid="room-stats">
      <RoomRecordsSection key={roomId} roomId={roomId} slug={slug} />
    </div>
  );
}
