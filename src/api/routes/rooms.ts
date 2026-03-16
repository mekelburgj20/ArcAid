import { Router } from 'express';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError, logWarn } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess } from '../middleware.js';
import { validate } from '../validate.js';
import {
    CreateTournamentSchema, UpdateTournamentSchema,
    ImportGamesSchema, UpdateGameSchema, SettingsSchema,
    HistoryQuerySchema, MergePlayerSchema,
    CreateRankingGroupSchema, UpdateRankingGroupSchema,
    CreateLocalAdminSchema,
} from '../schemas.js';
import { TournamentService } from '../../services/TournamentService.js';
import { GameLibraryService } from '../../services/GameLibraryService.js';
import { GameRoomSettingsService } from '../../services/GameRoomSettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { getDashboardData } from '../../services/DashboardService.js';
import { RatingService } from '../../services/RatingService.js';

const router = Router({ mergeParams: true });

// --- Public endpoints (no auth) ---

// Portal info
router.get('/:roomId/portal', async (req, res) => {
    try {
        const db = await getDatabase();
        const room = await GameRoomService.getById(req.params.roomId as string);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        const uiTheme = await GameRoomSettingsService.get(room.id, 'UI_THEME');
        res.json({
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'arcade',
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Leaderboard
router.get('/:roomId/leaderboard', async (req, res) => {
    try {
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const leaderboards = await LeaderboardService.getActiveLeaderboards(req.params.roomId as string);
        res.json(leaderboards);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/leaderboard/:gameId', async (req, res) => {
    try {
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const gameId = req.params.gameId as string;
        const rankings = await LeaderboardService.getForGame(gameId);

        const db = await getDatabase();
        const game = await db.get(`
            SELECT g.name as game_name, t.name as tournament_name, gl.image_url
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
            WHERE g.id = ?
        `, gameId);

        res.json({
            gameId,
            gameName: game?.game_name || 'Unknown',
            tournamentName: game?.tournament_name || 'Untracked',
            imageUrl: game?.image_url || null,
            rankings,
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/leaderboard/:gameId/submissions', async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const db = await getDatabase();
        const submissions = await db.all(`
            SELECT iscored_username, score, timestamp, photo_url
            FROM submissions
            WHERE game_id = ?
            ORDER BY LOWER(iscored_username), score DESC
        `, gameId);
        res.json(submissions);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/leaderboard/:gameId/submissions):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Rankings
router.get('/:roomId/rankings', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const data = await RankingService.getActiveWithRankings(req.params.roomId as string);
        res.json(data);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/rankings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const groups = await RankingService.getAll(req.params.roomId as string);
        res.json(groups);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups/:id', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const group = await RankingService.getById(req.params.id as string);
        if (!group) return res.status(404).json({ error: 'Ranking group not found' });
        res.json(group);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ranking-groups/:id/rankings', async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        const group = await RankingService.getById(req.params.id as string);
        if (!group) return res.status(404).json({ error: 'Ranking group not found' });
        const rankings = await RankingService.getRankings(req.params.id as string);
        res.json({ group, rankings });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ranking-groups/:id/rankings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game availability — public, shows cooldown status per tournament
router.get('/:roomId/game-availability/:tournamentId', async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const tournamentId = req.params.tournamentId as string;

        // Verify tournament belongs to this room
        const tournament = await db.get(
            'SELECT id, name, type, mode, platform_rules FROM tournaments WHERE id = ? AND game_room_id = ?',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Get eligibility window
        const roomSetting = await db.get(
            "SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'GAME_ELIGIBILITY_DAYS'",
            roomId
        );
        const globalSetting = await db.get("SELECT value FROM settings WHERE key = 'GAME_ELIGIBILITY_DAYS'");
        const eligibilityDays = parseInt(roomSetting?.value ?? globalSetting?.value ?? '120', 10);

        const lookbackDate = new Date();
        lookbackDate.setDate(lookbackDate.getDate() - eligibilityDays);
        const lookbackString = lookbackDate.toISOString();

        // Get all games in this room's curated library, filtered by tournament platform rules
        let platformFilter = '';
        const platformParams: string[] = [];
        try {
            const rules = JSON.parse(tournament.platform_rules || '{}');
            const required: string[] = rules.required || [];
            const excluded: string[] = rules.excluded || [];
            if (required.length > 0) {
                // Game must be available on at least one required platform
                platformFilter += ` AND (${required.map(() => `gl.platforms LIKE ?`).join(' OR ')})`;
                for (const p of required) {
                    platformParams.push(`%${p}%`);
                }
            }
            if (excluded.length > 0) {
                // Game must NOT be available on any excluded platform
                for (const p of excluded) {
                    platformFilter += ` AND gl.platforms NOT LIKE ?`;
                    platformParams.push(`%${p}%`);
                }
            }
        } catch { /* no platform filtering */ }

        const libraryGames = await db.all(`
            SELECT gl.name
            FROM game_library gl
            JOIN game_room_game_library grgl ON grgl.game_name = gl.name AND grgl.game_room_id = ?
            WHERE 1=1${platformFilter}
            ORDER BY gl.name
        `, roomId, ...platformParams);

        // Get recently played games in this tournament within the lookback window
        const recentGames = await db.all(`
            SELECT g.name, g.start_date, g.end_date, g.status,
                   (SELECT s.iscored_username FROM submissions s WHERE s.game_id = g.id ORDER BY s.score DESC LIMIT 1) as winner_name,
                   (SELECT s.score FROM submissions s WHERE s.game_id = g.id ORDER BY s.score DESC LIMIT 1) as winner_score
            FROM games g
            WHERE g.tournament_id = ?
              AND g.start_date >= ?
              AND g.status != 'QUEUED'
            ORDER BY g.start_date DESC
        `, tournamentId, lookbackString);

        // Build a map of game name → most recent play info (case-insensitive, also match variants)
        const recentMap = new Map<string, { playedDate: string; endDate: string | null; status: string; winnerName: string | null; winnerScore: number | null }>();
        for (const g of recentGames) {
            // Use base name (strip variant suffix for matching)
            const baseName = g.name.split(' ').length > 1
                ? g.name // keep full name for map
                : g.name;
            const key = baseName.toLowerCase();
            if (!recentMap.has(key)) {
                recentMap.set(key, {
                    playedDate: g.start_date,
                    endDate: g.end_date,
                    status: g.status,
                    winnerName: g.winner_name,
                    winnerScore: g.winner_score,
                });
            }
        }

        // Build availability list
        const now = new Date();
        const availability = libraryGames.map((lg: any) => {
            const key = lg.name.toLowerCase();
            // Check exact match and variant match (name + ' ...')
            const recent = recentMap.get(key) ||
                [...recentMap.entries()].find(([k]) => k.startsWith(key + ' ') || key.startsWith(k + ' '))?.[1];

            if (recent) {
                const playedDate = new Date(recent.playedDate);
                const availableDate = new Date(playedDate);
                availableDate.setDate(availableDate.getDate() + eligibilityDays);
                const daysUntilAvailable = Math.max(0, Math.ceil((availableDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

                return {
                    name: lg.name,
                    available: daysUntilAvailable <= 0,
                    daysUntilAvailable,
                    lastPlayedDate: recent.playedDate,
                    lastEndDate: recent.endDate,
                    lastStatus: recent.status,
                    winnerName: recent.winnerName,
                    winnerScore: recent.winnerScore,
                };
            }

            return {
                name: lg.name,
                available: true,
                daysUntilAvailable: 0,
                lastPlayedDate: null,
                lastEndDate: null,
                lastStatus: null,
                winnerName: null,
                winnerScore: null,
            };
        });

        res.json({
            tournament: { id: tournament.id, name: tournament.name, type: tournament.type, mode: tournament.mode },
            eligibilityDays,
            games: availability,
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game-availability/:tournamentId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Stats
router.get('/:roomId/stats/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const players = await StatsService.getAllPlayerStats(req.params.roomId as string);
        res.json(players);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const isDiscordId = /^\d{17,20}$/.test(identifier);
        const stats = isDiscordId
            ? await StatsService.getPlayerStats(identifier, roomId)
            : await StatsService.getPlayerStatsByUsername(identifier, roomId);
        if (!stats) return res.status(404).json({ error: 'Player not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/game/:name', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const stats = await StatsService.getGameStats(
            decodeURIComponent(req.params.name as string),
            req.params.roomId as string
        );
        if (!stats) return res.status(404).json({ error: 'Game not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game library (room-scoped view)
router.get('/:roomId/game_library', async (req, res) => {
    try {
        const rows = await GameLibraryService.getForRoom(req.params.roomId as string);
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ratings
router.get('/:roomId/ratings', async (req, res) => {
    try {
        const ratings = await RatingService.getAllRatings();
        const userId = (req.headers['x-user-id'] as string) || '';
        const userRatings = userId ? await RatingService.getUserRatings(userId) : {};
        res.json({ ratings, userRatings });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ratings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/ratings/:gameName', async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.gameName as string);
        const userId = (req.headers['x-user-id'] as string) || '';
        const info = await RatingService.getGameRating(gameName, userId || undefined);
        res.json(info);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/ratings/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/ratings/:gameName', async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.gameName as string);
        const userId = (req.headers['x-user-id'] as string) || '';
        const rating = Number(req.body?.rating);
        if (!userId) return res.status(400).json({ error: 'x-user-id header required' });
        if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });
        await RatingService.setRating(gameName, userId, rating);
        const info = await RatingService.getGameRating(gameName, userId);
        res.json(info);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ratings/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Dashboard
router.get('/:roomId/dashboard', async (req, res) => {
    try {
        const data = await getDashboardData(req.params.roomId as string);
        res.json(data);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/dashboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// History
router.get('/:roomId/history', async (req, res) => {
    try {
        const validationResult = validate(HistoryQuerySchema, req.query);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { page, limit, tournament_id, type } = validationResult.data;
        const offset = (page - 1) * limit;
        const db = await getDatabase();

        const conditions: string[] = ["g.status = 'COMPLETED'"];
        const params: unknown[] = [];

        // Room filter via tournament
        conditions.push('t.game_room_id = ?');
        params.push(req.params.roomId as string);

        if (tournament_id) {
            conditions.push('g.tournament_id = ?');
            params.push(tournament_id);
        }
        if (type) {
            conditions.push('t.type = ?');
            params.push(type);
        }

        const whereClause = conditions.join(' AND ');

        const countRow = await db.get(
            `SELECT COUNT(*) as total FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE ${whereClause}`,
            ...params
        );
        const total = countRow?.total ?? 0;

        const results = await db.all(
            `SELECT
                g.name AS game_name,
                t.name AS tournament_name,
                t.type AS tournament_type,
                g.start_date,
                g.end_date,
                s.iscored_username AS winner_name,
                s.score AS winner_score
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN (
                SELECT game_id, iscored_username, score,
                       ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                FROM submissions
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE ${whereClause}
            ORDER BY g.end_date DESC
            LIMIT ? OFFSET ?`,
            ...params, limit, offset
        );

        res.json({ results, total, page, limit });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/history):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Auth + room access endpoints ---

// Settings (room-scoped)
router.get('/:roomId/settings', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const settings = await GameRoomSettingsService.getAll(req.params.roomId as string);
        res.json(settings);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/settings', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(SettingsSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        await GameRoomSettingsService.saveMany(req.params.roomId as string, validationResult.data);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/settings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tournaments
router.get('/:roomId/tournaments', async (req, res) => {
    try {
        const rows = await TournamentService.getAll(req.params.roomId as string);
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/tournaments', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CreateTournamentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await TournamentService.create(data);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/tournaments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:roomId/tournaments/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(UpdateTournamentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await TournamentService.update(req.params.id as string, data);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/tournaments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/tournaments/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        await TournamentService.delete(req.params.id as string);
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/tournaments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Tournament game activation
router.post('/:roomId/tournaments/:id/activate-game', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const tournamentId = req.params.id as string;
        const { gameName } = req.body;
        if (!gameName || typeof gameName !== 'string') {
            return res.status(400).json({ error: 'gameName is required' });
        }

        const db = await getDatabase();
        const tournament = await db.get('SELECT id, type, mode FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();

        const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
        const styleId = gameLibEntry?.style_id || undefined;

        let iscoredId: string | undefined;
        const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
        if (hasCredentials) {
            const { IScoredClient } = await import('../../engine/IScoredClient.js');
            const client = new IScoredClient();
            try {
                await client.connect();
                iscoredId = await client.createGame(gameName, styleId);
                await client.setGameTags(iscoredId, tournament.type);
                await client.setGameStatus(iscoredId, { locked: false, hidden: false });
            } finally {
                await client.disconnect();
            }
        }

        await db.exec('BEGIN TRANSACTION');
        try {
            const game = await engine.activateGame(tournamentId, gameName, styleId, iscoredId, false);
            await db.exec('COMMIT');
            logInfo(`Admin activated game: ${gameName} for tournament ${tournamentId}`);
            res.json({ success: true, gameId: game.id });

            engine.reorderIScoredLineup().catch(err =>
                logWarn('Failed to reorder iScored lineup after activation:', err)
            );
        } catch (dbError) {
            await db.exec('ROLLBACK');
            throw dbError;
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logError('API Error (POST rooms/:roomId/tournaments/:id/activate-game):', error);
        res.status(500).json({ error: message });
    }
});

// Game deactivation
router.post('/:roomId/games/:id/deactivate', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.id as string;
        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        const dbOnly = req.body?.dbOnly === true;
        const result = await engine.deactivateGame(gameId, dbOnly);
        res.json({ success: true, ...result });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logError('API Error (POST rooms/:roomId/games/:id/deactivate):', error);
        res.status(400).json({ error: message });
    }
});

// Active games list
router.get('/:roomId/games/active', async (req, res) => {
    try {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT g.id, g.name, g.tournament_id, g.iscored_id, g.start_date, t.name as tournament_name
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.status = 'ACTIVE' AND t.game_room_id = ?
             ORDER BY g.start_date DESC`,
            req.params.roomId as string
        );
        res.json(rows);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/active):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game library import (room-scoped)
router.post('/:roomId/game_library/import', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(ImportGamesSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const imported = await GameLibraryService.importGames(validationResult.data.games);
        // Also add to room
        const gameNames = validationResult.data.games.map((g: any) => g.name);
        await GameLibraryService.addToRoom(req.params.roomId as string, gameNames);
        res.json({ success: true, imported });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/import):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:roomId/game_library/:name', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const originalName = decodeURIComponent(req.params.name as string);
        const validationResult = validate(UpdateGameSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const updated = await GameLibraryService.updateGame(originalName, validationResult.data);
        if (!updated) return res.status(404).json({ error: 'Game not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/game_library/:name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/game_library/delete', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { names } = req.body;
        if (!Array.isArray(names) || names.length === 0) {
            return res.status(400).json({ error: 'names array is required' });
        }
        // Remove from room association
        await GameLibraryService.removeFromRoom(req.params.roomId as string, names);
        const deleted = await GameLibraryService.deleteGames(names);
        logInfo(`Deleted ${deleted} games from library: ${names.join(', ')}`);
        res.json({ success: true, deleted });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/game_library/delete):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Ranking groups (write operations)
router.post('/:roomId/ranking-groups', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CreateRankingGroupSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { RankingService } = await import('../../services/RankingService.js');
        const data = { ...validationResult.data, game_room_id: req.params.roomId as string };
        await RankingService.create(data);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ranking-groups):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.put('/:roomId/ranking-groups/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(UpdateRankingGroupSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.update(req.params.id as string, validationResult.data);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/ranking-groups/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.delete(req.params.id as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/ranking-groups/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/ranking-groups/:id/recompute', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.invalidate(req.params.id as string);
        const rankings = await RankingService.computeRankings(req.params.id as string);
        res.json({ success: true, count: rankings.length });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/ranking-groups/:id/recompute):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Merge player
router.post('/:roomId/admin/merge-player', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(MergePlayerSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { fromUsername, toUsername } = validationResult.data;
        if (fromUsername.toLowerCase() === toUsername.toLowerCase()) {
            return res.status(400).json({ error: 'Source and target usernames are the same' });
        }

        const db = await getDatabase();

        const syncRows = await db.all(
            `SELECT id, game_id FROM submissions WHERE LOWER(iscored_username) = LOWER(?) AND id LIKE '%' || '-' || ?`,
            fromUsername, fromUsername.toLowerCase()
        );
        for (const row of syncRows) {
            const newId = `${row.game_id}-${toUsername.toLowerCase()}`;
            const existing = await db.get('SELECT id FROM submissions WHERE id = ?', newId);
            if (existing) {
                await db.run('DELETE FROM submissions WHERE id = ?', row.id);
            } else {
                await db.run('UPDATE submissions SET id = ? WHERE id = ?', newId, row.id);
            }
        }

        const subResult = await db.run(
            'UPDATE submissions SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );

        const scoreResult = await db.run(
            'UPDATE scores SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );

        await db.run(
            'UPDATE user_mappings SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidateAll();
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.invalidateAll();

        const totalUpdated = (subResult.changes || 0) + (scoreResult.changes || 0);
        logInfo(`Merged player '${fromUsername}' -> '${toUsername}': ${totalUpdated} records updated`);

        res.json({
            success: true,
            submissionsUpdated: subResult.changes || 0,
            scoresUpdated: scoreResult.changes || 0,
        });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/merge-player):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scheduler reload
router.post('/:roomId/scheduler/reload', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { Scheduler } = await import('../../engine/Scheduler.js');
        await Scheduler.getInstance().reload();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/scheduler/reload):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reorder iScored lineup
router.post('/:roomId/tournaments/reorder-lineup', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();
        await engine.reorderIScoredLineup();
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/tournaments/reorder-lineup):', error);
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        res.status(500).json({ error: message });
    }
});

// --- Admin management endpoints ---

// List room admins
router.get('/:roomId/admins', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const localAdmins = await AdminService.getLocalAdmins(roomId);
        const discordAdmins = await AdminService.getRoomDiscordAdmins(roomId);
        res.json({ localAdmins, discordAdmins });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admins):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create local admin
router.post('/:roomId/admins/local', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CreateLocalAdminSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { username, password, display_name } = validationResult.data;
        const roomId = req.params.roomId as string;

        const existing = await AdminService.getLocalAdminByUsername(roomId, username);
        if (existing) return res.status(409).json({ error: 'Username already exists for this room' });

        const admin = await AdminService.createLocalAdmin(roomId, username, password, display_name);
        res.json({ success: true, admin });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/local):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete local admin
router.delete('/:roomId/admins/local/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const admin = await AdminService.getLocalAdminById(req.params.id as string);
        if (!admin || admin.game_room_id !== (req.params.roomId as string)) {
            return res.status(404).json({ error: 'Local admin not found in this room' });
        }
        await AdminService.deleteLocalAdmin(req.params.id as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/local/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reset local admin password
router.post('/:roomId/admins/local/:id/reset-password', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { newPassword } = req.body;
        if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }
        const admin = await AdminService.getLocalAdminById(req.params.id as string);
        if (!admin || admin.game_room_id !== (req.params.roomId as string)) {
            return res.status(404).json({ error: 'Local admin not found in this room' });
        }
        await AdminService.resetLocalAdminPassword(req.params.id as string, newPassword);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/local/:id/reset-password):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Add Discord admin to room
router.post('/:roomId/admins/discord', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { discord_user_id, role } = req.body;
        if (!discord_user_id) return res.status(400).json({ error: 'discord_user_id required' });
        await AdminService.addRoomDiscordAdmin(req.params.roomId as string, discord_user_id, role || 'admin');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/discord):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove Discord admin from room
router.delete('/:roomId/admins/discord/:discordId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const deleted = await AdminService.removeRoomDiscordAdmin(
            req.params.roomId as string, req.params.discordId as string
        );
        if (!deleted) return res.status(404).json({ error: 'Discord admin not found in this room' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/discord/:discordId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
