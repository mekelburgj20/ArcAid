import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

export type AchievementType = 'tournament_win' | 'milestone' | 'room_record';

export interface AwardAchievementRow {
    gameRoomId: string | null;
    discordUserId?: string | null;
    iscoredUsername: string;
    type: AchievementType;
    gameName?: string | null;
    gameId?: string | null;
    tournamentId?: string | null;
    metadata?: Record<string, unknown>;
}

export interface PlayerAchievementSummary {
    tournamentWins: number;
    milestones: number;
    roomRecords: number;
    recent: Array<{ type: string; game_name: string | null; earned_at: string; metadata: any }>;
}

/**
 * Append-only trophy-case log (migration 108, `player_achievements`).
 * Deliberately NO foreign keys — an audit log that outlives its
 * tournament/room, same treatment as maintenance_runs (migration 106).
 *
 * `award` must NEVER throw — it's called fire-and-forget (or awaited-but-safe)
 * from hot score/maintenance paths and a logging failure must never break the
 * host operation.
 */
export class AchievementService {
    static async award(row: AwardAchievementRow): Promise<void> {
        try {
            const db = await getDatabase();
            const metadataJson = row.metadata !== undefined ? JSON.stringify(row.metadata) : null;

            // OR IGNORE is a no-op for non-tournament_win types (no unique
            // constraint applies to them); for tournament_win it's the dedup
            // guard against the partial UNIQUE index on (type, game_id).
            await db.run(
                `INSERT OR IGNORE INTO player_achievements
                    (game_room_id, discord_user_id, iscored_username, type, game_name, game_id, tournament_id, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                row.gameRoomId ?? null,
                row.discordUserId ?? null,
                row.iscoredUsername,
                row.type,
                row.gameName ?? null,
                row.gameId ?? null,
                row.tournamentId ?? null,
                metadataJson,
            );
        } catch (err) {
            logError('AchievementService.award failed (non-fatal):', err);
        }
    }

    /**
     * Summary + recent trophy-case entries for a player in a room. Matches by
     * (discord_user_id = ? OR LOWER(iscored_username) = LOWER(?)) so both
     * Discord-linked and alias-only rows collapse into one player's case.
     */
    static async getForPlayer(
        gameRoomId: string,
        opts: { discordUserId?: string | null; username: string },
    ): Promise<PlayerAchievementSummary> {
        const db = await getDatabase();
        const discordUserId = opts.discordUserId ?? null;
        const username = opts.username;

        const rows = await db.all(
            `SELECT type, game_name, earned_at, metadata
               FROM player_achievements
              WHERE game_room_id = ?
                AND (discord_user_id = ? OR LOWER(iscored_username) = LOWER(?))
              ORDER BY earned_at DESC`,
            gameRoomId,
            discordUserId,
            username,
        ) as Array<{ type: string; game_name: string | null; earned_at: string; metadata: string | null }>;

        let tournamentWins = 0;
        let milestones = 0;
        let roomRecords = 0;
        for (const r of rows) {
            if (r.type === 'tournament_win') tournamentWins++;
            else if (r.type === 'milestone') milestones++;
            else if (r.type === 'room_record') roomRecords++;
        }

        const recent = rows.slice(0, 10).map((r) => {
            let metadata: any = null;
            if (r.metadata) {
                try {
                    metadata = JSON.parse(r.metadata);
                } catch {
                    metadata = null;
                }
            }
            return { type: r.type, game_name: r.game_name, earned_at: r.earned_at, metadata };
        });

        return { tournamentWins, milestones, roomRecords, recent };
    }
}
