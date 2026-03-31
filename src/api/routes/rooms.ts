import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError, logWarn } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess, requireDiscordUser } from '../middleware.js';
import { validate } from '../validate.js';
import {
    CreateTournamentSchema, UpdateTournamentSchema,
    ImportGamesSchema, UpdateGameSchema, SettingsSchema,
    HistoryQuerySchema, MergePlayerSchema,
    CreateRankingGroupSchema, UpdateRankingGroupSchema,
    CreateLocalAdminSchema,
    AssignStyleSchema,
    CommunityScoreSchema,
    ScoreSubmissionSchema,
    GameCommentSchema,
    PickGameSchema,
    ReorderQueueSchema,
    UpdateGameStateSchema,
    DeleteGameStateSchema,
    SyncIScoredActionSchema,
} from '../schemas.js';
import { writeLimiter, pickLimiter } from '../rateLimit.js';
import { TournamentEngine } from '../../engine/TournamentEngine.js';
import { IScoredClient } from '../../engine/IScoredClient.js';
import { passesplatformRules } from '../../utils/platformRules.js';
import { TournamentService } from '../../services/TournamentService.js';
import { GameLibraryService } from '../../services/GameLibraryService.js';
import { GameRoomSettingsService } from '../../services/GameRoomSettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { AdminService } from '../../services/AdminService.js';
import { getDashboardData } from '../../services/DashboardService.js';
import { RatingService } from '../../services/RatingService.js';

const router = Router({ mergeParams: true });

const roomAssetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (_req, file, cb) => {
        if (['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, JPEG, and WebP images are allowed'));
        }
    },
});

// --- Public endpoints (no auth) ---

