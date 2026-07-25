import { logInfo } from '../utils/logger.js';

/**
 * Approval-rooms (v2.39.0) — JOIN_POLICY flip side-effects. Mirrors
 * OrphanService's REQUIRE_DISCORD_LOGIN flip dispatch: called from
 * GameRoomSettingsService.set/saveMany/delete with the *previous* value so it
 * knows which direction the flip went. Silent no-op when direction unchanged.
 *
 * open -> approval: the room's existing footprint on the Global Scoreboard is
 * scrubbed (soft-deleted) — "approval required" means invisible-until-vetted,
 * and that has to include scores already fanned out under the old open policy.
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
            const { GlobalScoreService } = await import('./GlobalScoreService.js');
            const n = await GlobalScoreService.scrubRoomOnApprovalFlip(roomId);
            logInfo(`JoinPolicyService: scrubbed ${n} global_scores row(s) for room ${roomId} (JOIN_POLICY -> approval)`);
        }
        // approval -> open: intentionally a no-op (see class doc).
    }
}
