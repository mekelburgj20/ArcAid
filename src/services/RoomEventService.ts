import { ActivityLogService } from './ActivityLogService.js';
import { mapRoomEvent } from '../utils/activityMappings.js';

/**
 * A thin forwarder into the activity log (G14, v2.227.0, ADR 0037).
 *
 * `room_events` (the old 7-day store) is retired: migration 209 copied it and
 * migration 210 dropped it. Existing callers keep their one-line call; each
 * event becomes an `activity_log` row through `mapRoomEvent`, which returns
 * null for the types another writer already records (score landings,
 * corrections and per-row deletes in `ScoreHistoryService`; rotations in
 * `RotationAuditService`). Inside an admin request the row also suppresses
 * the admin middleware's generic row and carries the admin as its actor.
 * New code should call `ActivityLogService.record` directly.
 */
export class RoomEventService {
    /** Never rejects (`record` swallows); callers may still `.catch` or `await`. */
    static log(gameRoomId: string, eventType: string, eventData: Record<string, any> = {}): Promise<void> {
        const mapped = mapRoomEvent(eventType, eventData);
        if (!mapped) return Promise.resolve();
        return ActivityLogService.record({
            roomId: gameRoomId,
            ...mapped,
            details: eventType === 'admin_login' && eventData.username
                ? { ...eventData, actorName: eventData.username }
                : eventData,
        });
    }
}
