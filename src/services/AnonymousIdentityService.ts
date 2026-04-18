import { getDatabase } from '../database/database.js';
import type { AnonymousIdentity } from '../types/index.js';

/**
 * Service for the `anonymous_identities` table (Sprint 1 schema, Sprint 4 write path).
 *
 * An anonymous identity is the (guild_id, server_nickname) tuple typed by an
 * anonymous submitter. It is keyed independent of any score row — the score
 * rows carry `submitted_by_anonymous_name` directly, and the identity table is
 * the audit handle that Sprint 10/11 merge flows operate on.
 */
export class AnonymousIdentityService {
    /**
     * Get-or-create an anonymous identity. Keyed case-insensitively on
     * (guild_id, server_nickname). Room id is recorded on first-seen only.
     * Returns the row's PK (INTEGER).
     *
     * Pass guildId `null` for rooms without a Discord guild — identities are
     * then keyed on (room_id, server_nickname) instead.
     */
    static async upsert(params: {
        roomId: string;
        guildId: string | null;
        serverNickname: string;
    }): Promise<number> {
        const db = await getDatabase();
        const nickname = params.serverNickname.trim();
        if (!nickname) throw new Error('AnonymousIdentityService.upsert: serverNickname is required');

        // Sprint 13: DB-level atomicity. The partial UNIQUE indexes on
        // (guild_id, LOWER(server_nickname)) and (room_id, LOWER(server_nickname))
        // let us INSERT OR IGNORE and always SELECT the winning row afterward —
        // no read-check-insert race under concurrent anon submissions.
        await db.run(
            `INSERT OR IGNORE INTO anonymous_identities (server_nickname, guild_id, room_id, status)
             VALUES (?, ?, ?, 'active')`,
            nickname, params.guildId, params.roomId,
        );

        const row = await db.get(
            params.guildId
                ? `SELECT id FROM anonymous_identities
                   WHERE guild_id = ? AND LOWER(server_nickname) = LOWER(?)
                   LIMIT 1`
                : `SELECT id FROM anonymous_identities
                   WHERE guild_id IS NULL AND room_id = ? AND LOWER(server_nickname) = LOWER(?)
                   LIMIT 1`,
            ...(params.guildId ? [params.guildId, nickname] : [params.roomId, nickname]),
        );
        if (!row) throw new Error('AnonymousIdentityService.upsert: row disappeared after INSERT');
        return row.id as number;
    }

    static async getById(id: number): Promise<AnonymousIdentity | null> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT id, server_nickname, guild_id, room_id, first_seen_at, status
             FROM anonymous_identities WHERE id = ?`,
            id,
        );
        if (!row) return null;
        return {
            id: row.id,
            serverNickname: row.server_nickname,
            guildId: row.guild_id,
            roomId: row.room_id,
            firstSeenAt: row.first_seen_at,
            status: row.status,
        };
    }
}
