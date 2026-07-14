import { getDatabase } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface Friend {
    id: string;
    friend_user_id: string;
    friend_discord_username: string | null;
    iscored_username: string | null;
    /** v2.8.0: friend's chosen global display name (from user_profiles). */
    display_name: string | null;
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

    /**
     * Add a friend by Discord snowflake id directly (no username lookup).
     * The target must already be a known user in the system — either they
     * have a `user_profiles` row (created on first Discord login) or at
     * least one `user_mappings` alias (created on first score sync/submit).
     */
    static async addFriendById(userId: string, friendUserId: string): Promise<{ friendUserId: string }> {
        if (friendUserId === userId) {
            throw new Error('Cannot add yourself as a friend');
        }

        const db = await getDatabase();

        const known = await db.get(
            `SELECT 1 AS found FROM user_profiles WHERE discord_user_id = ?
             UNION
             SELECT 1 AS found FROM user_mappings WHERE discord_user_id = ?
             LIMIT 1`,
            friendUserId, friendUserId
        );
        if (!known) {
            throw new Error(`Could not find user "${friendUserId}"`);
        }

        // Resolve a display name for the friend_discord_username cache column:
        // the friend's chosen global display name first, else any iScored
        // alias they hold, else null (caller falls back further at render time).
        const profile = await db.get('SELECT display_name FROM user_profiles WHERE discord_user_id = ?', friendUserId);
        let friendDisplayName: string | null = profile?.display_name ?? null;
        if (!friendDisplayName) {
            const alias = await db.get(
                'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ? ORDER BY created_at, rowid LIMIT 1',
                friendUserId
            );
            friendDisplayName = alias?.iscored_username ?? null;
        }

        const id = uuidv4();
        await db.run(
            `INSERT INTO friendships (id, user_id, friend_user_id, friend_discord_username)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, friend_user_id) DO UPDATE SET status = 'active'`,
            id, userId, friendUserId, friendDisplayName
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
        // m.iscored_username may be one of several aliases; use MIN as a stable
        // representative (one row per friend Discord ID). avatar_hash + display_name
        // come from user_profiles (single-row per Discord ID, no ambiguity).
        return db.all(`
            SELECT f.id, f.friend_user_id, f.friend_discord_username, f.status, f.created_at,
                   MIN(m.iscored_username) AS iscored_username,
                   up.avatar_hash, up.display_name
            FROM friendships f
            LEFT JOIN user_mappings m ON m.discord_user_id = f.friend_user_id
            LEFT JOIN user_profiles up ON up.discord_user_id = f.friend_user_id
            WHERE f.user_id = ? AND f.status = 'active'
            GROUP BY f.id, f.friend_user_id, f.friend_discord_username, f.status, f.created_at, up.avatar_hash, up.display_name
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
