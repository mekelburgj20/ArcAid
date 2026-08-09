import { getDatabase } from '../database/database.js';

export class CommentService {
    /**
     * Add a comment or tip for a game.
     */
    static async addComment(
        gameRoomId: string,
        gameName: string,
        userId: string,
        displayName: string,
        type: 'comment' | 'tip',
        body: string
    ) {
        if (body.length > 500) throw new Error('Comment too long (max 500 characters)');
        const db = await getDatabase();
        const result = await db.run(
            `INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, type, body)
             VALUES (?, ?, ?, ?, ?, ?)`,
            gameName, gameRoomId, userId, displayName, type, body
        );
        return {
            id: result.lastID,
            game_name: gameName,
            game_room_id: gameRoomId,
            user_id: userId,
            display_name: displayName,
            type,
            body,
            created_at: new Date().toISOString(),
        };
    }

    /**
     * Get comments/tips for a game, newest first.
     */
    static async getComments(
        gameRoomId: string,
        gameName: string,
        type?: 'comment' | 'tip',
        page = 1,
        limit = 50
    ) {
        const db = await getDatabase();
        const offset = (page - 1) * limit;
        const typeFilter = type ? 'AND type = ?' : '';
        const params = type
            ? [gameRoomId, gameName, type, limit, offset]
            : [gameRoomId, gameName, limit, offset];
        return db.all(`
            SELECT id, user_id, display_name, type, body, created_at
            FROM game_comments
            WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
              AND hidden_at IS NULL
            ${typeFilter}
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, ...params);
    }

    /**
     * Delete a comment (author or admin only — caller must verify authorization).
     */
    static async deleteComment(commentId: number) {
        const db = await getDatabase();
        await db.run('DELETE FROM game_comments WHERE id = ?', commentId);
    }

    /**
     * Get a single comment by ID (for authorization checks).
     */
    static async getCommentById(commentId: number) {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_comments WHERE id = ?', commentId);
    }
}
