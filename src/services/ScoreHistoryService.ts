import { getDatabase } from '../database/database.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { RoomMembershipService } from './RoomMembershipService.js';

export class ScoreHistoryService {
    /**
     * Log a score entry to history. Called alongside every score submission.
     */
    static async log(params: {
        gameName: string;
        gameRoomId: string;
        gameId?: string;
        username: string;
        discordUserId?: string;
        score: number;
        photoUrl?: string;
        source: 'tournament' | 'community' | 'sync';
        tournamentId?: string | null;
        anonymousName?: string | null;
    }) {
        const db = await getDatabase();

        // Dedup: skip if an identical (game, player, score, room) entry already exists
        const existing = await db.get(
            `SELECT id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND LOWER(iscored_username) = LOWER(?) AND score = ?
             LIMIT 1`,
            params.gameRoomId, params.gameName, params.username, params.score
        );
        if (existing) return;

        const submittedByUserId = normalizeSubmitterUserId(params.discordUserId);
        const submittedByAnonymousName =
            params.anonymousName ?? (submittedByUserId ? null : params.username);
        const submittedTournamentId =
            params.tournamentId ?? (params.source === 'tournament' ? null : null);

        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                submitted_by_anonymous_name, merged_from_anonymous_identity_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
            params.gameName, params.gameRoomId, params.gameId || null,
            params.username, params.discordUserId || 'SYSTEM',
            params.score, params.photoUrl || null, params.source,
            params.gameRoomId, submittedTournamentId, submittedByUserId, submittedByAnonymousName
        );

        // Sprint 6.5: any Discord-authenticated score establishes room membership.
        // addMember is sentinel-aware, so SYSTEM/ANON/etc. calls are no-ops.
        await RoomMembershipService.addMember(submittedByUserId, params.gameRoomId, 'submission');
    }

    /**
     * Get all score history for a specific player + game in a room.
     * Returns both tournament and community submissions.
     */
    static async getPlayerGameHistory(
        gameRoomId: string,
        gameName: string,
        username: string,
        limit = 50,
    ) {
        const db = await getDatabase();
        return db.all(`
            SELECT id, score, source, photo_url, created_at, game_id
            FROM score_history
            WHERE game_room_id = ?
            AND LOWER(game_name) = LOWER(?)
            AND LOWER(iscored_username) = LOWER(?)
            AND orphaned_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?
        `, gameRoomId, gameName, username, limit);
    }

    /**
     * Get all score history entries for a specific game (all players).
     */
    static async getGameHistory(
        gameRoomId: string,
        gameName: string,
        limit = 100,
    ) {
        const db = await getDatabase();
        return db.all(`
            SELECT id, iscored_username, score, source, created_at
            FROM score_history
            WHERE game_room_id = ?
            AND LOWER(game_name) = LOWER(?)
            AND orphaned_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?
        `, gameRoomId, gameName, limit);
    }

    /**
     * Get all submissions for a specific game_id (tournament game instance).
     * Returns every score submitted by each player, not just the best.
     */
    static async getGameSubmissions(gameRoomId: string, gameId: string) {
        const db = await getDatabase();
        return db.all(`
            SELECT id, iscored_username, score, source, photo_url, created_at
            FROM score_history
            WHERE game_room_id = ? AND game_id = ?
            AND orphaned_at IS NULL
            ORDER BY score DESC, created_at ASC
        `, gameRoomId, gameId);
    }

    /**
     * Get score counts per player for a specific game instance.
     * Returns { username: count } for players with more than 1 score.
     */
    static async getPlayerScoreCounts(gameRoomId: string, gameId: string): Promise<Record<string, number>> {
        const db = await getDatabase();
        // Look up game name so we can match score_history entries that have game_id=NULL
        // (e.g. community scores logged without a game_id)
        const game = await db.get('SELECT name FROM games WHERE id = ?', gameId);
        const gameName = game?.name;

        const rows = await db.all(`
            SELECT LOWER(iscored_username) as player_key, COUNT(*) as cnt
            FROM score_history
            WHERE game_room_id = ? AND (game_id = ? ${gameName ? 'OR (game_id IS NULL AND LOWER(game_name) = LOWER(?))' : ''})
            GROUP BY LOWER(iscored_username)
            HAVING cnt > 1
        `, ...(gameName ? [gameRoomId, gameId, gameName] : [gameRoomId, gameId]));
        const map: Record<string, number> = {};
        for (const row of rows) {
            map[(row as any).player_key] = (row as any).cnt;
        }
        return map;
    }
}
