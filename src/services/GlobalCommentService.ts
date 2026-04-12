import { getDatabase } from '../database/database.js';

export interface GlobalComment {
    id: number;
    global_game_id: string;
    discord_user_id: string;
    display_name: string;
    type: 'comment' | 'tip';
    body: string;
    created_at: string;
    avatar_hash?: string | null;
}

export class GlobalCommentService {
    /**
     * Add a comment or tip for a global game.
     */
    static async addComment(
        globalGameId: string,
        discordUserId: string,
        displayName: string,
        type: 'comment' | 'tip',
        body: string
    ): Promise<GlobalComment> {
        if (body.length > 500) throw new Error('Comment too long (max 500 characters)');
        const db = await getDatabase();
        const result = await db.run(
            `INSERT INTO global_game_comments (global_game_id, discord_user_id, display_name, type, body)
             VALUES (?, ?, ?, ?, ?)`,
            globalGameId, discordUserId, displayName, type, body
        );
        return {
            id: result.lastID!,
            global_game_id: globalGameId,
            discord_user_id: discordUserId,
            display_name: displayName,
            type,
            body,
            created_at: new Date().toISOString(),
        };
    }

    /**
     * Get comments/tips for a global game, newest first.
     * Enriches with avatar_hash from user_mappings for display.
     */
    static async getComments(
        globalGameId: string,
        type?: 'comment' | 'tip',
        page = 1,
        limit = 50
    ): Promise<GlobalComment[]> {
        const db = await getDatabase();
        const offset = (page - 1) * limit;
        const typeFilter = type ? 'AND gc.type = ?' : '';
        const params = type
            ? [globalGameId, type, limit, offset]
            : [globalGameId, limit, offset];
        return db.all(`
            SELECT gc.id, gc.global_game_id, gc.discord_user_id, gc.display_name,
                   gc.type, gc.body, gc.created_at,
                   um.avatar_hash
            FROM global_game_comments gc
            LEFT JOIN user_mappings um ON um.discord_user_id = gc.discord_user_id
            WHERE gc.global_game_id = ?
            ${typeFilter}
            GROUP BY gc.id
            ORDER BY gc.created_at DESC
            LIMIT ? OFFSET ?
        `, ...params);
    }

    /**
     * Delete a comment (author only — caller must verify authorization).
     */
    static async deleteComment(commentId: number): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM global_game_comments WHERE id = ?', commentId);
    }

    /**
     * Get a single comment by ID (for authorization checks).
     */
    static async getCommentById(commentId: number): Promise<GlobalComment | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM global_game_comments WHERE id = ?', commentId);
    }
}
