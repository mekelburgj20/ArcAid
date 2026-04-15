import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { GlobalLeaderboardService } from './GlobalLeaderboardService.js';
import { logInfo, logError } from '../utils/logger.js';

export interface GlobalScoreInput {
    globalGameId: string;
    playerId: string;             // discord_user_id
    iscoredUsername: string;
    score: number;
    photoBuffer?: Buffer;
    photoMimeType?: string;
    originType?: 'game_room' | 'global';
    originGameRoomId?: string | null;
    originGameId?: string | null;
    excludeFromGlobal?: boolean;
}

export interface GlobalScore {
    id: string;
    global_game_id: string;
    player_id: string;
    iscored_username: string | null;
    score: number;
    photo_url: string | null;
    photo_hash: string | null;
    origin_type: string;
    origin_game_room_id: string | null;
    origin_game_id: string | null;
    exclude_from_global: number;
    deleted_at: string | null;
    deleted_by: string | null;
    submitted_at: string;
}

/**
 * Persists `buffer` to data/score-photos/global/<uuid>.<ext> and returns
 * the public URL. Mirrors the room submission pattern.
 */
function savePhoto(buffer: Buffer, mimeType: string): { url: string; absolutePath: string } {
    const ext =
        mimeType === 'image/png' || mimeType === 'image/apng' ? 'png' :
        mimeType === 'image/webp' ? 'webp' :
        'jpg';
    const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const dir = path.join(process.cwd(), 'data', 'score-photos', 'global');
    fs.mkdirSync(dir, { recursive: true });
    const absolutePath = path.join(dir, filename);
    fs.writeFileSync(absolutePath, buffer);
    return { url: `/api/score-photos/global/${filename}`, absolutePath };
}

export class GlobalScoreService {
    /**
     * Returns true if the Discord user has an active ban (no lifted_at, and
     * either no expires_at or expires_at in the future).
     */
    static async isBanned(discordUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get(`
            SELECT id FROM user_bans
            WHERE discord_user_id = ?
              AND lifted_at IS NULL
              AND (expires_at IS NULL OR expires_at > datetime('now'))
            LIMIT 1
        `, discordUserId);
        return !!row;
    }

