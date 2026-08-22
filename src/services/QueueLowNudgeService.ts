import { getDatabase } from '../database/database.js';
import { NotificationService } from './NotificationService.js';
import { PickAwardGate } from './PickAwardGate.js';
import { roomPicksUrl } from '../utils/publicLinks.js';
import { logError } from '../utils/logger.js';

/**
 * QueueLowNudgeService — "your pick queue is running low" (v2.126.0).
 *
 * Fired ONLY when the ENGINE consumes one of a player's queued picks: the
 * rotation promotion in `processSlotMaintenance`, the extra-slot fill loop, and
 * `TimeoutManager.activateQueuedIntoSlot`. Deliberately NOT fired when the
 * player deletes their own row — they know; being told "your queue is short"
 * one second after shortening it on purpose is noise.
 *
 * Companion to `RotationNudgeService`, but a different question. That one asks
 * "the rotation is imminent and you have NOTHING lined up"; this one asks "you
 * just spent a pick and you are nearly out" — which is the state that quietly
 * ends a player's streak of getting the game they wanted.
 *
 * Dedupe (`queue_low_nudges`, one row per user+tournament): send when there is
 * no row, when the count is LOWER than the last count we told them about
 * (4 → 3 → 2 each earn a mention, because each one is new news), or when the
 * last send is older than a week (a queue sitting flat at 2 for a fortnight is
 * worth one reminder, not fourteen).
 */

/** Nudge at or below this many remaining queued picks. */
export const QUEUE_LOW_THRESHOLD = 3;

/** A flat queue earns at most one reminder per week. */
const RESEND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export class QueueLowNudgeService {
    /**
     * Count `userId`'s remaining queued picks in `tournamentId` and, if the
     * queue is low and the dedupe ledger allows it, send the nudge.
     *
     * Never throws — every caller is inside a maintenance/timeout path where a
     * failed courtesy DM must not abort the rotation.
     */
    static async maybeNudge(userId: string, tournamentId: string): Promise<void> {
        try {
            if (!userId || !tournamentId) return;
            const db = await getDatabase();

            const tournament = await db.get(
                'SELECT id, name, game_room_id FROM tournaments WHERE id = ?',
                tournamentId,
            );
            // A legacy no-room tournament has nowhere to send the player, and a
            // pick-award-off tournament has no queue worth topping up.
            if (!tournament?.game_room_id) return;
            if (!(await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id))) return;

            const countRow = await db.get(
                `SELECT COUNT(*) AS count FROM games
                 WHERE tournament_id = ? AND status = 'QUEUED' AND name != '[Pending Pick]'
                   AND picker_discord_id = ?`,
                tournamentId, userId,
            );
            const count: number = countRow?.count ?? 0;
            if (count > QUEUE_LOW_THRESHOLD) return;

            const previous = await db.get(
                'SELECT last_count, sent_at FROM queue_low_nudges WHERE user_id = ? AND tournament_id = ?',
                userId, tournamentId,
            );
            const now = Date.now();
            if (previous) {
                const lastCount: number = previous.last_count ?? Number.MAX_SAFE_INTEGER;
                const sentAt = previous.sent_at ? Date.parse(previous.sent_at) : NaN;
                const stale = Number.isNaN(sentAt) || (now - sentAt) > RESEND_AFTER_MS;
                if (count >= lastCount && !stale) return;
            }

            const room = await db.get('SELECT slug, name FROM game_rooms WHERE id = ?', tournament.game_room_id);
            const link = room?.slug ? roomPicksUrl(room.slug, tournament.name) : '';
            const roomName = room?.name || 'your game room';
            const state = count === 0
                ? 'is empty'
                : `is down to ${count} game${count === 1 ? '' : 's'}`;

            // The ledger is written BEFORE delivery, exactly like
            // `rotation_nudges`: a DM that fails to send must not license a
            // retry storm on the next rotation.
            await db.run(
                `INSERT INTO queue_low_nudges (user_id, tournament_id, last_count, sent_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(user_id, tournament_id)
                 DO UPDATE SET last_count = excluded.last_count, sent_at = excluded.sent_at`,
                userId, tournamentId, count, new Date(now).toISOString(),
            );

            await NotificationService.notify({
                userId,
                type: 'queueLow',
                message: `\u{1F4CB} Heads up — your **${tournament.name}** queue in ${roomName} ${state}. ` +
                    `Top it up so your next win still gets your pick.${link ? `\n${link}` : ''}`,
                pushBody: `Your ${tournament.name} queue ${state} — top it up.`,
                roomId: tournament.game_room_id,
                tournamentId,
                pushUrl: link || undefined,
            }).catch(() => {});
        } catch (error) {
            logError('QueueLowNudgeService.maybeNudge error:', error);
        }
    }
}