// Portal info
router.get('/:roomId/portal', async (req, res) => {
    try {
        const db = await getDatabase();
        const room = await GameRoomService.getById(req.params.roomId as string);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        const uiTheme = await GameRoomSettingsService.get(room.id, 'UI_THEME');
        const adminTheme = await GameRoomSettingsService.get(room.id, 'ADMIN_THEME');
        res.json({
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            admin_theme: adminTheme || 'dark',
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scoreboard config (public — returns SCOREBOARD_*, LOGO_*, KIOSK_*, and GLOBAL_CARD_* settings)
router.get('/:roomId/scoreboard-config', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const allSettings = await GameRoomSettingsService.getAll(roomId);
        const config: Record<string, string> = {};
        for (const [key, value] of Object.entries(allSettings)) {
            if (key.startsWith('SCOREBOARD_') || key.startsWith('LOGO_') || key.startsWith('KIOSK_') || key.startsWith('GLOBAL_CARD_')) {
                config[key] = value;
            }
        }
        res.json(config);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/scoreboard-config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game info by ID (public — used by QR code score submission page)
router.get('/:roomId/games/:gameId/info', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();
        const game = await db.get(`
            SELECT g.id, g.name, g.status
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        const requirePhoto = await GameRoomSettingsService.get(roomId, 'REQUIRE_SCORE_PHOTO');
        res.json({ id: game.id, name: game.name, status: game.status, requirePhoto: requirePhoto === 'true' });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameId/info):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Leaderboard
router.get('/:roomId/leaderboard', async (req, res) => {
    try {
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const leaderboards = await LeaderboardService.getActiveLeaderboards(req.params.roomId as string);

        // Optionally identify viewer from player token for rank highlighting
        let viewerUsername: string | null = null;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) {
                    const db = await getDatabase();
                    const mapping = await db.get<{ iscored_username: string }>(
                        'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                        payload.discordId
                    );
                    if (mapping) {
                        viewerUsername = mapping.iscored_username;
                    } else if (payload.username) {
                        viewerUsername = payload.username;
                    }
                }
            } catch {
                // Invalid token — ignore, viewer is anonymous
            }
        }

        if (viewerUsername) {
            const lowerViewer = viewerUsername.toLowerCase();
            const annotated = leaderboards.map((lb: any) => {
                const viewerEntry = lb.rankings.find(
                    (r: any) => r.iscored_username.toLowerCase() === lowerViewer
                ) || null;
                return { ...lb, viewerEntry };
            });
            return res.json(annotated);
        }

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
            SELECT id, iscored_username, score, timestamp, photo_url
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

        // Get all-time high scores per game name (across all tournaments in this room)
        const allTimeHighs = await db.all(`
            SELECT LOWER(g.name) as game_key, s.score as high_score, s.iscored_username as high_score_player
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            WHERE g.tournament_id IN (SELECT id FROM tournaments WHERE game_room_id = ?)
              AND s.score = (
                SELECT MAX(s2.score) FROM submissions s2
                JOIN games g2 ON g2.id = s2.game_id
                WHERE LOWER(g2.name) = LOWER(g.name)
                  AND g2.tournament_id IN (SELECT id FROM tournaments WHERE game_room_id = ?)
              )
            GROUP BY LOWER(g.name)
        `, roomId, roomId);

        const highScoreMap = new Map<string, { score: number; player: string }>();
        for (const row of allTimeHighs) {
            highScoreMap.set(row.game_key, { score: row.high_score, player: row.high_score_player });
        }

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

            const highScore = highScoreMap.get(key) ||
                [...highScoreMap.entries()].find(([k]) => k.startsWith(key + ' ') || key.startsWith(k + ' '))?.[1];

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
                    allTimeHigh: highScore?.score ?? null,
                    allTimeHighPlayer: highScore?.player ?? null,
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
                allTimeHigh: highScore?.score ?? null,
                allTimeHighPlayer: highScore?.player ?? null,
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

// Pick status — returns pending picks and queued games for the logged-in Discord user
router.get('/:roomId/pick-status', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;

        // Unfulfilled win picks (placeholder name)
        const pendingPicks = await db.all(`
            SELECT g.tournament_id, t.name as tournament_name, g.picker_type, g.picker_designated_at
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE t.game_room_id = ? AND g.status = 'QUEUED'
              AND g.name = '[Pending Pick]' AND g.picker_discord_id = ?
        `, roomId, discordId);

        // Named queued games picked by this user
        const queuedGames = await db.all(`
            SELECT g.id, g.name as game_name, g.tournament_id, t.name as tournament_name, g.queue_order
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE t.game_room_id = ? AND g.status = 'QUEUED'
              AND g.name != '[Pending Pick]' AND g.picker_discord_id = ?
            ORDER BY g.queue_order ASC, g.rowid ASC
        `, roomId, discordId);

        // Also get tournaments for this room so the UI knows what's available
        const tournaments = await db.all(
            'SELECT id, name, type, mode, max_active_games, platform_rules FROM tournaments WHERE game_room_id = ? AND is_active = 1 ORDER BY display_order',
            roomId
        );

        res.json({ pendingPicks, queuedGames, tournaments });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/pick-status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Pick/queue a game — requires Discord login
router.post('/:roomId/pick-game', pickLimiter, requireDiscordUser, async (req, res) => {
    try {
        const validationResult = validate(PickGameSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;
        const { tournamentId, gameName } = validationResult.data;

        // 1. Verify tournament belongs to this room and is active
        const tournament = await db.get(
            'SELECT id, name, type, mode, max_active_games, platform_rules, game_room_id FROM tournaments WHERE id = ? AND game_room_id = ? AND is_active = 1',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found or inactive' });

        // 2. Look up game in library
        const gameLibEntry = await db.get(
            'SELECT name, mode, platforms, style_id FROM game_library WHERE name = ? COLLATE NOCASE',
            gameName
        );
        if (!gameLibEntry) return res.status(404).json({ error: `Game "${gameName}" not found in the library` });

        // 3. Check mode match
        if (gameLibEntry.mode !== tournament.mode) {
            return res.status(400).json({ error: `Game mode "${gameLibEntry.mode}" does not match tournament mode "${tournament.mode}"` });
        }

        // 4. Check platform rules
        let platformRules = { required: [] as string[], excluded: [] as string[] };
        try { platformRules = { ...platformRules, ...JSON.parse(tournament.platform_rules || '{}') }; } catch {}

        let gamePlatforms: string[] = [];
        try { gamePlatforms = JSON.parse(gameLibEntry.platforms || '[]'); } catch {}

        if (!passesplatformRules(gamePlatforms, platformRules)) {
            const restrictedText = (JSON.parse(tournament.platform_rules || '{}') as any).restrictedText;
            return res.status(400).json({
                error: restrictedText || 'This game is not available for this tournament type (platform restriction)',
            });
        }

        // 5. Check cooldown (eligibility)
        const engine = TournamentEngine.getInstance();
        const isEligible = await engine.isGameEligible(tournamentId, gameLibEntry.name);
        if (!isEligible) {
            // Calculate remaining cooldown days for the error message
            const roomSetting = await db.get(
                "SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'GAME_ELIGIBILITY_DAYS'",
                roomId
            );
            const globalSetting = await db.get("SELECT value FROM settings WHERE key = 'GAME_ELIGIBILITY_DAYS'");
            const eligibilityDays = parseInt(roomSetting?.value ?? globalSetting?.value ?? '120', 10);

            const lastPlayed = await db.get(
                `SELECT start_date FROM games WHERE tournament_id = ? AND name = ? COLLATE NOCASE AND status != 'QUEUED' ORDER BY start_date DESC LIMIT 1`,
                tournamentId, gameLibEntry.name
            );
            let daysRemaining = eligibilityDays;
            if (lastPlayed?.start_date) {
                const playedDate = new Date(lastPlayed.start_date);
                const availableDate = new Date(playedDate);
                availableDate.setDate(availableDate.getDate() + eligibilityDays);
                daysRemaining = Math.max(1, Math.ceil((availableDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            }

            return res.status(400).json({
                error: `"${gameLibEntry.name}" is in cooldown for ${daysRemaining} more day${daysRemaining === 1 ? '' : 's'}`,
            });
        }

        // 6. Check queue limit (max 5 per user per tournament)
        const queueCount = await db.get(
            `SELECT COUNT(*) as count FROM games
             WHERE tournament_id = ? AND status = 'QUEUED'
               AND picker_discord_id = ? AND name != '[Pending Pick]'`,
            tournamentId, discordId
        );
        if ((queueCount?.count ?? 0) >= 5) {
            return res.status(400).json({ error: 'Queue limit reached (max 5 games per tournament)' });
        }

        // 7. Check for pending pick slot (user won and has picking rights)
        const pendingPick = await db.get(
            `SELECT id FROM games WHERE tournament_id = ? AND status = 'QUEUED' AND name = '[Pending Pick]' AND picker_discord_id = ?`,
            tournamentId, discordId
        );

        const styleId = gameLibEntry.style_id || undefined;
        const maxSlots = tournament.max_active_games ?? 1;
        const activeGames = await engine.getActiveGames(tournamentId);
        const hasOpenSlot = activeGames.length < maxSlots;

        if (pendingPick) {
            // User has a win pick — fulfil it
            if (hasOpenSlot) {
                // Activate immediately — create on iScored if enabled
                const { GameRoomSettingsService: GRS } = await import('../../services/GameRoomSettingsService.js');
                const iscoredEnabled = (await GRS.get(roomId, 'ISCORED_ENABLED')) !== 'false';
                const hasCredentials = iscoredEnabled && !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);

                let iscoredId: string | undefined;
                if (hasCredentials) {
                    const client = new IScoredClient();
                    await client.connect();
                    try {
                        iscoredId = await client.createGame(gameLibEntry.name, styleId);
                        await client.setGameTags(iscoredId, tournament.type);
                        await client.setGameStatus(iscoredId, { locked: false, hidden: false });
                    } finally {
                        await client.disconnect();
                    }
                }

                // Delete the pending pick placeholder and activate the real game
                await db.run('DELETE FROM games WHERE id = ?', pendingPick.id);
                await engine.activateGame(tournamentId, gameLibEntry.name, styleId, iscoredId, false);

                // Reorder iScored lineup in background
                if (hasCredentials) {
                    engine.reorderIScoredLineup().catch(() => {});
                }

                logInfo(`Web pick (activated): ${req.user!.username} picked ${gameLibEntry.name} for ${tournament.name}`);
                return res.json({ status: 'activated', gameName: gameLibEntry.name, tournamentName: tournament.name });
            } else {
                // All slots full — update placeholder to real game name (will activate at next maintenance)
                await db.run(
                    'UPDATE games SET name = ?, style_id = ? WHERE id = ?',
                    gameLibEntry.name, styleId || null, pendingPick.id
                );

                logInfo(`Web pick (queued, slots full): ${req.user!.username} picked ${gameLibEntry.name} for ${tournament.name}`);
                return res.json({ status: 'queued', gameName: gameLibEntry.name, tournamentName: tournament.name });
            }
        } else {
            // No pending pick — queue the game for next time
            await engine.queueGame(tournamentId, gameLibEntry.name, styleId, undefined, discordId);

            logInfo(`Web pick (queued): ${req.user!.username} queued ${gameLibEntry.name} for ${tournament.name}`);
            return res.json({ status: 'queued', gameName: gameLibEntry.name, tournamentName: tournament.name });
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/pick-game):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Internal Server Error' });
    }
});

// Delete a queued game — requires Discord login + ownership
router.delete('/:roomId/queue/:gameId', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const discordId = req.user!.discordId!;

        const game = await db.get(
            `SELECT g.id, g.picker_discord_id, t.game_room_id
             FROM games g JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND g.status = 'QUEUED' AND g.name != '[Pending Pick]'`,
            gameId
        );
        if (!game) return res.status(404).json({ error: 'Queued game not found' });
        if (game.game_room_id !== roomId) return res.status(403).json({ error: 'Game does not belong to this room' });
        if (game.picker_discord_id !== discordId) return res.status(403).json({ error: 'You can only remove your own queued games' });

        await db.run('DELETE FROM games WHERE id = ?', gameId);
        logInfo(`Queue delete: ${req.user!.username} removed queued game ${gameId}`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/queue/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Reorder queued games — requires Discord login + ownership
router.put('/:roomId/queue/reorder', requireDiscordUser, async (req, res) => {
    try {
        const validationResult = validate(ReorderQueueSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const db = await getDatabase();
        const roomId = req.params.roomId as string;
        const discordId = req.user!.discordId!;
        const { gameIds } = validationResult.data;

        // Verify all games belong to this user in this room
        for (const gameId of gameIds) {
            const game = await db.get(
                `SELECT g.id, g.picker_discord_id, t.game_room_id
                 FROM games g JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.id = ? AND g.status = 'QUEUED' AND g.name != '[Pending Pick]'`,
                gameId
            );
            if (!game || game.game_room_id !== roomId || game.picker_discord_id !== discordId) {
                return res.status(403).json({ error: 'Invalid game in reorder list' });
            }
        }

        // Update queue_order based on position in array
        await db.exec('BEGIN TRANSACTION');
        try {
            for (let i = 0; i < gameIds.length; i++) {
                await db.run('UPDATE games SET queue_order = ? WHERE id = ?', i + 1, gameIds[i]);
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }

        logInfo(`Queue reorder: ${req.user!.username} reordered ${gameIds.length} queued games`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/queue/reorder):', error);
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

// Enhanced stats
router.get('/:roomId/stats/enhanced/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const players = await StatsService.getEnhancedAllPlayerStats(req.params.roomId as string);
        res.json(players);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/enhanced/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/stats/enhanced/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const isDiscordId = /^\d{17,20}$/.test(identifier);
        const stats = isDiscordId
            ? await StatsService.getEnhancedPlayerStats(identifier, roomId)
            : await StatsService.getEnhancedPlayerStatsByUsername(identifier, roomId);
        if (!stats) return res.status(404).json({ error: 'Player not found' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/enhanced/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// All-time player rankings for a game
router.get('/:roomId/stats/game/:name/players', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const gameName = decodeURIComponent(req.params.name as string);
        const roomId = req.params.roomId as string;
        const rankings = await StatsService.getGamePlayerRankings(gameName, roomId);
        res.json(rankings);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name/players):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Per-game player stats
router.get('/:roomId/stats/game/:name/player/:identifier', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const gameName = decodeURIComponent(req.params.name as string);
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const stats = await StatsService.getPlayerGameStats(identifier, gameName, roomId);
        if (!stats) return res.status(404).json({ error: 'No stats found for this player and game' });
        res.json(stats);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/game/:name/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score counts per player for a game (for showing expand button only when multiple scores exist)
router.get('/:roomId/score-counts/:gameId', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const counts = await ScoreHistoryService.getPlayerScoreCounts(roomId, gameId);
        res.json(counts);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-counts/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score history for a player on a specific game
router.get('/:roomId/score-history/:gameName/player/:identifier', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const identifier = decodeURIComponent(req.params.identifier as string);
        const roomId = req.params.roomId as string;
        const history = await ScoreHistoryService.getPlayerGameHistory(roomId, gameName, identifier);
        res.json(history);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/:gameName/player/:identifier):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// All score history for a game
router.get('/:roomId/score-history/:gameName', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const history = await ScoreHistoryService.getGameHistory(roomId, gameName);
        res.json(history);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score submissions for a specific tournament game instance
router.get('/:roomId/score-history/game/:gameId', async (req, res) => {
    try {
        const { ScoreHistoryService } = await import('../../services/ScoreHistoryService.js');
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const submissions = await ScoreHistoryService.getGameSubmissions(roomId, gameId);
        res.json(submissions);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/score-history/game/:gameId):', error);
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

// Community scores
router.get('/:roomId/community-scores/recent', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const activity = await CommunityScoreService.getRecentActivity(req.params.roomId as string);
        res.json(activity);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/recent):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/community-scores/:gameName', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const leaderboard = await CommunityScoreService.getGameLeaderboard(roomId, gameName);
        res.json(leaderboard);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/community-scores/:gameName', async (req, res) => {
    try {
        const validationResult = validate(CommunityScoreSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const { username, score, discord_user_id, photo_url } = validationResult.data;
        const result = await CommunityScoreService.submitScore(roomId, gameName, username, score, discord_user_id, photo_url);
        res.status(201).json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/community-scores/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score submission with photo upload (public, rate-limited)
router.post('/:roomId/submit-score/:gameName', writeLimiter, roomAssetUpload.single('photo'), async (req, res) => {
    try {
        const validationResult = validate(ScoreSubmissionSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.gameName as string);
        const { username, score } = validationResult.data;

        // Check if photo is required
        const requirePhoto = await GameRoomSettingsService.get(roomId, 'REQUIRE_SCORE_PHOTO');
        if (requirePhoto === 'true' && !req.file) {
            return res.status(400).json({ error: 'A photo is required with score submissions.' });
        }

        // Save photo to persistent storage if provided
        let photoUrl: string | undefined;
        let persistentPhotoPath: string | undefined;
        if (req.file) {
            const ext = req.file.mimetype === 'image/png' ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
            const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
            fs.mkdirSync(dir, { recursive: true });
            persistentPhotoPath = path.join(dir, filename);
            fs.writeFileSync(persistentPhotoPath, req.file.buffer);
            photoUrl = `/api/score-photos/${roomId}/${filename}`;
        }

        // Save to community_scores + score_history
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const result = await CommunityScoreService.submitScore(roomId, gameName, username, score, undefined, photoUrl);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_submission', { gameName, username, score }).catch(() => {});

        // Also upsert into submissions so the main leaderboard reflects the highest score
        const db = await getDatabase();
        const activeGame = await db.get(`
            SELECT g.id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status IN ('ACTIVE', 'COMPLETED')
            LIMIT 1
        `, gameName, roomId);
        if (activeGame) {
            const submissionId = `${activeGame.id}-${username.toLowerCase()}`;
            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
            if (!existing || score > existing.score) {
                await db.run(
                    `INSERT OR REPLACE INTO submissions (id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    submissionId, activeGame.id, 'COMMUNITY', username, score, photoUrl || null, new Date().toISOString()
                );
                const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                await LeaderboardService.invalidate(activeGame.id);
            }
        }

        // Fire-and-forget iScored sync
        (async () => {
            let tempPhotoPath: string | undefined;
            try {
                const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
                if (!hasCredentials) return;

                const db = await getDatabase();
                const activeGame = await db.get(`
                    SELECT g.iscored_id FROM games g
                    JOIN tournaments t ON t.id = g.tournament_id
                    WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
                      AND g.status = 'ACTIVE' AND g.iscored_id IS NOT NULL
                    LIMIT 1
                `, gameName, roomId);
                if (!activeGame) {
                    logWarn(`No active iScored game found for "${gameName}" in room ${roomId}, skipping sync`);
                    return;
                }

                // Write temp copy for IScoredClient (needs filesystem path)
                if (persistentPhotoPath) {
                    tempPhotoPath = persistentPhotoPath + '.tmp';
                    fs.copyFileSync(persistentPhotoPath, tempPhotoPath);
                }

                const { IScoredClient } = await import('../../engine/IScoredClient.js');
                const client = new IScoredClient();
                await client.connect();
                try {
                    await client.submitScore(activeGame.iscored_id, username, score, tempPhotoPath);
                    logInfo(`iScored sync: submitted score for "${gameName}" by ${username}`);
                } finally {
                    await client.disconnect();
                }
            } catch (err) {
                logError(`iScored sync failed for "${gameName}" by ${username}:`, err);
            } finally {
                if (tempPhotoPath) try { fs.unlinkSync(tempPhotoPath); } catch {}
            }
        })();

        res.status(201).json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/submit-score/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game comments & tips
router.get('/:roomId/games/:gameName/comments', async (req, res) => {
    try {
        const { CommentService } = await import('../../services/CommentService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const type = req.query.type as 'comment' | 'tip' | undefined;
        const comments = await CommentService.getComments(roomId, gameName, type);
        res.json(comments);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameName/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/games/:gameName/comments', async (req, res) => {
    try {
        const validationResult = validate(GameCommentSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { CommentService } = await import('../../services/CommentService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const userId = (req.headers['x-user-id'] as string) || 'anon';
        const { display_name, type, body } = validationResult.data;
        const comment = await CommentService.addComment(roomId, gameName, userId, display_name, type, body);
        res.status(201).json(comment);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/games/:gameName/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.delete('/:roomId/games/:gameName/comments/:id', async (req, res) => {
    try {
        const { CommentService } = await import('../../services/CommentService.js');
        const commentId = parseInt(req.params.id as string, 10);
        const userId = (req.headers['x-user-id'] as string) || '';
        const comment = await CommentService.getCommentById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        // Only author can delete (admin deletion handled via admin routes)
        if (comment.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
        await CommentService.deleteComment(commentId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/games/:gameName/comments/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Game library search (autocomplete)
router.get('/:roomId/game_library/search', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const q = req.query.q as string;
        if (!q || typeof q !== 'string' || !q.trim()) {
            res.json([]);
            return;
        }
        const results = await GameLibraryService.search(q.trim());
        res.json(results);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library/search):', error);
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

        const roomId = req.params.roomId as string;
        await GameRoomSettingsService.saveMany(roomId, validationResult.data);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'settings_change', { keys: Object.keys(validationResult.data) }).catch(() => {});

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
        const tournament = await db.get('SELECT id, name, type, mode, discord_channel_id, game_room_id FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        const { TournamentEngine } = await import('../../engine/TournamentEngine.js');
        const engine = TournamentEngine.getInstance();

        const gameLibEntry = await db.get('SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
        const styleId = gameLibEntry?.style_id || undefined;

        let iscoredId: string | undefined;
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const iscoredSetting = await GameRoomSettingsService.get(req.params.roomId as string, 'ISCORED_ENABLED');
        const iscoredEnabled = iscoredSetting !== 'false';
        const hasCredentials = iscoredEnabled && !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
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

            // Announce activation in Discord
            const channelId = tournament.discord_channel_id || (await GameRoomSettingsService.get(req.params.roomId as string, 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'));
            if (channelId) {
                const { EmbedBuilder } = await import('discord.js');
                const { sendChannelEmbed, getTournamentColor } = await import('../../utils/discord.js');
                const color = getTournamentColor(tournament.type);
                const embed = new EmbedBuilder()
                    .setTitle(`Now Active: ${gameName}`)
                    .setDescription(`A new game has been activated for **${tournament.name}**. Get your scores in!`)
                    .setColor(color)
                    .setFooter({ text: tournament.name })
                    .setTimestamp();
                sendChannelEmbed(channelId, embed).catch(err =>
                    logWarn('Failed to send activation announcement:', err)
                );
            }

            if (hasCredentials) {
                engine.reorderIScoredLineup().catch(err =>
                    logWarn('Failed to reorder iScored lineup after activation:', err)
                );
            }
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
            `SELECT g.id, g.name, g.tournament_id, g.iscored_id, g.start_date,
                    g.catalogue_style_id, g.style_header_disabled,
                    t.name as tournament_name, t.type as tournament_type
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

        const result = await GameLibraryService.importGames(validationResult.data.games);
        // Also add to room
        const gameNames = validationResult.data.games.map((g: any) => g.name);
        await GameLibraryService.addToRoom(req.params.roomId as string, gameNames);
        res.json({ success: true, imported: result.imported, autoMerged: result.autoMerged });
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

// Get default catalogue style for a game in room's library
router.get('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        const style = await GameLibraryService.getRoomGameStyle(req.params.roomId as string, gameName);
        res.json({ catalogueStyleId: style?.catalogue_style_id || null, headerDisabled: style?.style_header_disabled === 1 });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/game_library/:name/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Set default catalogue style for a game in room's library
router.put('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        const validationResult = validate(AssignStyleSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { catalogueStyleId, headerDisabled } = validationResult.data;
        const updated = await GameLibraryService.setRoomGameStyle(
            req.params.roomId as string, gameName, catalogueStyleId, headerDisabled
        );
        if (!updated) return res.status(404).json({ error: 'Game not found in room library' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/game_library/:name/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Clear default catalogue style for a game in room's library
router.delete('/:roomId/game_library/:name/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameName = decodeURIComponent(req.params.name as string);
        await GameLibraryService.setRoomGameStyle(req.params.roomId as string, gameName, null, false);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/game_library/:name/style):', error);
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
        const { discord_user_id, discord_user, role } = req.body;
        const input = discord_user || discord_user_id;
        if (!input) return res.status(400).json({ error: 'discord_user or discord_user_id required' });

        const roomId = req.params.roomId as string;

        // Resolve username to ID if needed
        let resolvedId: string;
        if (/^\d{17,20}$/.test(input.trim())) {
            resolvedId = input.trim();
        } else {
            const { resolveDiscordUserId } = await import('../../utils/discord.js');
            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            const resolved = await resolveDiscordUserId(input.trim(), guildId || undefined);
            if (!resolved) {
                return res.status(400).json({ error: `Could not find Discord user "${input}". Try their numeric user ID instead.` });
            }
            resolvedId = resolved;
        }

        await AdminService.addRoomDiscordAdmin(roomId, resolvedId, role || 'admin');
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

// --- Admin Invites ---

// List pending invites
router.get('/:roomId/admins/invites', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const invites = await AdminService.getPendingInvites(req.params.roomId as string);
        res.json(invites);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admins/invites):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create invite
router.post('/:roomId/admins/invites', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { display_name, discord_user } = req.body;
        if (!display_name || typeof display_name !== 'string' || display_name.trim().length === 0) {
            return res.status(400).json({ error: 'display_name is required' });
        }

        const roomId = req.params.roomId as string;
        const createdBy = req.user?.discordId || req.user?.localAdminId || 'unknown';

        // Resolve Discord user input (could be numeric ID or username/handle)
        let resolvedDiscordId: string | undefined;
        if (discord_user && typeof discord_user === 'string' && discord_user.trim()) {
            const { resolveDiscordUserId } = await import('../../utils/discord.js');
            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            const resolved = await resolveDiscordUserId(discord_user.trim(), guildId || undefined);
            if (!resolved) {
                return res.status(400).json({ error: `Could not find Discord user "${discord_user}". Try their numeric user ID instead.` });
            }
            resolvedDiscordId = resolved;
        }

        const invite = await AdminService.createInvite(
            roomId, display_name.trim(), createdBy, resolvedDiscordId
        );

        // If Discord user resolved, try to DM them
        let dmSent = false;
        if (resolvedDiscordId) {
            const room = await GameRoomService.getById(roomId);
            const roomName = room?.name || 'a game room';
            const baseUrl = req.headers.origin || `${req.protocol}://${req.get('host')}`;
            const inviteUrl = `${baseUrl}/invite/${invite.token}`;
            const { sendDirectMessage } = await import('../../utils/discord.js');
            dmSent = await sendDirectMessage(
                resolvedDiscordId,
                `You've been invited to join **${roomName}** on ArcAid as an admin!\n\nClick the link below to set up your account:\n${inviteUrl}\n\nThis invite expires in 48 hours.`
            );
        }

        res.json({ ...invite, dmSent });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admins/invites):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Cancel invite
router.delete('/:roomId/admins/invites/:inviteId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const deleted = await AdminService.cancelInvite(
            req.params.inviteId as string, req.params.roomId as string
        );
        if (!deleted) return res.status(404).json({ error: 'Invite not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admins/invites/:inviteId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Game Style Assignment ---

// Assign a catalogue style to a game
router.put('/:roomId/admin/games/:gameId/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignStyleSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const { catalogueStyleId, headerDisabled } = validationResult.data;

        // Verify game belongs to this room
        const db = await getDatabase();
        const game = await db.get(
            `SELECT g.id FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND t.game_room_id = ?`,
            req.params.gameId as string, req.params.roomId as string
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const assigned = await StyleCatalogueService.assignToGame(
            req.params.gameId as string, catalogueStyleId, headerDisabled
        );
        if (!assigned) return res.status(404).json({ error: 'Style not found' });

        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/admin/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Remove style from a game
router.delete('/:roomId/admin/games/:gameId/style', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');

        // Verify game belongs to this room
        const db = await getDatabase();
        const game = await db.get(
            `SELECT g.id FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND t.game_room_id = ?`,
            req.params.gameId as string, req.params.roomId as string
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        await StyleCatalogueService.removeFromGame(req.params.gameId as string);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admin/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a score submission (admin only)
router.delete('/:roomId/admin/games/:gameId/submissions/:submissionId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const submissionId = req.params.submissionId as string;
        const db = await getDatabase();

        // Verify game belongs to this room
        const game = await db.get(
            `SELECT g.id FROM games g
             JOIN tournaments t ON g.tournament_id = t.id
             WHERE g.id = ? AND t.game_room_id = ?`,
            gameId, roomId
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        // Verify submission exists and belongs to this game
        const submission = await db.get(
            'SELECT id, iscored_username, score FROM submissions WHERE id = ? AND game_id = ?',
            submissionId, gameId
        );
        if (!submission) return res.status(404).json({ error: 'Submission not found' });

        // Delete the submission
        await db.run('DELETE FROM submissions WHERE id = ?', submissionId);

        // Invalidate leaderboard cache
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_deleted', {
            gameId,
            player: submission.iscored_username,
            score: submission.score,
        }).catch(() => {});

        logInfo(`Admin deleted submission ${submissionId} (${submission.iscored_username}: ${submission.score}) from game ${gameId}`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE rooms/:roomId/admin/games/:gameId/submissions/:submissionId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get style for a game
router.get('/:roomId/games/:gameId/style', async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.getGameStyle(req.params.gameId as string);
        if (!result) return res.json({ style: null });
        res.json(result);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/games/:gameId/style):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Asset Upload Endpoints ---

// Upload background image
router.post('/:roomId/admin/upload/background', requireAuth, requireRoomAccess('roomId'), roomAssetUpload.single('file'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        fs.mkdirSync(dir, { recursive: true });

        // Remove any existing background files
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith('background.'))) {
            fs.unlinkSync(path.join(dir, f));
        }

        const filename = `background.${ext}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);

        const url = `/api/room-assets/${roomId}/${filename}?v=${Date.now()}`;
        await GameRoomSettingsService.set(roomId, 'SCOREBOARD_BG_URL', url);
        res.json({ success: true, url });
    } catch (error) {
        logError('API Error (POST upload/background):', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Delete background image
router.delete('/:roomId/admin/upload/background', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir).filter(f => f.startsWith('background.'))) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
        await GameRoomSettingsService.delete(roomId, 'SCOREBOARD_BG_URL');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE upload/background):', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Upload logo image
router.post('/:roomId/admin/upload/logo', requireAuth, requireRoomAccess('roomId'), roomAssetUpload.single('file'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'No file uploaded' });

        const ext = file.mimetype === 'image/png' ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        fs.mkdirSync(dir, { recursive: true });

        // Remove any existing logo files
        for (const f of fs.readdirSync(dir).filter(f => f.startsWith('logo.'))) {
            fs.unlinkSync(path.join(dir, f));
        }

        const filename = `logo.${ext}`;
        fs.writeFileSync(path.join(dir, filename), file.buffer);

        const url = `/api/room-assets/${roomId}/${filename}?v=${Date.now()}`;
        // Update both game_rooms.logo_url and settings
        await GameRoomService.update(roomId, { logo_url: url });
        await GameRoomSettingsService.set(roomId, 'LOGO_URL', url);
        res.json({ success: true, url });
    } catch (error) {
        logError('API Error (POST upload/logo):', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Delete logo image
router.delete('/:roomId/admin/upload/logo', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const dir = path.join(process.cwd(), 'data', 'room-assets', roomId);
        if (fs.existsSync(dir)) {
            for (const f of fs.readdirSync(dir).filter(f => f.startsWith('logo.'))) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
        await GameRoomService.update(roomId, { logo_url: null });
        await GameRoomSettingsService.delete(roomId, 'LOGO_URL');
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE upload/logo):', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Room activity log
router.get('/:roomId/admin/activity', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const events = await RoomEventService.getRecent(roomId, limit, offset);
        res.json(events);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/activity):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Platform usage check (are any tournaments using this platform in their platform_rules?)
router.get('/:roomId/admin/platform-usage/:platform', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const platform = req.params.platform as string;
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT name FROM tournaments WHERE game_room_id = ? AND platform_rules LIKE ?`,
            [roomId, `%${platform}%`]
        );
        res.json({
            inUse: rows.length > 0,
            tournaments: rows.map((r: any) => r.name),
        });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/platform-usage/:platform):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ==================== GAME STATE MANAGEMENT ====================

// List all games for a room (admin view with full state info)
router.get('/:roomId/admin/game-states', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const statusFilter = req.query.status ? (req.query.status as string).split(',') : null;

        let query = `
            SELECT g.id, g.name, g.status, g.iscored_id, g.picker_discord_id,
                   g.picker_type, g.picker_designated_at, g.reminder_count,
                   g.won_game_id, g.start_date, g.end_date,
                   g.queue_order, g.style_id,
                   t.name as tournament_name, t.type as tournament_type, t.id as tournament_id
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            WHERE t.game_room_id = ?
        `;
        const params: any[] = [roomId];

        if (statusFilter) {
            query += ` AND g.status IN (${statusFilter.map(() => '?').join(',')})`;
            params.push(...statusFilter);
        }

        query += `
            ORDER BY
              CASE g.status
                WHEN 'ACTIVE' THEN 1
                WHEN 'QUEUED' THEN 2
                WHEN 'COMPLETED' THEN 3
                WHEN 'HIDDEN' THEN 4
              END,
              g.start_date DESC, g.queue_order ASC
        `;

        const games = await db.all(query, ...params);
        res.json(games);
    } catch (error) {
        logError('API Error (GET game-states):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Force change a game's status
router.patch('/:roomId/admin/game-states/:gameId/status', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = UpdateGameStateSchema.parse(req.body);
        const db = await getDatabase();

        // Verify game belongs to this room
        const game = await db.get(`
            SELECT g.*, t.game_room_id, t.type as tournament_type
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const oldStatus = game.status;
        const now = new Date().toISOString();

        // Update status with appropriate date fields
        if (parsed.status === 'ACTIVE') {
            await db.run('UPDATE games SET status = ?, start_date = COALESCE(start_date, ?), end_date = NULL WHERE id = ?', 'ACTIVE', now, gameId);
        } else if (parsed.status === 'COMPLETED') {
            await db.run('UPDATE games SET status = ?, end_date = ? WHERE id = ?', 'COMPLETED', now, gameId);
        } else if (parsed.status === 'QUEUED') {
            await db.run('UPDATE games SET status = ?, start_date = NULL, end_date = NULL WHERE id = ?', 'QUEUED', gameId);
        } else {
            await db.run('UPDATE games SET status = ? WHERE id = ?', parsed.status, gameId);
        }

        // Sync to iScored if requested
        if (parsed.syncIScored && game.iscored_id) {
            const client = new IScoredClient();
            try {
                await client.connect();
                if (parsed.status === 'ACTIVE') {
                    await client.setGameStatus(game.iscored_id, { locked: false, hidden: false });
                } else if (parsed.status === 'COMPLETED') {
                    await client.setGameStatus(game.iscored_id, { locked: true });
                } else if (parsed.status === 'HIDDEN') {
                    await client.setGameStatus(game.iscored_id, { hidden: true });
                }
            } catch (err) {
                logError(`Failed to sync game ${gameId} to iScored:`, err);
            } finally {
                await client.disconnect();
            }
        }

        // Invalidate leaderboard cache
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        // Log activity
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_state_change', {
            gameName: game.name,
            oldStatus,
            newStatus: parsed.status,
            syncedIScored: parsed.syncIScored && !!game.iscored_id,
        });

        logInfo(`Admin forced game state: ${game.name} ${oldStatus} → ${parsed.status} (room: ${roomId})`);
        res.json({ success: true, oldStatus, newStatus: parsed.status });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (PATCH game-states/:gameId/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Clear picker assignment (cancel timeout)
router.patch('/:roomId/admin/game-states/:gameId/clear-picker', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        await db.run(
            'UPDATE games SET picker_discord_id = NULL, picker_type = NULL, picker_designated_at = NULL, reminder_count = 0 WHERE id = ?',
            gameId
        );

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'picker_cleared', { gameName: game.name });

        logInfo(`Admin cleared picker for game: ${game.name} (room: ${roomId})`);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PATCH game-states/:gameId/clear-picker):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete a game row (cleanup phantom/orphaned entries)
router.delete('/:roomId/admin/game-states/:gameId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = DeleteGameStateSchema.parse(req.body);
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        // Delete from iScored if requested
        if (parsed.deleteFromIScored && game.iscored_id) {
            const client = new IScoredClient();
            try {
                await client.connect();
                await client.deleteGame(game.iscored_id);
                logInfo(`Deleted game from iScored: ${game.name} (${game.iscored_id})`);
            } catch (err) {
                logError(`Failed to delete game ${gameId} from iScored:`, err);
            } finally {
                await client.disconnect();
            }
        }

        // Cascade: delete submissions, leaderboard cache, score history
        await db.run('DELETE FROM submissions WHERE game_id = ?', gameId);
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
        await db.run('DELETE FROM score_history WHERE game_id = ?', gameId);
        await db.run('DELETE FROM games WHERE id = ?', gameId);

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_deleted', {
            gameName: game.name,
            status: game.status,
            deletedFromIScored: parsed.deleteFromIScored && !!game.iscored_id,
        });

        logInfo(`Admin deleted game: ${game.name} (status: ${game.status}, room: ${roomId})`);
        res.json({ success: true });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (DELETE game-states/:gameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sync a single game to iScored (granular operations)
router.post('/:roomId/admin/game-states/:gameId/sync-iscored', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const gameId = req.params.gameId as string;
        const parsed = SyncIScoredActionSchema.parse(req.body);
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const client = new IScoredClient();
        try {
            await client.connect();

            switch (parsed.action) {
                case 'lock':
                    if (!game.iscored_id) return res.status(400).json({ error: 'Game has no iScored ID' });
                    await client.setGameStatus(game.iscored_id, { locked: true });
                    break;
                case 'unlock':
                    if (!game.iscored_id) return res.status(400).json({ error: 'Game has no iScored ID' });
                    await client.setGameStatus(game.iscored_id, { locked: false, hidden: false });
                    break;
                case 'hide':
                    if (!game.iscored_id) return res.status(400).json({ error: 'Game has no iScored ID' });
                    await client.setGameStatus(game.iscored_id, { hidden: true });
                    break;
                case 'unhide':
                    if (!game.iscored_id) return res.status(400).json({ error: 'Game has no iScored ID' });
                    await client.setGameStatus(game.iscored_id, { hidden: false });
                    break;
                case 'delete':
                    if (!game.iscored_id) return res.status(400).json({ error: 'Game has no iScored ID' });
                    await client.deleteGame(game.iscored_id);
                    await db.run('UPDATE games SET iscored_id = NULL WHERE id = ?', gameId);
                    break;
                case 'create': {
                    const libraryEntry = await db.get(
                        'SELECT style_id FROM game_library WHERE name = ? COLLATE NOCASE', game.name
                    );
                    const styleId = libraryEntry?.style_id || game.style_id || undefined;
                    const newId = await client.createGame(game.name, styleId);
                    await db.run('UPDATE games SET iscored_id = ? WHERE id = ?', newId, gameId);
                    break;
                }
            }
        } finally {
            await client.disconnect();
        }

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'iscored_sync', { gameName: game.name, action: parsed.action });

        logInfo(`Admin iScored sync: ${parsed.action} on ${game.name} (room: ${roomId})`);
        res.json({ success: true, action: parsed.action });
    } catch (error: any) {
        if (error.name === 'ZodError') return res.status(400).json({ error: 'Invalid request', details: error.errors });
        logError('API Error (POST game-states/:gameId/sync-iscored):', error);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

// Force maintenance for a tournament
router.post('/:roomId/admin/game-states/force-maintenance', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { tournamentId } = req.body;
        if (!tournamentId) return res.status(400).json({ error: 'tournamentId required' });

        const db = await getDatabase();
        const tournament = await db.get('SELECT id, name, game_room_id FROM tournaments WHERE id = ? AND game_room_id = ?', tournamentId, roomId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found in this room' });

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'force_maintenance', { tournamentName: tournament.name });

        logInfo(`Admin forcing maintenance for tournament: ${tournament.name} (room: ${roomId})`);

        // Run maintenance asynchronously — don't block the response
        TournamentEngine.getInstance().runMaintenance(tournamentId).catch(err => {
            logError(`Forced maintenance failed for ${tournament.name}:`, err);
        });

        res.json({ success: true, message: `Maintenance triggered for ${tournament.name}` });
    } catch (error) {
        logError('API Error (POST game-states/force-maintenance):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
