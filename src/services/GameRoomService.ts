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
        // S22 Phase 2 (v2.44.0) — suspended rooms are hidden + inaccessible
        // pending review; excluded from the public listing outright.
        return db.all('SELECT * FROM game_rooms WHERE is_public = 1 AND suspended_at IS NULL ORDER BY name ASC');
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
        // Public self-serve room creation (v2.33.0) — when set, the creator is
        // granted 'owner' in game_room_admins inside the SAME transaction as
        // the room insert, so a crash between the two calls can never leave a
        // room with no admin. Absent for the super-admin creation path (no
        // creator to grant — the super admin isn't a room admin by default).
        ownerDiscordId?: string;
    }): Promise<GameRoom> {
        const db = await getDatabase();
        const id = crypto.randomUUID();

        await db.exec('BEGIN');
        try {
            await db.run(
                `INSERT INTO game_rooms (id, name, slug, description, is_public, logo_url, discord_guild_id, short_tag)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                id, data.name, data.slug.toLowerCase(),
                data.description || '', data.is_public !== false ? 1 : 0,
                data.logo_url || null, data.discord_guild_id || null,
                normalizeShortTag(data.short_tag),
            );

            // iScored posture (v2.81.0): iScored is a tolerated legacy bridge
            // (name-only sync, no login gate, spoofable names) — not promoted
            // for new rooms. Every new room seeds ISCORED_ENABLED off; admins
            // can opt back in later via Settings > Integrations.
            await db.run(
                `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                id, 'ISCORED_ENABLED', 'false',
            );

            // Style-system revamp P0 (honesty fix, 2026-08-13): seed a real
            // default card style so the room renders the modern card path
            // immediately instead of silently falling back to the legacy
            // GameCard path while StyleThemePicker falsely shows Banner as
            // active.
            //
            // P1 (2026-08-13) flips that seed from the interim 'banner' to
            // 'arcade' — the flagship look, and now the default every new room
            // opens on. Rooms created before P1 keep whatever they stored;
            // rooms that never stored anything are converted once by migration
            // 144, not re-derived at read time.
            await db.run(
                `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                id, 'SCOREBOARD_STYLE', 'arcade',
            );

            // Standalone-room Phase 1 (v2.32.0): a pure-web room has no Discord
            // guild, so it additionally starts with Discord off too. Admins can
            // still flip it back on later via Settings > Integrations.
            if (data.mode === 'standalone') {
                await db.run(
                    `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
                    id, 'DISCORD_ENABLED', 'false',
                );
            }

            if (data.ownerDiscordId) {
                await db.run(
                    'INSERT OR REPLACE INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, ?)',
                    id, data.ownerDiscordId, 'owner',
                );
            }

            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }

        // room_members seeding is convenience (drives MyRooms.tsx), not
        // authorization — fine to do after commit rather than inside the
        // transaction (matches AdminService.addRoomDiscordAdmin's own
        // non-transactional call to this same helper elsewhere).
        if (data.ownerDiscordId) {
            const { RoomMembershipService } = await import('./RoomMembershipService.js');
            await RoomMembershipService.addMember(data.ownerDiscordId, id, 'admin_invite');
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

    /**
     * S22 Phase 2 (v2.44.0) — super-admin room suspension. Idempotent: calling
     * this on an already-suspended room just refreshes `suspended_by`/reason
     * (the orchestrator's chosen semantic over 409, so a super-admin editing
     * the reason doesn't need a separate "unsuspend then resuspend" dance).
     */
    static async suspend(id: string, suspendedBy: string, reason?: string | null): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_rooms SET suspended_at = datetime('now'), suspended_by = ?, suspended_reason = ? WHERE id = ?`,
            suspendedBy, reason ?? null, id,
        );
        return (result.changes || 0) > 0;
    }

    /** Clears all three suspension columns. Idempotent on an already-active room. */
    static async unsuspend(id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_rooms SET suspended_at = NULL, suspended_by = NULL, suspended_reason = NULL WHERE id = ?`,
            id,
        );
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
            // v2.49.0 fix-round (tmp/room-bans-fixes.md #12) — user_bans.game_room_id
            // is a pseudo-FK (no cascade possible), same as the other columns
            // handled explicitly above. Without this, room-tier bans for a
            // deleted room orphan invisibly (game_room_id pointing at nothing).
            await db.run('DELETE FROM user_bans WHERE game_room_id = ?', id);
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
