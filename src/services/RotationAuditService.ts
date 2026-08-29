import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { trackBackground } from '../utils/backgroundTasks.js';

/**
 * The decisions a rotation makes. Deliberately NOT a log of queue traffic —
 * a player adding or removing their own pick is not a rotation decision and
 * would drown the ones that are.
 */
export type RotationEventType =
    /** The slot's top scorer was resolved (or found to be nobody). */
    | 'winner_resolved'
    /** A stored pick disposition fired: forfeit / nominate / roll-the-dice. */
    | 'disposition_applied'
    /** Somebody was handed a pick window with a deadline. */
    | 'pick_window_granted'
    /**
     * An admin revoked a live pick window WITHOUT removing the slot (the
     * Game States "Clear Picker" action). Distinct from `placeholder_deleted`:
     * the row survives, only the obligation and its timer are gone — writing
     * this as a deletion would make the trail lie about what is still on the
     * board.
     */
    | 'pick_window_cleared'
    /** A game went ACTIVE. `source` (and `queue_owner`, when a queue was consumed) are REQUIRED here. */
    | 'game_activated'
    /** A `[Pending Pick]` placeholder row was created. */
    | 'placeholder_created'
    /** A `[Pending Pick]` placeholder row was removed (see details.reason). */
    | 'placeholder_deleted'
    /** An ACTIVE game was closed — end-of-round rotation, or an admin action. */
    | 'game_deactivated'
    /** A games row was destroyed (admin delete / remove). */
    | 'game_deleted'
    /** A cleanup pass ran (see details.mode). */
    | 'cleanup_action'
    /** A pick window expired and the cascade moved on. */
    | 'timeout_pivot';

/**
 * WHICH branch of the rotation put a game on the board. This is the column the
 * 2026-08-27 incident actually needed: "activated" was in the logs, "activated
 * out of BrickShotBobes' queue because the winner was unlinked" was not.
 */
export type RotationSource =
    | 'winner_queue'
    | 'runner_up_queue'
    | 'third_place_queue'
    | 'fill_loop'
    | 'timeout_auto'
    | 'auto_pick'
    | 'admin_manual'
    | 'web_pick'
    | 'discord_pick'
    | 'admin_on_behalf'
    /** No caller supplied one. Every production path should supply one — this is the bug signal. */
    | 'unknown';

export interface RotationAuditEntry {
    /**
     * Room the decision belongs to. The panel is room-scoped, so a null room
     * (a room-less Throwdown) has nowhere to render and the write is skipped.
     */
    gameRoomId: string | null | undefined;
    tournamentId?: string | null;
    /** Denormalized on purpose — the row must stay readable after a delete. */
    tournamentName?: string | null;
    eventType: RotationEventType;
    /** `system:cron` | `system:timeout` | `system:event-scheduler` | `admin:<id>` | `player:<id>`. */
    actor: string;
    source?: RotationSource | null;
    /** Whose queue was consumed, when a queue was consumed. */
    queueOwner?: string | null;
    gameId?: string | null;
    /** Denormalized on purpose — see tournamentName. */
    gameName?: string | null;
    /** Per-type extras. Stored as JSON text. */
    details?: Record<string, unknown> | null;
}

export interface RotationEventRow {
    id: number;
    game_room_id: string;
    tournament_id: string | null;
    tournament_name: string | null;
    event_type: RotationEventType;
    actor: string;
    source: RotationSource | null;
    queue_owner: string | null;
    game_id: string | null;
    game_name: string | null;
    details: Record<string, unknown>;
    created_at: string;
}

export interface RotationAuditPage {
    events: RotationEventRow[];
    /** Opaque `created_at|id` cursor to pass back as `before`, or null at the end. */
    nextCursor: string | null;
}

export const ROTATION_LOG_DEFAULT_LIMIT = 50;
export const ROTATION_LOG_MAX_LIMIT = 200;
export const ROTATION_LOG_RETENTION_DAYS = 180;

/**
 * Append-only per-decision rotation log (`rotation_events`, migration 170).
 *
 * Prompted by the 2026-08-27 slot-reservation incident (WG-VR / WG-VPXS
 * over-activation): reconstructing "who or what picked what, and what
 * triggered it" took prod-log grepping plus DB archaeology. `maintenance_runs`
 * (S10) records THAT a run happened and how it ended; this is the per-decision
 * detail underneath it, surfaced to room admins as the Rotation Log panel.
 *
 * **`log` never throws.** An audit write failing must never break a rotation —
 * the whole point is that it runs beside destructive engine work. Failures are
 * logged at ERROR and swallowed, which is exactly the "fan-out try/catch
 * swallows column errors silently" trap: the round-trip test in
 * `rotation-audit.test.ts` writes one row of EVERY event type and reads every
 * column back, so a schema/column drift fails CI instead of going quiet in
 * prod.
 */
