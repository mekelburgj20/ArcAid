import { getDatabase } from '../database/database.js';
import CronExpressionParser from 'cron-parser';
import { logError } from '../utils/logger.js';
import { normalizeImageUrl } from './LeaderboardService.js';

interface ActiveTournamentInfo {
    tournament_id: string;
    tournament_name: string;
    tournament_type: string;
    cadence: string;
    game_id: string | null;
    game_name: string | null;
    game_start_date: string | null;
    // v2.81.0 — small game-image icon for the Room Admin Dashboard "Active
    // Now" cards. Resolved the same way LeaderboardService.getActiveLeaderboards
    // resolves imageUrl: name-matched against global_games (approved only).
    game_image_url: string | null;
    leader_name: string | null;
    leader_score: number | null;
    participants: number;
    next_rotation_at: string | null;
}

interface RecentWinner {
    game_name: string;
    end_date: string;
    tournament_name: string;
    winner_name: string | null;
    winner_score: number | null;
}

interface DashboardData {
    activeTournaments: ActiveTournamentInfo[];
    recentWinners: RecentWinner[];
    systemHealth: {
        botOnline: boolean;
        setupComplete: boolean;
    };
    uniquePlayersAcrossTournaments: number;
}

export async function getDashboardData(gameRoomId?: string): Promise<DashboardData> {
    const db = await getDatabase();

    // Active tournaments with their current active game and leader
    const roomFilter = gameRoomId ? ' AND t.game_room_id = ?' : '';
    const roomParams = gameRoomId ? [gameRoomId] : [];

    const activeGames = await db.all(`
        SELECT
            t.id AS tournament_id,
            t.name AS tournament_name,
            t.type AS tournament_type,
            t.cadence,
            t.cleanup_rule,
            g.id AS game_id,
            g.name AS game_name,
            g.start_date AS game_start_date,
            COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) AS game_image_url
        FROM tournaments t
        LEFT JOIN games g ON g.tournament_id = t.id AND g.status = 'ACTIVE'
        LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
        WHERE t.is_active = 1${roomFilter}
        -- Same-name approved globals can coexist (different mfg/year/type —
        -- see idx_global_games_identity), so the gg name-match can multiply
        -- rows. Collapse back to one row per (tournament, active game) —
        -- the pre-join cardinality. Mirrors getActiveLeaderboards' GROUP BY.
        GROUP BY t.id, g.id
    `, ...roomParams);

    // For each active game, find the leader (top submission).
    // Also count unique participants across visible games per cleanup_rule.
    // Accumulate every visible game id so we can compute the cross-tournament
    // distinct-player count in a single query at the end.
    const activeTournaments: ActiveTournamentInfo[] = [];
    const allVisibleGameIds: string[] = [];
    const envTz = process.env.BOT_TIMEZONE || 'America/Chicago';

    for (const row of activeGames) {
        let leaderName: string | null = null;
        let leaderScore: number | null = null;

        if (row.game_id) {
            const topSubmission = await db.get(`
                SELECT iscored_username, score
                FROM submissions
                WHERE game_id = ?
                ORDER BY score DESC
                LIMIT 1
            `, row.game_id);

            if (topSubmission) {
                leaderName = topSubmission.iscored_username || null;
                leaderScore = topSubmission.score;
            }
        }

        // Determine which games are visible based on cleanup_rule
        let rule: { mode: string; count?: number } = { mode: 'retain', count: 0 };
        try { rule = JSON.parse(row.cleanup_rule || '{}'); } catch {}

        // Build list of visible game IDs: ACTIVE + retained COMPLETED
        const visibleGameIds: string[] = [];

        // All ACTIVE games
        const activeIds = await db.all(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`,
            row.tournament_id
        );
        visibleGameIds.push(...activeIds.map((r: any) => r.id));

        // COMPLETED games per cleanup_rule
        if (rule.mode === 'retain' && (rule.count || 0) > 0) {
            const retained = await db.all(
                `SELECT id FROM games WHERE tournament_id = ? AND status = 'COMPLETED' ORDER BY end_date DESC LIMIT ?`,
                row.tournament_id, rule.count
            );
            visibleGameIds.push(...retained.map((r: any) => r.id));
        } else if (rule.mode === 'scheduled') {
            const completed = await db.all(
                `SELECT id FROM games WHERE tournament_id = ? AND status = 'COMPLETED'`,
                row.tournament_id
            );
            visibleGameIds.push(...completed.map((r: any) => r.id));
        }
        // immediate or retain(0): no completed games

        let participants = 0;
        if (visibleGameIds.length > 0) {
            const placeholders = visibleGameIds.map(() => '?').join(',');
            const participantRow = await db.get(`
                SELECT COUNT(DISTINCT LOWER(s.iscored_username)) as count
                FROM submissions s
                WHERE s.game_id IN (${placeholders})
            `, ...visibleGameIds);
            participants = participantRow?.count || 0;
        }
        allVisibleGameIds.push(...visibleGameIds);

        // Resolve next rotation time per tournament. Each tournament owns its
        // timezone via cadence.timezone; the env fallback only kicks in for
        // legacy rows without one.
        let nextRotationAt: string | null = null;
        try {
            if (row.cadence) {
                const cadenceObj = JSON.parse(row.cadence);
                if (cadenceObj.cron) {
                    const tz = cadenceObj.timezone || envTz;
                    const expr = CronExpressionParser.parse(cadenceObj.cron, { tz });
                    nextRotationAt = expr.next().toISOString();
                }
            }
        } catch (e) {
            logError(`Failed to parse cron for tournament ${row.tournament_name}:`, e);
        }

        activeTournaments.push({
            tournament_id: row.tournament_id,
            tournament_name: row.tournament_name,
            tournament_type: row.tournament_type,
            cadence: row.cadence,
            game_id: row.game_id || null,
            game_name: row.game_name || null,
            game_start_date: row.game_start_date || null,
            game_image_url: normalizeImageUrl(row.game_image_url),
            leader_name: leaderName,
            leader_score: leaderScore,
            participants,
            next_rotation_at: nextRotationAt,
        });
    }

    // Single pass for the cross-tournament distinct-player count. Sum-of-
    // per-tournament participants double-counts players active in multiple
    // tournaments, so we re-run COUNT(DISTINCT) over the union of visible
    // game ids.
    let uniquePlayersAcrossTournaments = 0;
    if (allVisibleGameIds.length > 0) {
        const placeholders = allVisibleGameIds.map(() => '?').join(',');
        const row = await db.get(`
            SELECT COUNT(DISTINCT LOWER(s.iscored_username)) AS count
            FROM submissions s
            WHERE s.game_id IN (${placeholders})
        `, ...allVisibleGameIds);
        uniquePlayersAcrossTournaments = row?.count || 0;
    }

    // Recent winners — last 10 completed games
    const recentWinnersQuery = gameRoomId
        ? `SELECT
                g.name AS game_name,
                g.end_date,
                t.name AS tournament_name,
                s.iscored_username AS winner_name,
                s.score AS winner_score
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN (
                SELECT game_id, iscored_username, score,
                       ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                FROM submissions
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE g.status = 'COMPLETED' AND t.game_room_id = ?
            ORDER BY g.end_date DESC
            LIMIT 10`
        : `SELECT
                g.name AS game_name,
                g.end_date,
                t.name AS tournament_name,
                s.iscored_username AS winner_name,
                s.score AS winner_score
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN (
                SELECT game_id, iscored_username, score,
                       ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                FROM submissions
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE g.status = 'COMPLETED'
            ORDER BY g.end_date DESC
            LIMIT 10`;

    const recentWinners: RecentWinner[] = gameRoomId
        ? await db.all(recentWinnersQuery, gameRoomId)
        : await db.all(recentWinnersQuery);

    // System health
    const setupRow = await db.get("SELECT value FROM settings WHERE key = 'SETUP_COMPLETE'");
    const setupComplete = setupRow?.value === 'true';
    const botOnline = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);

    return {
        activeTournaments,
        recentWinners,
        systemHealth: { botOnline, setupComplete },
        uniquePlayersAcrossTournaments,
    };
}
