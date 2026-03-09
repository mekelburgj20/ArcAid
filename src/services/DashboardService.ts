import { getDatabase } from '../database/database.js';
import CronExpressionParser from 'cron-parser';
import { logError } from '../utils/logger.js';

interface ActiveTournamentInfo {
    tournament_id: string;
    tournament_name: string;
    tournament_type: string;
    cadence: string;
    game_id: string | null;
    game_name: string | null;
    game_start_date: string | null;
    leader_name: string | null;
    leader_score: number | null;
}

interface RecentWinner {
    game_name: string;
    end_date: string;
    tournament_name: string;
    winner_name: string | null;
    winner_score: number | null;
}

interface NextRotation {
    tournament_id: string;
    tournament_name: string;
    next_fire_time: string | null;
}

interface DashboardData {
    activeTournaments: ActiveTournamentInfo[];
    recentWinners: RecentWinner[];
    systemHealth: {
        botOnline: boolean;
        setupComplete: boolean;
    };
    nextRotations: NextRotation[];
}

export async function getDashboardData(): Promise<DashboardData> {
    const db = await getDatabase();

    // Active tournaments with their current active game and leader
    const activeGames = await db.all(`
        SELECT
            t.id AS tournament_id,
            t.name AS tournament_name,
            t.type AS tournament_type,
            t.cadence,
            g.id AS game_id,
            g.name AS game_name,
            g.start_date AS game_start_date
        FROM tournaments t
        LEFT JOIN games g ON g.tournament_id = t.id AND g.status = 'ACTIVE'
        WHERE t.is_active = 1
    `);

    // For each active game, find the leader (top submission)
    const activeTournaments: ActiveTournamentInfo[] = [];
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

        activeTournaments.push({
            tournament_id: row.tournament_id,
            tournament_name: row.tournament_name,
            tournament_type: row.tournament_type,
            cadence: row.cadence,
            game_id: row.game_id || null,
            game_name: row.game_name || null,
            game_start_date: row.game_start_date || null,
            leader_name: leaderName,
            leader_score: leaderScore,
        });
    }

    // Recent winners — last 10 completed games
    const recentWinners: RecentWinner[] = await db.all(`
        SELECT
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
        LIMIT 10
    `);

    // System health
    const setupRow = await db.get("SELECT value FROM settings WHERE key = 'SETUP_COMPLETE'");
    const setupComplete = setupRow?.value === 'true';
    const botOnline = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);

    // Next rotation times
    const nextRotations: NextRotation[] = [];
    const tz = process.env.BOT_TIMEZONE || 'America/Chicago';

    for (const t of activeTournaments) {
        let nextFireTime: string | null = null;
        try {
            if (t.cadence) {
                const cadenceObj = JSON.parse(t.cadence);
                if (cadenceObj.cron) {
                    const expr = CronExpressionParser.parse(cadenceObj.cron, { tz });
                    nextFireTime = expr.next().toISOString();
                }
            }
        } catch (e) {
            logError(`Failed to parse cron for tournament ${t.tournament_name}:`, e);
        }

        nextRotations.push({
            tournament_id: t.tournament_id,
            tournament_name: t.tournament_name,
            next_fire_time: nextFireTime,
        });
    }

    return {
        activeTournaments,
        recentWinners,
        systemHealth: { botOnline, setupComplete },
        nextRotations,
    };
}