export class RotationAuditService {
    /**
     * Record one rotation decision. Safe to `await` inside an open transaction
     * (it is one INSERT on the shared handle and cannot abort the caller) and
     * safe to fire-and-forget: the promise is registered with the background
     * tracker so tests drain it before resetting the in-memory DB.
     */
    static log(entry: RotationAuditEntry): Promise<void> {
        return trackBackground(this.writeEvent(entry));
    }

    private static async writeEvent(entry: RotationAuditEntry): Promise<void> {
        try {
            // Room-less rotations don't exist today (Throwdowns are one-round
            // events with no cascade), and the panel is room-scoped — there is
            // nowhere to show a roomless row, so skip rather than write junk.
            if (!entry.gameRoomId) return;

            const db = await getDatabase();
            await db.run(
                `INSERT INTO rotation_events
                    (game_room_id, tournament_id, tournament_name, event_type, actor,
                     source, queue_owner, game_id, game_name, details)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                entry.gameRoomId,
                entry.tournamentId ?? null,
                entry.tournamentName ?? null,
                entry.eventType,
                entry.actor,
                entry.source ?? null,
                entry.queueOwner ?? null,
                entry.gameId ?? null,
                entry.gameName ?? null,
                entry.details ? JSON.stringify(entry.details) : null,
            );
        } catch (err) {
            logError('RotationAuditService.log failed (non-fatal):', err);
        }
    }

    /**
     * Newest-first page of a room's rotation log.
     *
     * Cursor pagination follows the lobby feed's `created_at` pattern, with
     * `id` as the tiebreak — several decisions inside one maintenance run share
     * a second, and a bare `created_at <` cursor would skip the rest of that
     * second on the next page.
     */
    static async list(
        gameRoomId: string,
        opts: { tournamentId?: string | null; before?: string | null; limit?: number } = {},
    ): Promise<RotationAuditPage> {
        const db = await getDatabase();
        const limit = Math.min(
            Math.max(1, Math.floor(opts.limit ?? ROTATION_LOG_DEFAULT_LIMIT)),
            ROTATION_LOG_MAX_LIMIT,
        );

        const conditions: string[] = ['game_room_id = ?'];
        const params: any[] = [gameRoomId];

        if (opts.tournamentId) {
            conditions.push('tournament_id = ?');
            params.push(opts.tournamentId);
        }

        const cursor = parseCursor(opts.before);
        if (cursor) {
            conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
            params.push(cursor.createdAt, cursor.createdAt, cursor.id);
        }

        // limit + 1 so "is there another page" needs no COUNT.
        params.push(limit + 1);

        const rows = await db.all(
            `SELECT * FROM rotation_events
              WHERE ${conditions.join(' AND ')}
              ORDER BY created_at DESC, id DESC
              LIMIT ?`,
            ...params,
        );

        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map((r: any): RotationEventRow => ({
            id: r.id,
            game_room_id: r.game_room_id,
            tournament_id: r.tournament_id,
            tournament_name: r.tournament_name,
            event_type: r.event_type,
            actor: r.actor,
            source: r.source,
            queue_owner: r.queue_owner,
            game_id: r.game_id,
            game_name: r.game_name,
            details: safeParse(r.details),
            created_at: r.created_at,
        }));

        const last = page[page.length - 1];
        return {
            events: page,
            nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
        };
    }

    /** Drop rows past the retention window. Returns the number deleted. */
    static async prune(retentionDays: number = ROTATION_LOG_RETENTION_DAYS): Promise<number> {
        const db = await getDatabase();
        const result = await db.run(
            "DELETE FROM rotation_events WHERE created_at < datetime('now', ?)",
            `-${retentionDays} days`,
        );
        return result.changes || 0;
    }
}

function parseCursor(before: string | null | undefined): { createdAt: string; id: number } | null {
    if (!before) return null;
    const sep = before.lastIndexOf('|');
    // A bare timestamp (hand-typed, or a legacy caller) still works: treat it
    // as "before this instant" by pairing it with an id above any real row.
    if (sep < 0) return { createdAt: before, id: Number.MAX_SAFE_INTEGER };
    const createdAt = before.slice(0, sep);
    const id = parseInt(before.slice(sep + 1), 10);
    if (!createdAt || !Number.isFinite(id)) return null;
    return { createdAt, id };
}

function safeParse(raw: string | null): Record<string, unknown> {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}
