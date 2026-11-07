/**
 * G14 (ADR 0037) - how the older event stores read as activity-log rows.
 * Shared by the live mirrors (`RotationAuditService.log`, `RoomEventService.log`)
 * and the one-time backfill (migration 209), so a backfilled row and a live
 * one say the same thing.
 */
import type { ActivityCategory, ActivitySeverity } from '../services/ActivityLogService.js';

export interface MappedActivity {
    category: ActivityCategory;
    eventType: string;
    severity?: ActivitySeverity;
    summary: string;
    userId?: string | null;
    actorUserId?: string | null;
    playerAlias?: string | null;
    gameName?: string | null;
    tournamentName?: string | null;
    score?: number | null;
}

/** `admin:<id>` / `player:<id>` -> the id; `system:*` -> null. */
export function idFromActor(actor: string | null | undefined): string | null {
    const m = /^(?:admin|player):(.+)$/.exec(actor || '');
    return m ? m[1]! : null;
}

const ROTATION_SOURCE_LABEL: Record<string, string> = {
    winner_queue: "from the winner's queue",
    runner_up_queue: "from the runner-up's queue",
    third_place_queue: "from third place's queue",
    fill_loop: 'to fill an open slot',
    timeout_auto: 'automatically after a pick timeout',
    auto_pick: 'by auto-pick',
    admin_manual: 'by an admin',
    web_pick: 'by a web pick',
    discord_pick: 'by a Discord pick',
    admin_on_behalf: 'by an admin on a player\'s behalf',
};

export function mapRotationEvent(e: {
    eventType: string; actor: string; source?: string | null; queueOwner?: string | null;
    gameName?: string | null; details?: Record<string, unknown> | null;
}): MappedActivity {
    const game = e.gameName || 'a game';
    const how = e.source ? ROTATION_SOURCE_LABEL[e.source] ?? `(${e.source})` : '';
    const summaries: Record<string, string> = {
        winner_resolved: `Winner resolved on ${game}`,
        disposition_applied: `Pick disposition applied on ${game}`,
        pick_window_granted: 'Pick window granted',
        pick_window_cleared: 'Pick window cleared',
        game_activated: `${game} went live ${how}`.trim(),
        placeholder_created: 'Pick placeholder created',
        placeholder_deleted: 'Pick placeholder removed',
        game_deactivated: `${game} closed`,
        game_deleted: `${game} deleted`,
        cleanup_action: 'Cleanup ran',
        timeout_pivot: 'A pick window expired; the rotation moved on',
    };
    const winner = typeof e.details?.winnerId === 'string' ? e.details.winnerId as string : null;
    return {
        category: 'lifecycle',
        eventType: `rotation_${e.eventType}`,
        summary: summaries[e.eventType] ?? `Rotation: ${e.eventType.replace(/_/g, ' ')}`,
        userId: e.queueOwner || winner || (e.actor?.startsWith('player:') ? idFromActor(e.actor) : null),
        actorUserId: e.actor?.startsWith('admin:') ? idFromActor(e.actor) : null,
    };
}

/**
 * Room events that are mirrored LIVE. Score submissions / corrections /
 * per-row deletes are recorded by `ScoreHistoryService` itself, and admin
 * route writes by the admin-write middleware, so mirroring them too would
 * write each twice. The backfill (no middleware history) maps every type.
 */
export const LIVE_MIRRORED_ROOM_EVENTS = new Set([
    'admin_login', 'identity_merge', 'score_deleted',
]);

export function mapRoomEvent(type: string, d: Record<string, any>): MappedActivity | null {
    switch (type) {
        // Covered by ScoreHistoryService.log / correctScore.
        case 'score_submission':
        case 'freeplay_score_submission':
        case 'score_corrected':
            return null;
        case 'score_deleted':
            // A per-row delete (historyId) is recorded by deleteEvent; this is the "wipe player from game" path.
            if (d.historyId != null) return null;
            return {
                category: 'score', eventType: 'scores_wiped', playerAlias: d.player ?? null, score: d.score ?? null,
                summary: `An admin removed a player's scores from a game (${d.historyRowsRemoved ?? '?'} rows)`,
            };
        // Covered by the rotation_events mirror (game_activated / game_deactivated).
        case 'tournament_completion':
        case 'game_rotation':
            return null;
        case 'admin_login':
            return { category: 'admin', eventType: 'admin_login', summary: 'Room admin signed in' };
        case 'settings_change':
            return { category: 'admin', eventType: 'settings_change',
                summary: `Settings changed: ${Array.isArray(d.keys) ? d.keys.join(', ') : '?'}` };
        case 'identity_merge':
            return { category: 'admin', eventType: 'identity_merge', summary: 'Player identities merged' };
        case 'identity_unmerge':
            return { category: 'admin', eventType: 'identity_unmerge', summary: 'A player identity merge was reversed' };
        case 'game_deactivated':
        case 'game_deleted':
        case 'game_removed':
        case 'game_state_change':
            return { category: 'admin', eventType: type, gameName: d.gameName ?? null,
                summary: `${type.replace(/_/g, ' ')}: ${d.gameName ?? '?'}${d.newStatus ? ` -> ${d.newStatus}` : ''}` };
        case 'picker_cleared':
            return { category: 'admin', eventType: type, gameName: d.gameName ?? null, summary: `Picker cleared on ${d.gameName ?? '?'}` };
        case 'score_suppression_cleared':
            return { category: 'admin', eventType: type, playerAlias: d.player ?? null, summary: 'A deleted-score tombstone was cleared' };
        case 'style_uploaded':
            return { category: 'admin', eventType: type, summary: 'A style image was uploaded' };
        case 'iscored_sync':
        case 'iscored_reconcile':
        case 'force_maintenance':
            return { category: 'admin', eventType: type, gameName: d.gameName ?? null, tournamentName: d.tournamentName ?? null,
                summary: type === 'force_maintenance' ? `Maintenance forced on ${d.tournamentName ?? '?'}` : type.replace(/_/g, ' ') };
        default:
            return { category: 'admin', eventType: type, summary: type.replace(/_/g, ' ') };
    }
}
