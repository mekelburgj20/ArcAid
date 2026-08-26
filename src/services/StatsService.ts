import { getDatabase } from '../database/database.js';
import { AchievementService } from './AchievementService.js';
import { isProviderUserId } from '../utils/identityProvider.js';
import type { IdentityCandidates } from './IdentityCandidateService.js';

/**
 * v2.4.0 note on pinned games:
 *
 * Every query in this service that takes a `gameRoomId` scopes via
 * `INNER JOIN tournaments t ON g.tournament_id = t.id` (+ `t.game_room_id = ?`).
 * Pinned games (tournament_id IS NULL) are therefore IMPLICITLY EXCLUDED from
 * room-scoped stats — a deliberate conservative default. Rationale:
 *
 *   - Rankings are tournament-scoped by design (confirmed in sprint planning).
 *   - "Tournament stats" like completed-rounds / win-percentage lose meaning
 *     for a continuously-active pinned game.
 *   - Pinned-game scores still surface in the per-game card leaderboard and
 *     the global scoreboard fan-out, so the data isn't lost — just absent
 *     from aggregate stats cards.
 *
 * If future work decides to include pinned games here, switch each JOIN to
 * LEFT JOIN and scope via `COALESCE(t.game_room_id, g.game_room_id)`; the
 * denormalized `games.game_room_id` column (migration 073) already exists
 * to support that path.
 */

/**
 * How many recent COMPLETED/ARCHIVED games the champion-streak query scans —
 * v2.74.0 (S24.5).
 *
 * The streak is "consecutive most-recent wins", and the JS loop that consumes
 * this stops at the first game the player did not win. Scanning the room's
 * ENTIRE completed history to answer that was unbounded work whose result was
 * discarded after row 1 in almost every call. 100 is a display cap, not a
 * correctness constant: a player who has won more than 100 consecutive games
 * reads as exactly 100. That is a fine trade for a trophy-case number, and if
 * anyone ever gets close, raising it is a one-line change.
 */
const CHAMPION_STREAK_SCAN_LIMIT = 100;

/**
 * v2.9x — tournament-type + time-window filters for the public Stats page
 * (RTX demo request: "key in on specific tournament durations (weeks)").
 *
 * `type` matches `tournaments.type` (e.g. 'DG', 'WG', 'MG') exactly.
 * `from`/`to` are ISO date(time) strings forming a HALF-OPEN interval:
 * `from` is inclusive, `to` is exclusive — `[from, to)`. This avoids
 * double-counting a game that ends exactly at a window boundary (e.g. the
 * Monday-00:00 instant that closes "last week" and opens "this week") and
 * matches how the FE's ISO-week/preset ranges are constructed
 * (`admin-ui/src/lib/statsWindow.ts`). Both ends are optional and independent
 * — passing only `from` means "since then", only `to` means "before then".
 *
 * Applied uniformly to `g.end_date` (the game/round's completion date) in
 * `getEnhancedAllPlayerStats`, since every query there already joins
 * `games g`. `getGameActivityStats` applies the same bounds per-branch to
 * whichever timestamp that branch actually has (see its own doc comment).
 */
export interface StatsWindowFilters {
    type?: string;
    from?: string;
    to?: string;
}

/**
 * v2.120.2 — multi-room scoping for the Discord guild-scoped reads.
 *
 * `getPlayerStats` / `getGameStats` were single-room (`gameRoomId?`) because
 * their only scoped caller was the web room page. Discord slash commands are
 * scoped to a GUILD, and one guild can link several rooms
 * (`resolveGuildReadScope` returns a LIST), so both methods gained an optional
 * `gameRoomIds?: string[]`.
 *
 * Resolution precedence, deliberately explicit:
 *   - `gameRoomIds` present (even `[]`) wins. An EMPTY array means "the guild
 *     is linked but every room it links to is excluded" and must match NOTHING
 *     — the same meaning `buildGuildScopedRoomSqlFilter`'s `AND 1 = 0` carries.
 *     Silently degrading `[]` to "all rooms" would restore the cross-room leak.
 *   - else single `gameRoomId` → a one-element list (`IN (?)` is result-
 *     identical to the previous `= ?`).
 *   - else `null` → no room predicate at all, i.e. the exact pre-v2.120.2 SQL
 *     the web callers rely on.
 */
function resolveRoomScope(gameRoomId?: string, gameRoomIds?: string[]): string[] | null {
    if (gameRoomIds !== undefined) return gameRoomIds;
    return gameRoomId ? [gameRoomId] : null;
}

/**
 * `col IN (?, ?)` for a room list; a match-nothing predicate when empty.
 *
 * `includeUnattributed` mirrors `buildGuildScopedRoomSqlFilter`'s legacy-env
 * NULL allowance: in the single-tenant env-fallback deployment, rows that
 * predate multi-room and carry no room attribution at all belong to the one
 * guild there is, and dropping them would silently shrink its stats.
 */
function roomInClause(
    column: string, roomIds: string[], includeUnattributed = false,
): { sql: string; params: string[] } {
    if (includeUnattributed) {
        if (roomIds.length === 0) return { sql: `${column} IS NULL`, params: [] };
        return {
            sql: `(${column} IS NULL OR ${column} IN (${roomIds.map(() => '?').join(', ')}))`,
            params: roomIds,
        };
    }
    if (roomIds.length === 0) return { sql: '1 = 0', params: [] };
    return { sql: `${column} IN (${roomIds.map(() => '?').join(', ')})`, params: roomIds };
}

