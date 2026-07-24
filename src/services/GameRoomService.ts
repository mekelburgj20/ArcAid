import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import type { GameRoom } from '../types/index.js';

/**
 * Sprint 13 — short_tag input normalization. Empty/whitespace → null; otherwise
 * trim + slice to 6 chars + uppercase. Keeps DB values consistent with how the
 * RoomTag component renders them.
 */
function normalizeShortTag(input: string | null | undefined): string | null {
    if (input === null || input === undefined) return null;
    const trimmed = String(input).trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 6).toUpperCase();
}

export class GameRoomService {
    static async getAll(): Promise<GameRoom[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_rooms ORDER BY created_at ASC');
    }

    static async getPublic(): Promise<GameRoom[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_rooms WHERE is_public = 1 ORDER BY name ASC');
    }

    static async getById(id: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE id = ?', id);
    }

    static async getBySlug(slug: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE LOWER(slug) = LOWER(?)', slug);
    }

    static async getByGuildId(guildId: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE discord_guild_id = ?', guildId);
    }

    static async create(data: {
        name: string;
        slug: string;
        description?: string;
        is_public?: boolean;
        logo_url?: string;
        discord_guild_id?: string;
        short_tag?: string | null;
        // Standalone-room Phase 1 (v2.32.0) — absent/'connected' = today's
        // behavior. 'standalone' additionally seeds the two integration
        // toggles off below.
        mode?: 'standalone' | 'connected';
    }): Promise<GameRoom> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO game_rooms (id, name, slug, description, is_public, logo_url, discord_guild_id, short_tag)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id, data.name, data.slug.toLowerCase(),
            data.description || '', data.is_public !== false ? 1 : 0,
            data.logo_url || null, data.discord_guild_id || null,
            normalizeShortTag(data.short_tag),
        );

        // v2.2.0: new rooms get safe-by-default identity. REQUIRE_DISCORD_LOGIN=true
        // means walk-up web submitters must authenticate, which closes the
        // anonymous-name collision surface entirely. Existing rooms are unaffected;
        // admins can opt out per-room via Settings if they want kiosk/guest play.
        // NOTE: kept true for standalone rooms too — Discord OAuth is a global
        // IdP and works fine with no guild attached.
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            id, 'REQUIRE_DISCORD_LOGIN', 'true',
        );

        // Standalone-room Phase 1 (v2.32.0): a pure-web room has no Discord
        // guild and no iScored board, so both integrations start off. Admins
        // can still flip them back on later via Settings > Integrations.
        if (data.mode === 'standalone') {
            await db.run(
                `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                id, 'DISCORD_ENABLED', 'false',
            );
            await db.run(
                `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                id, 'ISCORED_ENABLED', 'false',
            );
        }

        return (await GameRoomService.getById(id))!;
    }

    static async update(id: string, data: Partial<{
        name: string;
        slug: string;
        description: string;
        is_public: boolean;
        logo_url: string | null;
        discord_guild_id: string | null;
        short_tag: string | null;
    }>): Promise<boolean> {
        const db = await getDatabase();
        const sets: string[] = [];
        const params: unknown[] = [];

        if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
        if (data.slug !== undefined) { sets.push('slug = ?'); params.push(data.slug.toLowerCase()); }
        if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
        if (data.is_public !== undefined) { sets.push('is_public = ?'); params.push(data.is_public ? 1 : 0); }
        if (data.logo_url !== undefined) { sets.push('logo_url = ?'); params.push(data.logo_url); }
        if (data.discord_guild_id !== undefined) { sets.push('discord_guild_id = ?'); params.push(data.discord_guild_id); }
        if (data.short_tag !== undefined) { sets.push('short_tag = ?'); params.push(normalizeShortTag(data.short_tag)); }

        if (sets.length === 0) return false;
        params.push(id);

        const result = await db.run(`UPDATE game_rooms SET ${sets.join(', ')} WHERE id = ?`, ...params);
        return (result.changes || 0) > 0;
    }

    static async delete(id: string): Promise<boolean> {
        const db = await getDatabase();
        // FK enforcement (S3): the room's ~14 ON DELETE CASCADE child tables
        // self-clean, but a few references are NOT cascaded and must be handled
        // here or the delete throws / orphans data:
        //   - games.tournament_id is NO ACTION (unlink + delete the room's games),
        //   - tournaments.game_room_id and ranking_groups.game_room_id are
        //     pseudo-FKs (no cascade) — delete them explicitly,
        //   - global_scores.origin_game_room_id is NO ACTION — unlink to preserve
        //     global history.
        // Games are matched by game_room_id (denormalized, migration 102) OR via
        // their tournament, so neither pinned nor tournament games are missed.
        await db.exec('BEGIN');
        try {
            const games = await db.all(
                `SELECT id FROM games
                  WHERE game_room_id = ?
                     OR tournament_id IN (SELECT id FROM tournaments WHERE game_room_id = ?)`,
                id, id,
            );
            for (const g of games) {
                await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', g.id);
                await db.run('DELETE FROM scores WHERE game_id = ?', g.id);
                await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', g.id);
                await db.run('DELETE FROM games WHERE id = ?', g.id);
            }
            await db.run('DELETE FROM ranking_groups WHERE game_room_id = ?', id);
            await db.run('DELETE FROM tournaments WHERE game_room_id = ?', id);
            await db.run('UPDATE global_scores SET origin_game_room_id = NULL WHERE origin_game_room_id = ?', id);
            const result = await db.run('DELETE FROM game_rooms WHERE id = ?', id);
            await db.exec('COMMIT');
            return (result.changes || 0) > 0;
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
    }

    /**
     * Reap tournaments (and their games) whose game_room_id references a room
     * that no longer exists — leftovers from a room deleted before delete()'s
     * cascade existed (or via a direct DB edit). The Scheduler now skips these
     * (see Scheduler.start), but they linger in the DB and on iScored. Mirrors
     * delete()'s game cascade: player scores are preserved (game_id unlinked per
     * ADR 0005), score/cache rows removed, games + tournaments deleted. Does NOT
     * touch iScored — clean those entities via the admin Reconcile tool (they
     * become "unmanaged" once their local rows are gone).
     */
    static async purgeOrphanedTournaments(): Promise<{ tournaments: number; games: number }> {
        const db = await getDatabase();
        await db.exec('BEGIN');
        try {
            const orphanRows = (await db.all(
                `SELECT id FROM tournaments
                  WHERE game_room_id IS NOT NULL
                    AND game_room_id NOT IN (SELECT id FROM game_rooms)`,
            )) as Array<{ id: string }>;
            const tIds = orphanRows.map((t) => t.id);
            if (tIds.length === 0) {
                await db.exec('COMMIT');
                return { tournaments: 0, games: 0 };
            }
            const placeholders = tIds.map(() => '?').join(',');
            const games = (await db.all(
                `SELECT id FROM games WHERE tournament_id IN (${placeholders})`,
                ...tIds,
            )) as Array<{ id: string }>;
            for (const g of games) {
                await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', g.id);
                await db.run('DELETE FROM scores WHERE game_id = ?', g.id);
                await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', g.id);
                await db.run('DELETE FROM games WHERE id = ?', g.id);
            }
            for (const tId of tIds) {
                await db.run('DELETE FROM tournaments WHERE id = ?', tId);
            }
            // Orphaned ranking groups for the missing room(s) (keyed on
            // game_room_id; ranking_groups_cache cascades off ranking_groups).
            await db.run(
                `DELETE FROM ranking_groups
                  WHERE game_room_id IS NOT NULL
                    AND game_room_id NOT IN (SELECT id FROM game_rooms)`,
            );
            await db.exec('COMMIT');
            return { tournaments: tIds.length, games: games.length };
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
    }
}