    /**
     * Submit a new global score. Writes the photo to disk, inserts the row,
     * and invalidates the cached leaderboard.
     *
     * Does NOT emit the WebSocket event — callers do that after this returns
     * so they can enrich the payload with game name / room name.
     */
    static async submit(input: GlobalScoreInput): Promise<GlobalScore> {
        const db = await getDatabase();

        // Ban check — ignored for room fan-out (origin_type === 'game_room'),
        // since banned users still need their room submissions recorded.
        if (input.originType !== 'game_room') {
            const banned = await this.isBanned(input.playerId);
            if (banned) {
                throw new Error('BANNED');
            }
        }

        let photoUrl: string | null = null;
        if (input.photoBuffer && input.photoMimeType) {
            const saved = savePhoto(input.photoBuffer, input.photoMimeType);
            photoUrl = saved.url;
        }

        const id = crypto.randomUUID();
        const now = new Date().toISOString();
        const excludeFlag = input.excludeFromGlobal ? 1 : 0;

        await db.run(
            `INSERT INTO global_scores (
                id, global_game_id, player_id, iscored_username, score,
                photo_url, origin_type, origin_game_room_id, origin_game_id,
                exclude_from_global, submitted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.globalGameId,
            input.playerId,
            input.iscoredUsername,
            input.score,
            photoUrl,
            input.originType || 'global',
            input.originGameRoomId || null,
            input.originGameId || null,
            excludeFlag,
            now
        );

        // Invalidate cached leaderboards for this game (global + all room scopes).
        await GlobalLeaderboardService.invalidate(input.globalGameId);

        const inserted = await db.get('SELECT * FROM global_scores WHERE id = ?', id);
        logInfo(`Global score recorded: ${input.iscoredUsername} = ${input.score} on ${input.globalGameId} (${input.originType || 'global'})`);
        return inserted as GlobalScore;
    }

    /**
     * Soft-delete a score. Cascades to cache invalidation. Photo file is kept
     * on disk until a hard-delete so admins can restore.
     */
    static async softDelete(scoreId: string, deletedBy: string): Promise<boolean> {
        const db = await getDatabase();
        const score = await db.get('SELECT global_game_id FROM global_scores WHERE id = ?', scoreId);
        if (!score) return false;
        const result = await db.run(
            `UPDATE global_scores SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`,
            deletedBy, scoreId
        );
        if ((result.changes ?? 0) > 0) {
            await GlobalLeaderboardService.invalidate(score.global_game_id);
            return true;
        }
        return false;
    }

    /**
     * Restore a soft-deleted score.
     */
    static async restore(scoreId: string): Promise<boolean> {
        const db = await getDatabase();
        const score = await db.get('SELECT global_game_id FROM global_scores WHERE id = ?', scoreId);
        if (!score) return false;
        const result = await db.run(
            `UPDATE global_scores SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`,
            scoreId
        );
        if ((result.changes ?? 0) > 0) {
            await GlobalLeaderboardService.invalidate(score.global_game_id);
            return true;
        }
        return false;
    }

    /**
     * Hard delete — removes the row and unlinks the photo file.
     */
    static async hardDelete(scoreId: string): Promise<boolean> {
        const db = await getDatabase();
        const score = await db.get(
            'SELECT global_game_id, photo_url FROM global_scores WHERE id = ?',
            scoreId
        );
        if (!score) return false;

        // Delete photo file if present
        if (score.photo_url && typeof score.photo_url === 'string' && score.photo_url.startsWith('/api/score-photos/')) {
            const relativePath = score.photo_url.replace('/api/score-photos/', '');
            const absolutePath = path.join(process.cwd(), 'data', 'score-photos', relativePath);
            try {
                if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
            } catch (err) {
                logError(`Failed to remove photo file for score ${scoreId}:`, err);
            }
        }

        const result = await db.run('DELETE FROM global_scores WHERE id = ?', scoreId);
        if ((result.changes ?? 0) > 0) {
            await GlobalLeaderboardService.invalidate(score.global_game_id);
            return true;
        }
        return false;
    }

    /**
     * Return a score row by id (including soft-deleted, for admin views).
     */
    static async getById(scoreId: string): Promise<GlobalScore | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM global_scores WHERE id = ?', scoreId);
    }

    /**
     * List scores for a game room player. Used by the personal profile page.
     */
    static async listForPlayer(discordUserId: string, limit = 50, offset = 0): Promise<GlobalScore[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM global_scores
             WHERE player_id = ? AND deleted_at IS NULL
             ORDER BY submitted_at DESC
             LIMIT ? OFFSET ?`,
            discordUserId, limit, offset
        );
    }

    /**
     * List scores for a specific global game. Admin view (includes soft-deleted).
     */
    static async listForGame(
        globalGameId: string,
        options: { includeDeleted?: boolean; limit?: number; offset?: number } = {}
    ): Promise<GlobalScore[]> {
        const db = await getDatabase();
        const limit = options.limit || 50;
        const offset = options.offset || 0;
        const deletedFilter = options.includeDeleted ? '' : 'AND deleted_at IS NULL';
        return db.all(
            `SELECT * FROM global_scores
             WHERE global_game_id = ? ${deletedFilter}
             ORDER BY score DESC
             LIMIT ? OFFSET ?`,
            globalGameId, limit, offset
        );
    }

