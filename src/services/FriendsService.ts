import { getDatabase } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface Friend {
    id: string;
    friend_user_id: string;
    friend_discord_username: string | null;
    iscored_username: string | null;
    avatar_hash: string | null;
    status: string;
    created_at: string;
}

export class FriendsService {
    /**
     * Add a friend by Discord username. Resolves to their discord_user_id
     * via user_mappings.
     */
    static async addFriend(userId: string, friendDiscordUsername: string): Promise<{ friendUserId: string }> {
        const db = await getDatabase();

        // Try to find user by Discord username in user_mappings
        // The friend must already exist in the system (have submitted a score or logged in)
        const mapping = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
            friendDiscordUsername
        );

        let friendUserId: string;
        if (mapping?.discord_user_id) {
            friendUserId = mapping.discord_user_id;
        } else {
            // Try resolving via Discord API
            const { resolveDiscordUserId } = await import('../utils/discord.js');
            const resolved = await resolveDiscordUserId(friendDiscordUsername);
            if (!resolved) {
                throw new Error(`Could not find user "${friendDiscordUsername}"`);
            }
            friendUserId = resolved;
        }

        if (friendUserId === userId) {
            throw new Error('Cannot add yourself as a friend');
        }

        const id = uuidv4();
        await db.run(
            `INSERT INTO friendships (id, user_id, friend_user_id, friend_discord_username)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, friend_user_id) DO UPDATE SET status = 'active'`,
            id, userId, friendUserId, friendDiscordUsername
        );

        return { friendUserId };
    }

    static async removeFriend(userId: string, friendUserId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM friendships WHERE user_id = ? AND friend_user_id = ?',
            userId, friendUserId
        );
    }

    static async getFriends(userId: string): Promise<Friend[]> {
        const db = await getDatabase();
        return db.all(`
            SELECT f.id, f.friend_user_id, f.friend_discord_username, f.status, f.created_at,
                   m.iscored_username, m.avatar_hash
            FROM friendships f
            LEFT JOIN user_mappings m ON m.discord_user_id = f.friend_user_id
            WHERE f.user_id = ? AND f.status = 'active'
            ORDER BY f.created_at DESC
        `, userId);
    }

    /** Fast lookup: all friend user IDs for a user */
    static async getFriendIds(userId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            "SELECT friend_user_id FROM friendships WHERE user_id = ? AND status = 'active'",
            userId
        );
        return rows.map((r: any) => r.friend_user_id);
    }

    /** Reverse lookup: who has this user as a friend? */
    static async getPlayersWhoFriended(userId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            "SELECT user_id FROM friendships WHERE friend_user_id = ? AND status = 'active'",
            userId
        );
        return rows.map((r: any) => r.user_id);
    }
}
