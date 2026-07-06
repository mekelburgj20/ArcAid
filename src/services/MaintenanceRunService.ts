import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

export type MaintenanceOutcome = 'success' | 'skipped' | 'error';

export interface MaintenanceRunRecord {
    gameRoomId: string | null;
    tournamentId: string;
    kind?: string; // 'maintenance' | 'forced' | 'cleanup'
    outcome: MaintenanceOutcome;
    summary?: string | null;
    startedAt: string;   // ISO
    finishedAt: string;  // ISO
    durationMs: number;
}

export interface LatestMaintenanceRun {
    outcome: MaintenanceOutcome;
    summary: string | null;
    finishedAt: string;
    durationMs: number | null;
}

/**
 * Records + reads the per-tournament maintenance-run trail (migration 106,
 * `maintenance_runs`). Powers the S10 room-admin health surface: "Last run ·
 * result" per tournament. All writes are fire-and-forget safe — a logging
 * failure must never break a maintenance run.
 */
export class MaintenanceRunService {
    static async record(run: MaintenanceRunRecord): Promise<void> {
        try {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO maintenance_runs
                    (game_room_id, tournament_id, kind, outcome, summary, started_at, finished_at, duration_ms)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                run.gameRoomId,
                run.tournamentId,
                run.kind ?? 'maintenance',
                run.outcome,
                run.summary ?? null,
                run.startedAt,
                run.finishedAt,
                run.durationMs,
            );
        } catch (err) {
            logError('MaintenanceRunService.record failed (non-fatal):', err);
        }
    }

    /**
     * Latest run per tournament for a room, keyed by tournament_id. Selects the
     * MAX(id) per tournament (autoincrement is monotonic, so this is the most
     * recent insert with no finished_at tie ambiguity).
     */
    static async getLatestPerTournament(gameRoomId: string): Promise<Map<string, LatestMaintenanceRun>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT tournament_id, outcome, summary, finished_at, duration_ms
               FROM maintenance_runs
              WHERE game_room_id = ?
                AND id IN (
                    SELECT MAX(id) FROM maintenance_runs
                     WHERE game_room_id = ?
                     GROUP BY tournament_id
                )`,
            gameRoomId,
            gameRoomId,
        ) as Array<{ tournament_id: string; outcome: MaintenanceOutcome; summary: string | null; finished_at: string; duration_ms: number | null }>;

        const map = new Map<string, LatestMaintenanceRun>();
        for (const r of rows) {
            map.set(r.tournament_id, {
                outcome: r.outcome,
                summary: r.summary,
                finishedAt: r.finished_at,
                durationMs: r.duration_ms,
            });
        }
        return map;
    }
}