export class StatsService {
    /**
     * Get comprehensive stats for a player by Discord user ID.
     *
     * Room scoping (see `resolveRoomScope`) restricts EVERY aggregate — games
     * played, wins, average/best score, best game, recent scores — via
     * `games` → `tournaments.game_room_id`. Pinned rows (`tournament_id IS
     * NULL`) stay excluded from any scoped call, per this file's header note.
     */
    static async getPlayerStats(
        discordUserId: string, gameRoomId?: string, gameRoomIds?: string[],
        includeUnattributedRoom = false,
    ) {
        const db = await getDatabase();

        const scopeRoomIds = resolveRoomScope(gameRoomId, gameRoomIds);
        const roomClause = scopeRoomIds
            ? roomInClause('t.game_room_id', scopeRoomIds, includeUnattributedRoom)
            : null;

        // Build room-scoped subquery for game IDs
        const gameIdFilter = roomClause
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE ${roomClause.sql})`
            : '';
        const roomParams = roomClause ? roomClause.params : [];

        // Total games played (unique games they submitted scores for)
        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE discord_user_id = ? AND s.orphaned_at IS NULL ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Total wins (games where they had the highest score)
        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomClause ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.orphaned_at IS NULL)
                AND s.discord_user_id = ?
                AND s.orphaned_at IS NULL
                ${roomClause ? `AND ${roomClause.sql}` : ''}
            )
        `, discordUserId, ...roomParams);

        // Average and best score
        const scoreStats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as best_score
            FROM submissions s
            WHERE discord_user_id = ? AND s.orphaned_at IS NULL ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Best game (game where they got their highest score)
        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomClause ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE s.discord_user_id = ?
            AND s.orphaned_at IS NULL
            ${roomClause ? `AND ${roomClause.sql}` : ''}
            ORDER BY s.score DESC
            LIMIT 1
        `, discordUserId, ...roomParams);

        // Recent scores (last 10)
        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomClause ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE s.discord_user_id = ?
            AND s.orphaned_at IS NULL
            ${roomClause ? `AND ${roomClause.sql}` : ''}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, discordUserId, ...roomParams);

        // Username from mappings
        const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', discordUserId);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;

        return {
            discordUserId,
            iscoredUsername: mapping?.iscored_username || null,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            averageScore: Math.round(scoreStats?.avg_score ?? 0),
            bestScore: scoreStats?.best_score ?? 0,
            bestGame: bestGame?.game_name || null,
            recentScores,
        };
    }

    /**
     * Get comprehensive stats for a player by iScored username.
     */
    static async getPlayerStatsByUsername(username: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) AND s.orphaned_at IS NULL ${gameIdFilter}
        `, username, ...roomParams);

        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.orphaned_at IS NULL)
                AND LOWER(s.iscored_username) = LOWER(?)
                AND s.orphaned_at IS NULL
                ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            )
        `, username, ...roomParams);

        const scoreStats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as best_score
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) AND s.orphaned_at IS NULL ${gameIdFilter}
        `, username, ...roomParams);

        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            AND s.orphaned_at IS NULL
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.score DESC
            LIMIT 1
        `, username, ...roomParams);

        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            AND s.orphaned_at IS NULL
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, username, ...roomParams);

        // Try to find a discord_user_id for this username
        const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', username);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;

        return {
            discordUserId: mapping?.discord_user_id || null,
            iscoredUsername: username,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            averageScore: Math.round(scoreStats?.avg_score ?? 0),
            bestScore: scoreStats?.best_score ?? 0,
            bestGame: bestGame?.game_name || null,
            recentScores,
        };
    }

    /**
     * Get comprehensive stats for a game by name.
     *
     * Room scoping (see `resolveRoomScope`) restricts every aggregate:
     * `timesPlayed` + `recentResults` via `games` → `tournaments.game_room_id`,
     * and `avgScore` / `uniquePlayers` / `allTimeHigh` / `allTimeHighPlayer`
     * via `score_history.game_room_id` (which is where community/freeplay
     * scores land too — they dual-write into `score_history`).
     */
    static async getGameStats(
        gameName: string, gameRoomId?: string, gameRoomIds?: string[],
        includeUnattributedRoom = false,
    ) {
        const db = await getDatabase();

        const scopeRoomIds = resolveRoomScope(gameRoomId, gameRoomIds);
        const tournamentRoomClause = scopeRoomIds
            ? roomInClause('t.game_room_id', scopeRoomIds, includeUnattributedRoom)
            : null;
        const historyRoomClause = scopeRoomIds
            ? roomInClause('game_room_id', scopeRoomIds, includeUnattributedRoom)
            : null;

        // Find all games with this name, optionally filtered by room. Still used for
        // timesPlayed ('times featured') and recentResults (genuine tournament outcomes) —
        // those stay games/submissions-based.
        let games;
        if (tournamentRoomClause) {
            games = await db.all(
                `SELECT g.id FROM games g
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.name = ? COLLATE NOCASE AND ${tournamentRoomClause.sql}`,
                gameName, ...tournamentRoomClause.params
            );
        } else {
            games = await db.all('SELECT id FROM games WHERE name = ? COLLATE NOCASE', gameName);
        }
        if (games.length === 0) return null;

        const gameIds = games.map((g: any) => g.id);

        // Times played
        const timesPlayed = gameIds.length;

        // Score stats sourced from score_history — the physical union of every submission
        // path (tournament + community/freeplay + sync). `submissions` only reflects the
        // tournament path; community/freeplay submits write score_history ONLY, so a big
        // community score was previously invisible to All-Time High / unique players.
        // Keyed by (game_room_id, game_name) rather than the games.id list above so it
        // also picks up scores logged against unpinned/no-longer-active game rows.
        const roomFilter = historyRoomClause ? `AND ${historyRoomClause.sql}` : '';
        const scoreParams = historyRoomClause ? [gameName, ...historyRoomClause.params] : [gameName];

        // avg_score mirrors the CURRENT aggregate meaning: the prior query had no
        // per-player GROUP BY (`AVG(score) FROM submissions WHERE game_id IN (...)`) —
        // it averaged every matching row as-is (submissions happens to hold one row per
        // player-per-game-instance via its own upsert semantics, but the SQL itself does
        // a flat average). This mirrors that: a flat AVG over every matching score_history
        // row (i.e. every score event, not deduped to per-player bests).
        const stats = await db.get(`
            SELECT AVG(score) as avg_score,
                   COUNT(DISTINCT COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))) as unique_players
            FROM score_history
            WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
              AND orphaned_at IS NULL
        `, ...scoreParams);

        // All-time high holder
        const highHolder = await db.get(`
            SELECT iscored_username, score
            FROM score_history
            WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
              AND orphaned_at IS NULL
            ORDER BY score DESC, created_at ASC
            LIMIT 1
        `, ...scoreParams);

        // Recent results (completed games with winner)
        const recentResults = await db.all(`
            SELECT
                t.name as tournament_name,
                s.iscored_username as winner_name,
                s.score as winner_score,
                g.end_date
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN (
                SELECT game_id, iscored_username, score,
                       ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                FROM submissions
                WHERE orphaned_at IS NULL
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE g.name = ? COLLATE NOCASE AND g.status IN ('COMPLETED', 'ARCHIVED')
            ${tournamentRoomClause ? `AND ${tournamentRoomClause.sql}` : ''}
            ORDER BY g.end_date DESC
            LIMIT 10
        `, gameName, ...(tournamentRoomClause ? tournamentRoomClause.params : []));

        return {
            gameName,
            timesPlayed,
            avgScore: Math.round(stats?.avg_score ?? 0),
            uniquePlayers: stats?.unique_players ?? 0,
            allTimeHigh: highHolder?.score ?? 0,
            allTimeHighPlayer: highHolder?.iscored_username || null,
            recentResults,
        };
    }

    /**
     * Get all-time player rankings for a specific game (all instances, any status).
     * Returns every player's best score, total plays, and last played date.
     */
    static async getGamePlayerRankings(gameName: string, gameRoomId?: string) {
        const db = await getDatabase();

        // Sourced from score_history (same rationale as getGameStats above) so community/
        // freeplay-only scores — which never touch `submissions` — are represented. Keyed
        // by (game_room_id, game_name); no gameRoomId falls back to all rooms by name.
        const roomFilter = gameRoomId ? 'AND game_room_id = ?' : '';
        const params = gameRoomId ? [gameName, gameRoomId] : [gameName];

        // Canonical player partition (mirrors LeaderboardService.recalculate): collapse by
        // submitted_by_user_id when set (multi-alias Discord users → one row), else by
        // lowercased anon name. The best row is picked via ROW_NUMBER, NOT a bare column
        // next to MAX() — SQLite only guarantees bare-column/max row binding with exactly
        // ONE min/max aggregate, and a merged user's groups span different usernames, so
        // the bare-column form can attach the wrong alias to the best score.
        const rows = await db.all(`
            SELECT
                best.iscored_username,
                best.score as best_score,
                agg.times_played,
                agg.last_played
            FROM (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    iscored_username,
                    score,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
                  AND orphaned_at IS NULL
            ) best
            JOIN (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    COUNT(*) as times_played,
                    MAX(created_at) as last_played
                FROM score_history
                WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
                  AND orphaned_at IS NULL
                GROUP BY player_key
            ) agg ON agg.player_key = best.player_key
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, ...params, ...params);

        return rows.map((r: any, i: number) => ({
            rank: i + 1,
            iscored_username: r.iscored_username,
            best_score: r.best_score,
            times_played: r.times_played,
            last_played: r.last_played,
        }));
    }

    /**
     * Get enhanced stats for a single player by Discord user ID.
     * Returns finish positions, top-5 rate, champion streak, and recent scores.
     */
    static async getEnhancedPlayerStats(discordUserId: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';

        // Total games played
        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE discord_user_id = ? ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Total wins
        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND s.discord_user_id = ?
                ${roomWhere}
            )
        `, discordUserId, ...roomParams);

        // Average finish position and top-5 rate.
        //
        // v2.74.0 (S24.5): two correlated subqueries per row became one pass of
        // RANK()/COUNT() OVER (PARTITION BY game_id). `RANK()` is the exact
        // equivalent of the old `COUNT(*) + 1 WHERE score > mine` — it is 1 plus
        // the number of STRICTLY higher rows, so ties still share a position.
        // The result shape is byte-identical; the JS reduce below is untouched.
        const finishStats = await db.all(`
            WITH scoped AS (
                SELECT s.game_id, s.score, s.discord_user_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                ${roomWhere}
            )
            SELECT game_id, finish_position, total_players FROM (
                SELECT game_id, discord_user_id,
                       RANK() OVER (PARTITION BY game_id ORDER BY score DESC) as finish_position,
                       COUNT(*) OVER (PARTITION BY game_id) as total_players
                FROM scoped
            )
            WHERE discord_user_id = ?
        `, ...roomParams, discordUserId);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;
        const avgFinish = finishStats.length > 0
            ? finishStats.reduce((sum: number, r: any) => sum + r.finish_position, 0) / finishStats.length
            : 0;
        const top5Count = finishStats.filter((r: any) => r.finish_position <= 5).length;
        const top5Rate = finishStats.length > 0 ? top5Count / finishStats.length : 0;

        // Champion streak: consecutive most-recent wins.
        //
        // v2.74.0 (S24.5): bounded + de-correlated. The JS loop below `break`s
        // at the first non-win, so scanning EVERY completed game a room has
        // ever run (with a per-game winner subquery) was work that got thrown
        // away after the first row in the overwhelming majority of calls.
        // CHAMPION_STREAK_SCAN_LIMIT caps it; the winner comes from one
        // ROW_NUMBER pass over the bounded game set.
        const recentGames = await db.all(`
            WITH recent AS (
                SELECT g.id as game_id, g.end_date
                FROM games g
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                ${roomWhere}
                ORDER BY g.end_date DESC
                LIMIT ${CHAMPION_STREAK_SCAN_LIMIT}
            ),
            winners AS (
                SELECT s.game_id, s.discord_user_id,
                       ROW_NUMBER() OVER (PARTITION BY s.game_id ORDER BY s.score DESC) as rn
                FROM submissions s
                WHERE s.game_id IN (SELECT game_id FROM recent)
            )
            SELECT r.game_id, r.end_date, w.discord_user_id as winner_id
            FROM recent r
            LEFT JOIN winners w ON w.game_id = r.game_id AND w.rn = 1
            ORDER BY r.end_date DESC
        `, ...roomParams);

        let championStreak = 0;
        for (const game of recentGames) {
            if ((game as any).winner_id === discordUserId) {
                championStreak++;
            } else {
                break;
            }
        }

        // Best game
        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE s.discord_user_id = ?
            ${roomWhere}
            ORDER BY s.score DESC
            LIMIT 1
        `, discordUserId, ...roomParams);

        // Recent scores
        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE s.discord_user_id = ?
            ${roomWhere}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, discordUserId, ...roomParams);

        const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', discordUserId);

        // S13 trophy case: achievements delegate to AchievementService.getForPlayer
        // verbatim (do not reimplement); personalBests is a room-scoped
        // best-per-game ranking derived from `score_history` (v2.74.0, S24.5 —
        // was `submissions`).
        const achievements = gameRoomId
            ? await AchievementService.getForPlayer(gameRoomId, {
                discordUserId,
                username: mapping?.iscored_username || '',
            })
            : { tournamentWins: 0, milestones: 0, roomRecords: 0, recent: [] };
        const personalBests = await StatsService.getPersonalBests(discordUserId, gameRoomId);
        // Weekly participation streak, canonical partition key = discordUserId
        // directly (matches getPersonalBests's playerKey usage above — for a
        // Discord-id caller, submitted_by_user_id IS the discord id).
        const participationStreak = await StatsService.getParticipationStreak(discordUserId, gameRoomId);

        return {
            discordUserId,
            iscoredUsername: mapping?.iscored_username || null,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            avg_finish_position: Math.round(avgFinish * 10) / 10,
            top5_rate: Math.round(top5Rate * 100) / 100,
            champion_streak: championStreak,
            bestGame: bestGame?.game_name || null,
            recentScores,
            achievements,
            personalBests,
            participationStreak,
        };
    }

    /**
     * Get enhanced stats for a single player by iScored username.
     */
    static async getEnhancedPlayerStatsByUsername(username: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';

        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) ${gameIdFilter}
        `, username, ...roomParams);

        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND LOWER(s.iscored_username) = LOWER(?)
                ${roomWhere}
            )
        `, username, ...roomParams);

        // v2.74.0 (S24.5) — window-function twin of the discord-id copy above.
        const finishStats = await db.all(`
            WITH scoped AS (
                SELECT s.game_id, s.score, s.iscored_username
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                ${roomWhere}
            )
            SELECT game_id, finish_position, total_players FROM (
                SELECT game_id, iscored_username,
                       RANK() OVER (PARTITION BY game_id ORDER BY score DESC) as finish_position,
                       COUNT(*) OVER (PARTITION BY game_id) as total_players
                FROM scoped
            )
            WHERE LOWER(iscored_username) = LOWER(?)
        `, ...roomParams, username);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;
        const avgFinish = finishStats.length > 0
            ? finishStats.reduce((sum: number, r: any) => sum + r.finish_position, 0) / finishStats.length
            : 0;
        const top5Count = finishStats.filter((r: any) => r.finish_position <= 5).length;
        const top5Rate = finishStats.length > 0 ? top5Count / finishStats.length : 0;

        // Champion streak by username — v2.74.0 (S24.5), see the discord-id twin.
        const recentGames = await db.all(`
            WITH recent AS (
                SELECT g.id as game_id, g.end_date
                FROM games g
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                ${roomWhere}
                ORDER BY g.end_date DESC
                LIMIT ${CHAMPION_STREAK_SCAN_LIMIT}
            ),
            winners AS (
                SELECT s.game_id, LOWER(s.iscored_username) as iscored_username,
                       ROW_NUMBER() OVER (PARTITION BY s.game_id ORDER BY s.score DESC) as rn
                FROM submissions s
                WHERE s.game_id IN (SELECT game_id FROM recent)
            )
            SELECT r.game_id, r.end_date, w.iscored_username as winner_username
            FROM recent r
            LEFT JOIN winners w ON w.game_id = r.game_id AND w.rn = 1
            ORDER BY r.end_date DESC
        `, ...roomParams);

        let championStreak = 0;
        for (const game of recentGames) {
            if ((game as any).winner_username === username.toLowerCase()) {
                championStreak++;
            } else {
                break;
            }
        }

        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${roomWhere}
            ORDER BY s.score DESC
            LIMIT 1
        `, username, ...roomParams);

        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${roomWhere}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, username, ...roomParams);

        const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', username);

        // Room-nickname fallback (v2.23.2): Discord OAuth login writes no
        // user_mappings row, so a web-native player's name may exist only as
        // this room's room_members.display_name claim. Global alias wins when
        // both exist; lookup-only (creates no identity records).
        let resolvedDiscordId: string | null = mapping?.discord_user_id || null;
        if (!resolvedDiscordId && gameRoomId) {
            const member = await db.get(
                'SELECT user_id FROM room_members WHERE room_id = ? AND LOWER(display_name) = LOWER(?)',
                gameRoomId, username
            );
            resolvedDiscordId = member?.user_id || null;
        }

        // S13 trophy case: canonical partition key mirrors every other
        // room-scoped ranking query — the real Discord id when this name is
        // linked (alias or room claim), else the 'iscored:<username>' synthetic
        // fallback.
        const playerKey = resolvedDiscordId || `iscored:${username.toLowerCase()}`;
        const achievements = gameRoomId
            ? await AchievementService.getForPlayer(gameRoomId, {
                discordUserId: resolvedDiscordId,
                username,
            })
            : { tournamentWins: 0, milestones: 0, roomRecords: 0, recent: [] };
        const personalBests = await StatsService.getPersonalBests(playerKey, gameRoomId);
        const participationStreak = await StatsService.getParticipationStreak(playerKey, gameRoomId);

        return {
            discordUserId: resolvedDiscordId,
            iscoredUsername: username,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            avg_finish_position: Math.round(avgFinish * 10) / 10,
            top5_rate: Math.round(top5Rate * 100) / 100,
            champion_streak: championStreak,
            bestGame: bestGame?.game_name || null,
            recentScores,
            achievements,
            personalBests,
            participationStreak,
        };
    }

    /**
     * S13 trophy case: the player's best score per game in a room, ranked
     * against every other player's best on the same game.
     *
     * ## The game key is `(game_room_id, LOWER(game_name))`, NOT `game_id`
     *
     * `score_history` rows are keyed by `game_name` + `game_room_id`. Its
     * `game_id` column is at best a transient pointer and is NULL on every row
     * in production (verified 2026-08-02: zero non-NULL `game_id` rows
     * table-wide). Two forces drive it to NULL: the dominant web submit path
     * (`CommunityScoreService` → `ScoreHistoryService.log`) never supplies a
     * `gameId` at all, and every unpin / game-delete / cleanup path
     * deliberately runs `UPDATE score_history SET game_id = NULL` to preserve
     * the score after its `games` row goes away (ADR 0005). The paths that DO
     * pass a `gameId` (Discord `/submit-score`, the iScored sync writers, the
     * bulk CSV import) therefore only ever populate it until the next
     * rotation. Net effect: any read that does `JOIN games g ON sh.game_id =
     * g.id` matches NOTHING. `RoomScoresService` is the matching doctrine —
     * it scopes by `game_room_id`, groups by `LOWER(game_name)`, takes the
     * display name from `MAX(game_name)`, and never joins `games`. This does
     * the same. `game_room_id` stays in the key even on the unscoped call so
     * the same game name in two rooms remains two separate boards.
     *
     * Room-scoping is `AND sh.game_room_id = ?`, exactly like the sibling
     * `getParticipationStreak`.
     *
     * ### Deliberate behavior deltas vs. the pre-v2.74 `submissions` list
     *
     * Scores on pinned games, freeplay/community scores, and scores whose
     * `games` row has since been deleted ALL appear now — none of them did
     * under the old `JOIN games`/`JOIN tournaments` scoping. That is
     * consistent with the Room Scores page, which shows exactly this
     * population. A score outliving its game and still ranking is intended.
     * The moderation rule is unchanged: deleting the `score_history` rows
     * removes the best.
     *
     * `playerKey` is the three-leg identity key: COALESCE(submitted_by_user_id,
     * um.discord_user_id, 'iscored:' || LOWER(iscored_username)) — the
     * user_mappings leg folds NULL-attribution rows of a Discord-linked alias
     * (pre-link iScored syncs) into the mapped user. room_rank/total_players
     * are computed over that same partition per game so multi-alias players
     * collapse to one ranked row, matching LeaderboardService.
     *
     * ## v2.74.0 (S24.5) — source moved from `submissions` to `score_history`
     *
     * This was the last doctrine violation in the stats payload. `submissions`
     * is the best-EVER-per-player cache; `score_history` is the event log and
     * the table every other derivation in this file (and in
     * `LeaderboardService` / `RoomScoresService` / `RankingService`) reads.
     * They disagree in exactly the cases that matter here: the per-row delete
     * machinery (v2.9.0) removes `score_history` rows and RECOMPUTES the
     * `submissions` row from what remains, and the orphan flip marks
     * `score_history`. A best derived from `submissions` could therefore
     * outlive the score it came from, or survive a moderation delete.
     *
     * The sibling `getParticipationStreak` already read `score_history`, so
     * the two halves of the same payload were derived from different tables —
     * they now agree. Collapsing many events to one best per player is what
     * `best_per_player` already did, so the shape is unchanged. (The S24.5
     * revision scoped via `JOIN games`, which is what the name+room keying
     * documented above replaces.)
     */
    private static async getPersonalBests(playerKey: string, gameRoomId?: string) {
        const db = await getDatabase();

        const roomWhere = gameRoomId ? 'AND sh.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const rows = await db.all(`
            WITH scoped AS (
                SELECT sh.game_room_id AS game_room_id, LOWER(sh.game_name) AS game_key,
                       sh.game_name AS game_name, sh.score AS score, sh.created_at AS timestamp,
                       COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS player_key
                FROM score_history sh
                LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                WHERE sh.orphaned_at IS NULL
                ${roomWhere}
            ),
            -- S24.5: rank only the games this player actually appears on.
            -- Pre-S24 every player on every game in the room was ranked and
            -- then all but one player's rows were thrown away at the final
            -- WHERE. The rank itself still needs every player ON THOSE GAMES,
            -- which is why the filter narrows games rather than players.
            player_games AS (
                SELECT DISTINCT game_room_id, game_key FROM scoped WHERE player_key = ?
            ),
            board AS (
                SELECT s.*
                FROM scoped s
                JOIN player_games pg
                  ON pg.game_room_id = s.game_room_id AND pg.game_key = s.game_key
            ),
            -- Display name for the board, collapsing casing variants of the
            -- same game_name into one — same rule as RoomScoresService.
            game_names AS (
                SELECT game_room_id, game_key, MAX(game_name) AS game_name
                FROM board
                GROUP BY game_room_id, game_key
            ),
            best_per_player AS (
                SELECT game_room_id, game_key, player_key, score, timestamp,
                       ROW_NUMBER() OVER (PARTITION BY game_room_id, game_key, player_key ORDER BY score DESC, timestamp DESC) AS rn
                FROM board
            ),
            top AS (
                SELECT game_room_id, game_key, player_key, score AS best_score, timestamp AS achieved_at
                FROM best_per_player WHERE rn = 1
            ),
            ranked AS (
                SELECT game_room_id, game_key, player_key, best_score, achieved_at,
                       RANK() OVER (PARTITION BY game_room_id, game_key ORDER BY best_score DESC) AS room_rank,
                       COUNT(*) OVER (PARTITION BY game_room_id, game_key) AS total_players
                FROM top
            )
            SELECT gn.game_name AS game_name, r.best_score, r.room_rank, r.total_players, r.achieved_at
            FROM ranked r
            JOIN game_names gn ON gn.game_room_id = r.game_room_id AND gn.game_key = r.game_key
            WHERE r.player_key = ?
            ORDER BY r.room_rank ASC, gn.game_name ASC
            -- The FE filters this list client-side (searchable Personal Bests on
            -- the player detail page), so it must be effectively COMPLETE — a
            -- top-50 truncation would hide a player's best on a game they rank
            -- poorly at, which is exactly what the search is for. 1000 is a
            -- backstop against pathological data, not a paging boundary: the
            -- number of distinct games one player has scored on in one room is
            -- naturally bounded well below it.
            LIMIT 1000
        `, ...roomParams, playerKey, playerKey);

        return rows;
    }

    /**
     * v2.82.0 (My Stats v1, Identity arc Phase 3, WS1 decision 2) — PUBLIC
     * sibling of `getPersonalBests` above for the cross-room "My Stats" page.
     * Same doctrine (see that method's comment for the full `(game_room_id,
     * LOWER(game_name))` keying rationale, the `score_history`-not-`submissions`
     * source-of-truth reasoning, and why `game_id` is unusable) — this comment
     * only covers what's DIFFERENT.
     *
     * ## Multi-alias rank correctness (the recon-flagged trap)
     *
     * `getPersonalBests` takes ONE `playerKey` because a room-scoped page only
     * ever has one identity to resolve (`resolvedDiscordId` or the synthetic
     * `iscored:<name>` fallback). My Stats resolves a whole
     * `IdentityCandidateService.forUser()` candidate set — a Discord user may
     * hold several iScored aliases, each producing its OWN `player_key` via
     * the three-leg expression below. Filtering with a bare
     * `player_key IN (candidates.playerKeys)` would rank each alias as a
     * SEPARATE competitor on the same game — the same person's two aliases
     * would occupy two rows AND get double-counted in `total_players`.
     *
     * The fix: fold every row whose `player_key` is one of this person's
     * candidates onto ONE `canonical_key` (`candidates.canonicalKey`) INSIDE
     * the query, via a `CASE` expression, BEFORE the best-per-player collapse
     * and the `RANK()`/`COUNT()` window functions partition on it. Every
     * other player's `player_key` passes through the `CASE` unchanged, so
     * their ranks are untouched. One person = one competitor; a regression
     * test (two aliases of the viewer scoring on the same game -> ONE row,
     * `total_players` counting them once) guards this — see
     * `identity-candidate-service.test.ts` / the My Stats route tests.
     *
     * Rows additionally carry `room_id`/`room_slug`/`room_name`/`room_logo_url`
     * (the FE has no room context to fall back on, unlike the room-scoped
     * `PlayerDetail` page) via a join on `game_rooms`, excluding suspended
     * rooms (`suspended_at IS NULL` — a suspended room's leaderboard is
     * inaccessible everywhere else, so a personal best surviving here would
     * be a leak). `room_logo_url` is nullable — FE falls back to the room-name
     * text caption when a room has no logo (owner revision, screenshot review).
     *
     * `gameRoomId` narrows to one room (My Stats `scope=<roomId>`); omitted
     * runs across every room the candidate set has ever scored in (`scope=all`).
     */
    static async getPersonalBestsForIdentities(candidates: IdentityCandidates, gameRoomId?: string) {
        const db = await getDatabase();
        const { playerKeys, canonicalKey } = candidates;

        const roomWhere = gameRoomId ? 'AND sh.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];
        const candidatePlaceholders = playerKeys.map(() => '?').join(', ');

        const rows = await db.all(`
            WITH scoped AS (
                SELECT sh.game_room_id AS game_room_id, LOWER(sh.game_name) AS game_key,
                       sh.game_name AS game_name, sh.score AS score, sh.created_at AS timestamp,
                       COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS player_key
                FROM score_history sh
                LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                WHERE sh.orphaned_at IS NULL
                ${roomWhere}
            ),
            -- Multi-alias collapse (see method doc comment above): every row
            -- belonging to ANY of this person's candidate player_keys folds
            -- onto ONE canonical_key. Every other player's player_key passes
            -- through unchanged.
            canon AS (
                SELECT *, CASE WHEN player_key IN (${candidatePlaceholders}) THEN ? ELSE player_key END AS canonical_key
                FROM scoped
            ),
            player_games AS (
                SELECT DISTINCT game_room_id, game_key FROM canon WHERE canonical_key = ?
            ),
            board AS (
                SELECT c.*
                FROM canon c
                JOIN player_games pg
                  ON pg.game_room_id = c.game_room_id AND pg.game_key = c.game_key
            ),
            game_names AS (
                SELECT game_room_id, game_key, MAX(game_name) AS game_name
                FROM board
                GROUP BY game_room_id, game_key
            ),
            best_per_player AS (
                SELECT game_room_id, game_key, canonical_key, score, timestamp,
                       ROW_NUMBER() OVER (PARTITION BY game_room_id, game_key, canonical_key ORDER BY score DESC, timestamp DESC) AS rn
                FROM board
            ),
            top AS (
                SELECT game_room_id, game_key, canonical_key, score AS best_score, timestamp AS achieved_at
                FROM best_per_player WHERE rn = 1
            ),
            ranked AS (
                SELECT game_room_id, game_key, canonical_key, best_score, achieved_at,
                       RANK() OVER (PARTITION BY game_room_id, game_key ORDER BY best_score DESC) AS room_rank,
                       COUNT(*) OVER (PARTITION BY game_room_id, game_key) AS total_players
                FROM top
            )
            SELECT gn.game_name AS game_name, r.best_score, r.room_rank, r.total_players, r.achieved_at,
                   gr.id AS room_id, gr.slug AS room_slug, gr.name AS room_name, gr.logo_url AS room_logo_url
            FROM ranked r
            JOIN game_names gn ON gn.game_room_id = r.game_room_id AND gn.game_key = r.game_key
            JOIN game_rooms gr ON gr.id = r.game_room_id AND gr.suspended_at IS NULL
            WHERE r.canonical_key = ?
            ORDER BY r.room_rank ASC, gn.game_name ASC
            -- Same backstop rationale as getPersonalBests: this is a
            -- completeness bound for the FE's client-side search, not a
            -- paging boundary.
            LIMIT 1000
        `, ...roomParams, ...playerKeys, canonicalKey, canonicalKey, canonicalKey);

        return rows;
    }

    /**
     * v2.82.0 (My Stats v1, WS1 decision 4) — total `score_history` events
     * attributable to any of this person's candidate identities. Unlike
     * `getPersonalBestsForIdentities` above, this is a plain count of rows,
     * not a rank — there is no double-counting trap here, because counting
     * "how many events did any of my aliases produce" is exactly what a bare
     * `player_key IN (playerKeys)` filter computes correctly (the trap in the
     * ranking query is about collapsing MULTIPLE rows into ONE competitor;
     * a count has no such collapse to get wrong).
     */
    static async countScoresForIdentities(playerKeys: string[], gameRoomId?: string): Promise<number> {
        const db = await getDatabase();
        const roomWhere = gameRoomId ? 'AND sh.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];
        const placeholders = playerKeys.map(() => '?').join(', ');

        const row = await db.get<{ cnt: number }>(`
            SELECT COUNT(*) AS cnt
            FROM score_history sh
            LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
            WHERE sh.orphaned_at IS NULL
              AND COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username)) IN (${placeholders})
              ${roomWhere}
        `, ...playerKeys, ...roomParams);

        return row?.cnt ?? 0;
    }

    /**
     * S14 social loops — weekly participation streak from `score_history`
     * (canonical partition key, orphaned rows excluded). "Week" is SQLite's
     * own `strftime('%Y-%W', ...)` bucket (Monday-based week-of-year).
     *
     * Consecutiveness between two adjacent distinct weeks is verified by
     * asking SQLite itself whether "7 days after the earlier week's first
     * score" lands in the later week's bucket — NOT by diffing `%Y-%W`
     * strings as integers, which breaks across year boundaries (e.g. week
     * 2026-51 → 2027-00 is a 1-week gap in `%W` terms but a 2-unit jump in
     * naive `year*53+week` arithmetic).
     *
     * `currentWeeks` is 0 unless the player's most recent scoring week is
     * THIS week or the immediately-previous week (a player who scored last
     * week but hasn't yet this week still has a "live" streak); otherwise
     * it's the length of the consecutive run ending at that most-recent week.
     * `bestWeeks` is the longest such run ever, regardless of recency.
     */
    static async getParticipationStreak(playerKey: string, gameRoomId?: string): Promise<{ currentWeeks: number; bestWeeks: number }> {
        const db = await getDatabase();

        const roomFilter = gameRoomId ? 'AND game_room_id = ?' : '';
        const params = gameRoomId ? [playerKey, gameRoomId] : [playerKey];

        const rows = await db.all(`
            WITH weeks AS (
                SELECT strftime('%Y-%W', sh.created_at) AS week,
                       MIN(sh.created_at) AS week_start
                FROM score_history sh
                LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                WHERE COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username)) = ?
                  ${roomFilter}
                  AND sh.orphaned_at IS NULL
                GROUP BY week
            ),
            ordered AS (
                SELECT week, week_start,
                       LAG(week_start) OVER (ORDER BY week_start) AS prev_week_start
                FROM weeks
            )
            SELECT week,
                   CASE WHEN prev_week_start IS NOT NULL
                        AND strftime('%Y-%W', datetime(prev_week_start, '+7 days')) = week
                   THEN 1 ELSE 0 END AS is_consecutive
            FROM ordered
            ORDER BY week_start ASC
        `, ...params);

        if (rows.length === 0) return { currentWeeks: 0, bestWeeks: 0 };

        let bestWeeks = 0;
        let run = 0;
        const runs: number[] = [];
        for (const r of rows) {
            run = (r as any).is_consecutive ? run + 1 : 1;
            runs.push(run);
            if (run > bestWeeks) bestWeeks = run;
        }

        const nowRow = await db.get<{ week: string; prev_week: string }>(
            `SELECT strftime('%Y-%W','now') as week, strftime('%Y-%W','now','-7 days') as prev_week`
        );
        const lastWeek = (rows[rows.length - 1] as any).week;
        const isLive = !!nowRow && (lastWeek === nowRow.week || lastWeek === nowRow.prev_week);
        const currentWeeks = isLive ? runs[runs.length - 1]! : 0;

        return { currentWeeks, bestWeeks };
    }

    /**
     * S14 social loops — head-to-head comparison of two players' best-per-game
     * scores in a room. Identifier resolution mirrors the
     * `/stats/enhanced/player/:identifier` dispatch: a provider identity key
     * (17-20 digit Discord snowflake OR `google:<sub>`) is treated as an ID,
     * otherwise as an iScored username resolved via `user_mappings`
     * (playerKey collapses to the mapped discord_user_id when present, else
     * the `iscored:<username>` synthetic fallback — same rule as
     * getEnhancedPlayerStatsByUsername).
     */
    static async comparePlayersHeadToHead(gameRoomId: string, aIdentifier: string, bIdentifier: string) {
        const db = await getDatabase();

        const resolve = async (identifier: string) => {
            const isProviderId = isProviderUserId(identifier);
            let discordUserId: string | null;
            let playerKey: string;
            if (isProviderId) {
                discordUserId = identifier;
                playerKey = identifier;
            } else {
                // Global alias first (user_mappings — the explicit claim), then
                // this room's nickname claims: Discord OAuth login writes NO
                // user_mappings row, so a web-native player's name may exist
                // ONLY as their room_members.display_name claim — without this
                // fallback they're unreachable by the very name this room
                // displays them under. Lookup-only: no identity records are
                // created, and NULL-attribution rows still fold solely via
                // real alias links (per-room first-claim ≠ global ownership).
                const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', identifier);
                let resolved: string | null = mapping?.discord_user_id || null;
                if (!resolved) {
                    const member = await db.get(
                        'SELECT user_id FROM room_members WHERE room_id = ? AND LOWER(display_name) = LOWER(?)',
                        gameRoomId, identifier
                    );
                    resolved = member?.user_id || null;
                }
                discordUserId = resolved;
                playerKey = resolved || `iscored:${identifier.toLowerCase()}`;
            }
            const profile = discordUserId
                ? await db.get('SELECT display_name FROM user_profiles WHERE discord_user_id = ?', discordUserId)
                : null;
            const displayName: string = profile?.display_name ?? identifier;
            return { identifier, playerKey, discordUserId, displayName };
        };

        const a = await resolve(aIdentifier);
        const b = await resolve(bIdentifier);

        // Canonical best-per-player-per-game (score_history, orphaned excluded),
        // room-scoped, keyed by LOWER(game_name) so casing differences between
        // the two players' rows for "the same" game still match up.
        //
        // Row identity is the THREE-leg key: submitted_by_user_id (web/attributed
        // rows) → user_mappings.discord_user_id (rows synced from iScored BEFORE
        // the alias was Discord-linked carry NULL attribution — the um join folds
        // them into the mapped user) → the 'iscored:<name>' synthetic fallback.
        // Without the middle leg, a linked player's pre-link sync history lives
        // under a key the resolver can never produce, and compare reports
        // "no shared games" for players who are on the same leaderboard
        // (rtx_pinball field report, 2026-07-15).
        const bestPerGame = async (playerKey: string): Promise<Map<string, { game_name: string; score: number }>> => {
            const rows = await db.all(`
                SELECT game_name, score FROM (
                    SELECT sh.game_name AS game_name, sh.score AS score,
                           ROW_NUMBER() OVER (
                               PARTITION BY LOWER(sh.game_name)
                               ORDER BY sh.score DESC, sh.created_at ASC
                           ) as rn
                    FROM score_history sh
                    LEFT JOIN user_mappings um ON um.iscored_username = sh.iscored_username COLLATE NOCASE
                    WHERE sh.game_room_id = ?
                      AND sh.orphaned_at IS NULL
                      AND COALESCE(sh.submitted_by_user_id, um.discord_user_id, 'iscored:' || LOWER(sh.iscored_username)) = ?
                )
                WHERE rn = 1
            `, gameRoomId, playerKey);
            const map = new Map<string, { game_name: string; score: number }>();
            for (const r of rows as any[]) map.set(r.game_name.toLowerCase(), { game_name: r.game_name, score: r.score });
            return map;
        };

        const [aBests, bBests] = await Promise.all([bestPerGame(a.playerKey), bestPerGame(b.playerKey)]);

        const allKeys = new Set<string>([...aBests.keys(), ...bBests.keys()]);
        const sharedGames: Array<{ game_name: string; a_best: number; b_best: number; leader: 'a' | 'b' | 'tie'; gap: number }> = [];
        let aOnlyGames = 0;
        let bOnlyGames = 0;
        let aWins = 0;
        let bWins = 0;
        let ties = 0;

        for (const key of allKeys) {
            const aEntry = aBests.get(key);
            const bEntry = bBests.get(key);
            if (aEntry && bEntry) {
                let leader: 'a' | 'b' | 'tie';
                if (aEntry.score > bEntry.score) { leader = 'a'; aWins++; }
                else if (bEntry.score > aEntry.score) { leader = 'b'; bWins++; }
                else { leader = 'tie'; ties++; }
                sharedGames.push({
                    game_name: aEntry.game_name,
                    a_best: aEntry.score,
                    b_best: bEntry.score,
                    leader,
                    gap: Math.abs(aEntry.score - bEntry.score),
                });
            } else if (aEntry) {
                aOnlyGames++;
            } else if (bEntry) {
                bOnlyGames++;
            }
        }

        sharedGames.sort((x, y) => x.game_name.localeCompare(y.game_name));

        return {
            a: { identifier: a.identifier, displayName: a.displayName, discordUserId: a.discordUserId },
            b: { identifier: b.identifier, displayName: b.displayName, discordUserId: b.discordUserId },
            sharedGames: sharedGames.slice(0, 100),
            aOnlyGames,
            bOnlyGames,
            totals: { aWins, bWins, ties },
        };
    }

    /**
     * Get enhanced stats for all players (with wins, finish position, top-5 rate, streak).
     */
    static async getEnhancedAllPlayerStats(gameRoomId?: string, filters?: StatsWindowFilters) {
        const db = await getDatabase();

        // v2.9x — `type` needs the tournaments join even in the (currently
        // unused-in-practice) no-gameRoomId case; every real caller passes a
        // roomId, but this keeps the filter correct if that ever changes.
        // See `StatsWindowFilters` doc comment for the `[from, to)` boundary
        // semantics — both bounds compare against `g.end_date`, which every
        // query below already has in scope via `roomJoin`/`FROM games g`.
        const roomJoin = (gameRoomId || filters?.type) ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const conds: string[] = [];
        const roomParams: any[] = [];
        if (gameRoomId) { conds.push('t.game_room_id = ?'); roomParams.push(gameRoomId); }
        if (filters?.type) { conds.push('t.type = ?'); roomParams.push(filters.type); }
        if (filters?.from) { conds.push('g.end_date >= ?'); roomParams.push(filters.from); }
        if (filters?.to) { conds.push('g.end_date < ?'); roomParams.push(filters.to); }
        const roomWhere = conds.length ? `AND ${conds.join(' AND ')}` : '';

        // Get all players with games played and wins
        const players = await db.all(`
            SELECT
                LOWER(s.iscored_username) as player_key,
                COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                up.display_name,
                up.username,
                CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                     THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                     ELSE s.discord_user_id
                END as discord_user_id,
                COUNT(DISTINCT s.game_id) as games_played
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
            ${roomWhere}
            GROUP BY LOWER(s.iscored_username)
        `, ...roomParams);

        // Get finish positions for all players in completed games
        const allFinishes = await db.all(`
            SELECT LOWER(s.iscored_username) as player_key,
                   s.game_id,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
            ${roomWhere}
        `, ...roomParams);

        // Build finish stats map
        const finishMap = new Map<string, number[]>();
        for (const row of allFinishes) {
            const key = (row as any).player_key;
            if (!finishMap.has(key)) finishMap.set(key, []);
            finishMap.get(key)!.push((row as any).finish_position);
        }

        // Get wins per player
        const winRows = await db.all(`
            SELECT LOWER(s.iscored_username) as player_key, COUNT(*) as wins
            FROM (
                SELECT s.game_id, s.iscored_username
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                ${roomWhere}
            ) s
            GROUP BY LOWER(s.iscored_username)
        `, ...roomParams);

        const winMap = new Map<string, number>();
        for (const row of winRows) {
            winMap.set((row as any).player_key, (row as any).wins);
        }

        // Champion streak: recent completed games
        const recentGames = await db.all(`
            SELECT g.id as game_id,
                   (SELECT LOWER(s2.iscored_username) FROM submissions s2 WHERE s2.game_id = g.id ORDER BY s2.score DESC LIMIT 1) as winner_key
            FROM games g
            ${roomJoin}
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, ...roomParams);

        // Calculate streak for each player
        const streakMap = new Map<string, number>();
        for (const player of players) {
            const key = (player as any).player_key;
            let streak = 0;
            for (const game of recentGames) {
                if ((game as any).winner_key === key) {
                    streak++;
                } else {
                    break;
                }
            }
            if (streak > 0) streakMap.set(key, streak);
        }

        // Assemble results
        const results = players.map((p: any) => {
            const finishes = finishMap.get(p.player_key) || [];
            const avgFinish = finishes.length > 0
                ? finishes.reduce((a: number, b: number) => a + b, 0) / finishes.length
                : 0;
            const top5Count = finishes.filter((f: number) => f <= 5).length;
            const top5Rate = finishes.length > 0 ? top5Count / finishes.length : 0;

            return {
                discord_user_id: p.discord_user_id,
                iscored_username: p.iscored_username,
                // Selected by the query's user_profiles JOIN all along but
                // never mapped through — the compare picker (and any
                // display-name-aware consumer) needs it (S14 check-agent catch).
                display_name: p.display_name ?? null,
                // v2.141.1 — the Arcaid profile USERNAME, so the Stats search
                // can find "Buke" for the player whose room name is "Jrbuch".
                // Every other player surface knows both names; Stats didn't.
                username: p.username ?? null,
                games_played: p.games_played,
                wins: winMap.get(p.player_key) || 0,
                avg_finish_position: Math.round(avgFinish * 10) / 10,
                top5_rate: Math.round(top5Rate * 100) / 100,
                champion_streak: streakMap.get(p.player_key) || 0,
            };
        });

        // Sort by wins DESC
        results.sort((a: any, b: any) => b.wins - a.wins);
        return results;
    }

    /**
     * Get a specific player's stats for a specific game.
     */
    static async getPlayerGameStats(username: string, gameName: string, gameRoomId?: string) {
        const db = await getDatabase();

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // All submissions for this player + game
        const submissions = await db.all(`
            SELECT s.score, s.timestamp as date, g.id as game_id, g.end_date,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position,
                   (SELECT COUNT(*) FROM submissions s2 WHERE s2.game_id = s.game_id) as total_players
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            AND LOWER(g.name) = LOWER(?)
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, username, gameName, ...roomParams);

        if (submissions.length === 0) return null;

        const scores = submissions.map((s: any) => s.score);
        const positions = submissions.map((s: any) => s.finish_position);
        const timesPlayed = submissions.length;
        const bestScore = Math.max(...scores);
        const worstScore = Math.min(...scores);
        const avgRank = positions.reduce((a: number, b: number) => a + b, 0) / positions.length;
        const wins = positions.filter((p: number) => p === 1).length;

        // Score trend: chronological {date, score, rank}
        const trend = submissions.reverse().map((s: any) => ({
            date: s.date || s.end_date,
            score: s.score,
            rank: s.finish_position,
        }));

        return {
            times_played: timesPlayed,
            best_score: bestScore,
            worst_score: worstScore,
            avg_rank: Math.round(avgRank * 10) / 10,
            wins,
            trend,
        };
    }

    /**
     * Get all players with their basic stats (for leaderboard overview).
     */
    static async getAllPlayerStats(gameRoomId?: string) {
        const db = await getDatabase();

        if (gameRoomId) {
            return db.all(`
                SELECT
                    CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                         THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                         ELSE s.discord_user_id
                    END as discord_user_id,
                    COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                    up.display_name,
                    up.avatar_hash,
                    up.avatar_url,
                    COUNT(DISTINCT s.game_id) as games_played,
                    MAX(s.score) as best_score,
                    ROUND(AVG(s.score)) as avg_score
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                JOIN tournaments t ON g.tournament_id = t.id
                LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
                LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
                WHERE t.game_room_id = ?
                GROUP BY LOWER(s.iscored_username)
                ORDER BY best_score DESC
            `, gameRoomId);
        }

        return db.all(`
            SELECT
                CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                     THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                     ELSE s.discord_user_id
                END as discord_user_id,
                COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                up.display_name,
                up.avatar_hash,
                up.avatar_url,
                COUNT(DISTINCT s.game_id) as games_played,
                MAX(s.score) as best_score,
                ROUND(AVG(s.score)) as avg_score
            FROM submissions s
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
            GROUP BY LOWER(s.iscored_username)
            ORDER BY best_score DESC
        `);
    }

    /**
     * Per-game activity stats for the public Stats page (Games view).
     * Counts submissions from the tournament `submissions` table and
     * `community_scores`, excluding orphaned rows (Sprint 6).
     *
     * SQLite lacks FULL OUTER JOIN, so we UNION ALL per-row stats from both
     * sources and collapse in an outer GROUP BY. Note: COUNT(DISTINCT) across
     * both tables isn't expressible this way, so `players` is an upper bound
     * (a player who submitted tournament + community scores counts twice).
     * Acceptable for a Stats overview page.
     *
     * v2.9x — `filters` (see `StatsWindowFilters`). The two UNION branches
     * have different data shapes (`submissions` is tournament-scoped;
     * `community_scores` is pinned/freeplay, no tournament at all), so a
     * single filter can't apply identically to both:
     *   - `type` matches `tournaments.type`, which only the first branch has.
     *     When set, the `community_scores` branch is DROPPED entirely rather
     *     than silently ignoring the filter for rows it can't classify.
     *   - `from`/`to` (the `[from, to)` window) applies to both branches, but
     *     against different columns: `g.end_date` for tournament-sourced
     *     rows (matches `getEnhancedAllPlayerStats`), `cs.created_at` for
     *     community rows (the only timestamp a pinned score has).
     */
    static async getGameActivityStats(gameRoomId: string, filters?: StatsWindowFilters) {
        const db = await getDatabase();

        const tConds: string[] = ['t.game_room_id = ?', 's.orphaned_at IS NULL'];
        const tParams: any[] = [gameRoomId];
        if (filters?.type) { tConds.push('t.type = ?'); tParams.push(filters.type); }
        if (filters?.from) { tConds.push('g.end_date >= ?'); tParams.push(filters.from); }
        if (filters?.to) { tConds.push('g.end_date < ?'); tParams.push(filters.to); }

        const includeCommunity = !filters?.type;
        const cConds: string[] = ['cs.game_room_id = ?', 'cs.orphaned_at IS NULL'];
        const cParams: any[] = [gameRoomId];
        if (filters?.from) { cConds.push('cs.created_at >= ?'); cParams.push(filters.from); }
        if (filters?.to) { cConds.push('cs.created_at < ?'); cParams.push(filters.to); }

        const communityBranch = includeCommunity ? `

                UNION ALL

                SELECT
                    cs.game_name AS name,
                    LOWER(cs.game_name) AS name_key,
                    COUNT(*) AS submissions,
                    COUNT(DISTINCT LOWER(cs.iscored_username)) AS players,
                    MAX(cs.score) AS top_score,
                    MAX(cs.created_at) AS last_activity
                FROM community_scores cs
                WHERE ${cConds.join(' AND ')}
                GROUP BY LOWER(cs.game_name)` : '';

        return db.all(`
            SELECT
                name,
                SUM(submissions) AS submissions,
                SUM(players) AS players,
                MAX(top_score) AS top_score,
                MAX(last_activity) AS last_activity
            FROM (
                SELECT
                    g.name AS name,
                    LOWER(g.name) AS name_key,
                    COUNT(*) AS submissions,
                    COUNT(DISTINCT LOWER(s.iscored_username)) AS players,
                    MAX(s.score) AS top_score,
                    MAX(s.timestamp) AS last_activity
                FROM submissions s
                JOIN games g ON g.id = s.game_id
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE ${tConds.join(' AND ')}
                GROUP BY LOWER(g.name)${communityBranch}
            )
            GROUP BY name_key
            ORDER BY submissions DESC, last_activity DESC
        `, ...tParams, ...(includeCommunity ? cParams : []));
    }

    /**
     * v2.1.0 Stats overview — the 4 cards at the top of /:slug/stats.
     *
     * All "this week" metrics use a rolling 7-day window. Pulls from
     * `score_history` which carries every submission (tournament + community +
     * sync). Hottest game is by submission count; latest is by timestamp.
     */
    static async getRoomOverview(gameRoomId: string): Promise<{
        totalPlaysWeek: number;
        activePlayersWeek: number;
        hottestGame: { name: string; submissions: number } | null;
        latestSubmission: { iscored_username: string; display_name: string | null; score: number; game_name: string; created_at: string } | null;
    }> {
        const db = await getDatabase();
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const plays = await db.get<{ total: number }>(
            `SELECT COUNT(*) as total FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL`,
            gameRoomId, weekAgo,
        );
        const players = await db.get<{ total: number }>(
            `SELECT COUNT(DISTINCT LOWER(iscored_username)) as total FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL`,
            gameRoomId, weekAgo,
        );
        const hottest = await db.get<{ game_name: string; submissions: number }>(
            `SELECT game_name, COUNT(*) as submissions FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL
             GROUP BY LOWER(game_name)
             ORDER BY submissions DESC
             LIMIT 1`,
            gameRoomId, weekAgo,
        );
        // v2.8.2: pull display_name so the FE renders the user's chosen name.
        // submitted_by_user_id is the definitive Discord linkage; user_mappings
        // resolves iscored:* synthetic ids; user_profiles holds the chosen name.
        const latest = await db.get<{ iscored_username: string; display_name: string | null; score: number; game_name: string; created_at: string }>(
            `SELECT sh.iscored_username, sh.score, sh.game_name, sh.created_at, up.display_name
             FROM score_history sh
             LEFT JOIN user_mappings um ON (
                sh.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(sh.iscored_username)
             )
             LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(sh.submitted_by_user_id, um.discord_user_id)
             WHERE sh.game_room_id = ? AND sh.orphaned_at IS NULL
             ORDER BY sh.created_at DESC
             LIMIT 1`,
            gameRoomId,
        );

        return {
            totalPlaysWeek: plays?.total ?? 0,
            activePlayersWeek: players?.total ?? 0,
            hottestGame: hottest ? { name: hottest.game_name, submissions: hottest.submissions } : null,
            latestSubmission: latest
                ? { iscored_username: latest.iscored_username, display_name: latest.display_name ?? null, score: latest.score, game_name: latest.game_name, created_at: latest.created_at }
                : null,
        };
    }
}