    /**
     * Fan-out helper: given a room-originated score, mirror it into global_scores.
     *
     * Resolution order for global_game_id:
     *   1. Explicit `gameId` argument → games.global_game_id
     *   2. game_room_game_library row matching (roomId, gameName)
     *   3. game_library row matching (gameName)
     *
     * Silently skips (returns null) if:
     *   - The room has GLOBAL_SCOREBOARD_ENABLED = 'false'
     *   - No global_game_id can be resolved
     *   - The user set excludeFromGlobal (but we still record with the flag set)
     *
     * Does not throw — fan-out is best-effort and should never break the
     * room-scoped submission flow.
     */
    static async fanOutFromRoomSubmission(opts: {
        gameRoomId: string;
        gameName: string;
        gameId?: string;              // tournament game id if available
        playerId: string;              // discord_user_id (or synthetic 'COMMUNITY'/'ANON')
        iscoredUsername: string;
        score: number;
        photoUrl?: string | null;
        excludeFromGlobal?: boolean;
    }): Promise<{ globalScoreId: string; globalGameId: string; gameName: string } | null> {
        try {
            const db = await getDatabase();

            // Check the room's global opt-in setting (default ON)
            const enabledRow = await db.get(
                `SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'GLOBAL_SCOREBOARD_ENABLED'`,
                opts.gameRoomId
            );
            if (enabledRow && enabledRow.value === 'false') return null;

            // Resolve global_game_id
            let globalGameId: string | null = null;
            let globalGameName: string | null = null;

            if (opts.gameId) {
                const row = await db.get(
                    `SELECT g.global_game_id, gg.name
                     FROM games g
                     LEFT JOIN global_games gg ON gg.id = g.global_game_id
                     WHERE g.id = ?`,
                    opts.gameId
                );
                if (row?.global_game_id) {
                    globalGameId = row.global_game_id;
                    globalGameName = row.name;
                }
            }

            if (!globalGameId) {
                // Room-specific game library override
                const row = await db.get(
                    `SELECT grl.global_game_id, gg.name
                     FROM game_room_game_library grl
                     LEFT JOIN global_games gg ON gg.id = grl.global_game_id
                     WHERE grl.game_room_id = ? AND LOWER(grl.name) = LOWER(?)`,
                    opts.gameRoomId, opts.gameName
                );
                if (row?.global_game_id) {
                    globalGameId = row.global_game_id;
                    globalGameName = row.name;
                }
            }

            if (!globalGameId) {
                // Global game_library
                const row = await db.get(
                    `SELECT gl.global_game_id, gg.name
                     FROM game_library gl
                     LEFT JOIN global_games gg ON gg.id = gl.global_game_id
                     WHERE LOWER(gl.name) = LOWER(?)`,
                    opts.gameName
                );
                if (row?.global_game_id) {
                    globalGameId = row.global_game_id;
                    globalGameName = row.name;
                }
            }

            if (!globalGameId) {
                // Direct lookup in global_games catalogue by name
                const row = await db.get(
                    `SELECT id, name FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1`,
                    opts.gameName
                );
                if (row) {
                    globalGameId = row.id;
                    globalGameName = row.name;
                }
            }

            if (!globalGameId) return null;

            // Dedup: if a row already exists for this player+game+score+room origin,
            // don't create a second one. The sync poller re-runs frequently and would
            // otherwise spam duplicates.
            const existing = await db.get(
                `SELECT id FROM global_scores
                 WHERE global_game_id = ?
                   AND origin_game_room_id = ?
                   AND LOWER(iscored_username) = LOWER(?)
                   AND score = ?`,
                globalGameId, opts.gameRoomId, opts.iscoredUsername, opts.score
            );
            if (existing) return null;

            const saved = await this.submit({
                globalGameId,
                playerId: opts.playerId,
                iscoredUsername: opts.iscoredUsername,
                score: opts.score,
                // Photo isn't copied — the room already persisted it at photoUrl.
                // We reference the same URL without re-writing the file.
                originType: 'game_room',
                originGameRoomId: opts.gameRoomId,
                originGameId: opts.gameId || null,
                excludeFromGlobal: opts.excludeFromGlobal,
            });

            // Patch in the photo_url from the room's storage (submit() only handles buffer uploads)
            if (opts.photoUrl) {
                await db.run(
                    `UPDATE global_scores SET photo_url = ? WHERE id = ?`,
                    opts.photoUrl, saved.id
                );
            }

            return {
                globalScoreId: saved.id,
                globalGameId,
                gameName: globalGameName || opts.gameName,
            };
        } catch (err) {
            logError('Global fan-out failed (non-fatal):', err);
            return null;
        }
    }
}
