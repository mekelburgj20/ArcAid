import crypto from 'crypto';
import { getDatabase } from '../database/database.js';

/**
 * Report-a-problem (v2.25.0) — user-filed reports on catalogue game metadata.
 *
 * Mirrors ScoreReportService's shape. `game_feedback` is FK-less with a
 * denormalized `game_name` so a report survives its game's merge/deletion;
 * the queue LEFT JOINs global_games for live metadata + field_sources so the
 * admin can see whether the disputed field is ours to fix ('manual'/unknown)
 * or sourced upstream (ADR 0014: IPDB > VPS > OPDB for real-machine mfr/year).
 */

export const REPORTABLE_FIELDS = [
    'name', 'manufacturer', 'year', 'platforms', 'artwork', 'duplicate', 'other',
    /**
     * Contract §5 — "this game isn't score-based". Unlike the others this
     * disputes the game's PRESENCE, not one of its values, and it is the review
     * signal that pairs with the RA importer's automatic `score_eligibility`
     * verdict. Deliberately no auto-removal: a super-admin reviews and uses the
     * existing catalogue delete/merge tooling.
     */
    'not_score_eligible',
] as const;
export type ReportableField = typeof REPORTABLE_FIELDS[number];

export const FEEDBACK_RESOLUTIONS = ['fixed', 'upstream', 'dismissed'] as const;
export type FeedbackResolution = typeof FEEDBACK_RESOLUTIONS[number];

/** Max unresolved reports one reporter may hold across the whole catalogue. */
export const MAX_OPEN_REPORTS_PER_USER = 20;

export interface GameFeedbackRow {
    id: string;
    global_game_id: string;
    game_name: string;
    reporter_discord_id: string;
    field: string;
    current_value: string | null;
    suggested_value: string | null;
    note: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
    resolution_note: string | null;
    // LEFT-JOINed live game context (null when the game was merged/deleted)
    live_name: string | null;
    manufacturer: string | null;
    year: number | null;
    field_sources: string | null;
    ipdb_url: string | null;
    opdb_id: string | null;
    vps_id: string | null;
    igdb_id: number | null;
    /** v2.49.0 (room-bans contract, Workstream 2) — resolved via user_profiles. */
    reporter_display_name: string | null;
    reporter_username: string | null;
}

export class GameFeedbackService {
    /**
     * File a report. Snapshots the disputed field's CURRENT value server-side
     * (never trusted from the client). Throws coded errors:
     * `GAME_NOT_FOUND`, `DUPLICATE_REPORT` (same reporter already has an open
     * report on this field of this game).
     */
    static async create(params: {
        globalGameId: string;
        reporterDiscordId: string;
        field: ReportableField;
        suggestedValue?: string | null;
        note?: string | null;
    }): Promise<{ id: string }> {
        const db = await getDatabase();
        const game = await db.get<{
            id: string; name: string; manufacturer: string | null; year: number | null;
            platforms: string | null; image_url: string | null; local_image_path: string | null;
            score_eligibility: string | null;
        }>(
            `SELECT id, name, manufacturer, year, platforms, image_url, local_image_path,
                    score_eligibility
               FROM global_games WHERE id = ?`,
            params.globalGameId,
        );
        if (!game) {
            const err = new Error('Game not found') as Error & { code?: string };
            err.code = 'GAME_NOT_FOUND';
            throw err;
        }

        // Spam floor: cap OPEN reports per reporter (the writeLimiter is only
        // per-minute; without this, one account could bury the queue).
        const open = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM game_feedback WHERE reporter_discord_id = ? AND resolved_at IS NULL',
            params.reporterDiscordId,
        );
        if ((open?.n ?? 0) >= MAX_OPEN_REPORTS_PER_USER) {
            const err = new Error('Too many open reports') as Error & { code?: string };
            err.code = 'REPORT_LIMIT';
            throw err;
        }

        const currentValue = this.snapshotField(game, params.field);
        const id = crypto.randomUUID();
        try {
            await db.run(
                `INSERT INTO game_feedback (
                    id, global_game_id, game_name, reporter_discord_id,
                    field, current_value, suggested_value, note
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                id, game.id, game.name, params.reporterDiscordId,
                params.field, currentValue,
                params.suggestedValue || null, params.note || null,
            );
        } catch (e: unknown) {
            const sqlErr = e as { code?: string; message?: string };
            // Only the partial UNIQUE dedup index maps to 409 — any other
            // constraint is a real bug and must surface as a 500.
            if (sqlErr?.code === 'SQLITE_CONSTRAINT' && String(sqlErr.message || '').includes('game_feedback')) {
                const err = new Error('You already have an open report on this field') as Error & { code?: string };
                err.code = 'DUPLICATE_REPORT';
                throw err;
            }
            throw e;
        }
        return { id };
    }

    /** The disputed field's current value, rendered as display text. */
    private static snapshotField(
        game: {
            name: string; manufacturer: string | null; year: number | null;
            platforms: string | null; image_url: string | null; local_image_path: string | null;
            score_eligibility?: string | null;
        },
        field: ReportableField,
    ): string | null {
        switch (field) {
            case 'name': return game.name;
            // Snapshotting the importer's verdict here is what lets the admin
            // queue show "the reporter says no, and RA said `novelty` too"
            // side by side, instead of the flag being the only signal (§5).
            case 'not_score_eligible': return game.score_eligibility ?? null;
            case 'manufacturer': return game.manufacturer;
            case 'year': return game.year != null ? String(game.year) : null;
            case 'platforms': {
                try {
                    const arr = JSON.parse(game.platforms || '[]');
                    return Array.isArray(arr) && arr.length ? arr.join(', ') : null;
                } catch { return game.platforms; }
            }
            case 'artwork': return game.local_image_path || game.image_url;
            default: return null; // duplicate / other — the note carries the claim
        }
    }

    /** Queue listing, open first (or resolved history when `resolved`). */
    static async list(opts: { resolved: boolean; limit?: number }): Promise<GameFeedbackRow[]> {
        const db = await getDatabase();
        return db.all<GameFeedbackRow[]>(
            `SELECT f.*,
                    g.name AS live_name, g.manufacturer, g.year, g.field_sources,
                    g.ipdb_url, g.opdb_id, g.vps_id, g.igdb_id,
                    up.display_name AS reporter_display_name, up.username AS reporter_username
               FROM game_feedback f
               LEFT JOIN global_games g ON g.id = f.global_game_id
               LEFT JOIN user_profiles up ON up.discord_user_id = f.reporter_discord_id
              WHERE f.resolved_at IS ${opts.resolved ? 'NOT NULL' : 'NULL'}
              ORDER BY f.created_at ${opts.resolved ? 'DESC' : 'ASC'}
              LIMIT ?`,
            opts.limit ?? 200,
        );
    }

    static async openCount(): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM game_feedback WHERE resolved_at IS NULL',
        );
        return row?.n ?? 0;
    }

    /** Resolve an open report. Returns false when it doesn't exist or is already resolved. */
    static async resolve(params: {
        id: string;
        resolution: FeedbackResolution;
        note?: string | null;
        resolvedBy: string;
    }): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_feedback
                SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?, resolution_note = ?
              WHERE id = ? AND resolved_at IS NULL`,
            params.resolvedBy, params.resolution, params.note || null, params.id,
        );
        return (result.changes ?? 0) > 0;
    }
}
