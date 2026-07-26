import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

/**
 * Approval-rooms (v2.39.0) — JOIN_POLICY flip side-effects. Mirrors
 * OrphanService's REQUIRE_DISCORD_LOGIN flip dispatch: called from
 * GameRoomSettingsService.set/saveMany/delete with the *previous* value so it
 * knows which direction the flip went. Silent no-op when direction unchanged.
 *
 * open -> approval: the room's existing footprint on the Global Scoreboard is
 * scrubbed (soft-deleted) — "approval required" means invisible-until-vetted,
 * and that has to include scores already fanned out under the old open policy
 * — UNLESS the room has explicitly opted in via SHARE_TO_GLOBAL (v2.40.0), in
 * which case its global footprint is left alone on this flip. Read fresh
 * (no cache), same as everywhere else this setting is consulted; if a bulk
 * settings save flips JOIN_POLICY and SHARE_TO_GLOBAL in the same request,
 * the write loop lands both columns before this dispatch runs, so the read
 * here sees the post-write value either way.
 *
 * approval -> open: deliberately NOT retroactive. Old scrubbed rows stay
 * scrubbed; new submissions resume fanning out normally. Re-doing the old
 * fan-out on flip-back would require re-deriving submit-time context
 * (platform, tournament, photo) that isn't stored on the scrubbed row in a
 * form worth resurrecting for what should be a rare admin action.
 */
export class JoinPolicyService {
    static async handlePolicyFlip(
        roomId: string,
        prevValue: string | null,
        newValue: string,
    ): Promise<void> {
        const prev = prevValue === 'approval';
        const next = newValue === 'approval';
        if (prev === next) return;

        if (next) {
            const db = await getDatabase();
            const shareRow = await db.get(
                `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'SHARE_TO_GLOBAL'`,
                roomId,
            );
            if (shareRow?.value === 'true') {
                logInfo(`JoinPolicyService: room ${roomId} flipped to approval with SHARE_TO_GLOBAL=true — Global Scoreboard footprint kept.`);
                return;
            }
            const { GlobalScoreService } = await import('./GlobalScoreService.js');
            const n = await GlobalScoreService.scrubRoomOnApprovalFlip(roomId);
            logInfo(`JoinPolicyService: scrubbed ${n} global_scores row(s) for room ${roomId} (JOIN_POLICY -> approval)`);
        }
        // approval -> open: intentionally a no-op (see class doc).
    }
}
