import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { getDatabase } from '../../database/database.js';
import { logInfo, logError, logWarn } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess, requireDiscordUser, conditionalRequireDiscordUser } from '../middleware.js';
import { validate } from '../validate.js';
import {
    CreateTournamentSchema, UpdateTournamentSchema,
    ImportGamesSchema, UpdateGameSchema, SettingsSchema,
    HistoryQuerySchema, MergePlayerSchema,
    CreateRankingGroupSchema, UpdateRankingGroupSchema,
    CreateLocalAdminSchema,
    AssignStyleSchema,
    AssignImageSchema,
    StyleUploadSchema,
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
import { passesplatformRules, parsePlatformsList } from '../../utils/platformRules.js';
import { normalizeSubmitterUserId } from '../../services/SubmissionContextService.js';
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
    limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
    fileFilter: (_req, file, cb) => {
        if (['image/png', 'image/apng', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PNG, APNG, JPEG, and WebP images are allowed'));
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
        const requireDiscordLogin = await GameRoomSettingsService.get(room.id, 'REQUIRE_DISCORD_LOGIN');
        res.json({
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            admin_theme: adminTheme || 'dark',
            require_discord_login: requireDiscordLogin === 'true',
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
              AND orphaned_at IS NULL
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
            'SELECT id, name, type, mode, platform_rules, eligibility_days FROM tournaments WHERE id = ? AND game_room_id = ?',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Get eligibility window from tournament
        const eligibilityDays = tournament.eligibility_days ?? 120;

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
                   (SELECT s.iscored_username FROM submissions s WHERE s.game_id = g.id AND s.orphaned_at IS NULL ORDER BY s.score DESC LIMIT 1) as winner_name,
                   (SELECT s.score FROM submissions s WHERE s.game_id = g.id AND s.orphaned_at IS NULL ORDER BY s.score DESC LIMIT 1) as winner_score
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
              AND s.orphaned_at IS NULL
              AND s.score = (
                SELECT MAX(s2.score) FROM submissions s2
                JOIN games g2 ON g2.id = s2.game_id
                WHERE LOWER(g2.name) = LOWER(g.name)
                  AND s2.orphaned_at IS NULL
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

        // Pick-award gate state (plan §5) — room-level, controls UI enablement.
        const { PickAwardGate } = await import('../../services/PickAwardGate.js');
        const pickAwardEnabled = await PickAwardGate.isEnabled(roomId);

        res.json({ pendingPicks, queuedGames, tournaments, pickAwardEnabled });
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
            'SELECT id, name, type, mode, max_active_games, platform_rules, game_room_id, eligibility_days FROM tournaments WHERE id = ? AND game_room_id = ? AND is_active = 1',
            tournamentId, roomId
        );
        if (!tournament) return res.status(404).json({ error: 'Tournament not found or inactive' });

        // 1a. Pick-award gate (plan §5 / §8). Mirrors the Discord-command gate so the web
        //     pick path can't re-enable a flow that admins have opted out of.
        const { PickAwardGate } = await import('../../services/PickAwardGate.js');
        const pickEnabled = await PickAwardGate.isEnabled(tournament.game_room_id, tournament.id);
        if (!pickEnabled) return res.status(403).json({ error: 'Game picks are disabled in this room' });

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

        const gamePlatforms = parsePlatformsList(gameLibEntry.platforms || '');

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
            const eligibilityDays = tournament.eligibility_days ?? 120;

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

        // 6a. Sprint 6.5: a successful pick action establishes room membership.
        const { RoomMembershipService } = await import('../../services/RoomMembershipService.js');
        await RoomMembershipService.addMember(discordId, roomId, 'submission');

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

// v2.1.0: Stats page Combo overview — 4 cards at the top of /:slug/stats.
router.get('/:roomId/stats/overview', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const overview = await StatsService.getRoomOverview(req.params.roomId as string);
        res.json(overview);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/overview):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 7: per-game activity stats for the public Stats page (Games view)
router.get('/:roomId/stats/games-activity', async (req, res) => {
    try {
        const { StatsService } = await import('../../services/StatsService.js');
        const games = await StatsService.getGameActivityStats(req.params.roomId as string);
        res.json(games);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/stats/games-activity):', error);
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

// Lightweight top-N leaders for a game (used by Freeplay contextual leaders)
router.get('/:roomId/community-scores/:gameName/leaders', async (req, res) => {
    try {
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 5, 20);
        const leaderboard = await CommunityScoreService.getGameLeaderboard(roomId, gameName);
        res.json(leaderboard.slice(0, limit));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-scores/:gameName/leaders):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/community-scores/:gameName', conditionalRequireDiscordUser('roomId'), async (req, res) => {
    try {
        const validationResult = validate(CommunityScoreSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const gameName = decodeURIComponent(req.params.gameName as string);
        const roomId = req.params.roomId as string;
        const { username, score, discord_user_id, photo_url } = validationResult.data;
        // v2.2.0: anon-token plumbed for first-claim-wins.
        const rawAnonHeader = req.headers['x-user-id'];
        const anonToken = typeof rawAnonHeader === 'string' && rawAnonHeader.trim() ? rawAnonHeader.trim() : null;
        const result = await CommunityScoreService.submitScore(roomId, gameName, username, score, discord_user_id, photo_url, { anonToken });

        // v2.2.2: sync to iScored when this matches an ACTIVE tournament game.
        // photo_url is a pre-existing URL (not an upload), so no persistentPhotoPath
        // — Playwright fallback will skip the photo copy. API path still syncs.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName,
            username: result.displayName,
            score,
        });

        res.status(201).json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/community-scores/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Sprint 10 / plan §15 — collision check for anonymous submissions.
// Runs the typed name against the room's Discord guild and returns whether a
// guild member maps to it. The SubmissionSheet uses the response to decide
// whether to render the claim prompt before an unauthenticated submit.
router.post('/:roomId/submit/anonymous-check', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'name is required' });

        const db = await getDatabase();
        const room = await db.get('SELECT discord_guild_id FROM game_rooms WHERE id = ?', roomId);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (!room.discord_guild_id) return res.json({ match: false });

        const { resolveServerNickname } = await import('../../services/DiscordNicknameResolver.js');
        const resolved = await resolveServerNickname(room.discord_guild_id, name);
        if (!resolved) return res.json({ match: false });

        res.json({
            match: true,
            serverNickname: resolved.serverNickname,
            matchedField: resolved.matchedField,
        });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/submit/anonymous-check):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// v2.2.5 — pre-submit name availability check for the SubmissionSheet
// collision prompt. Mirrors the resolution logic in RoomNameClaimService.resolveAndClaim
// but doesn't persist anything, so the frontend can show a "name taken, try X"
// prompt before the user commits to submission.
router.post('/:roomId/submit/name-check', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        if (!name) return res.status(400).json({ error: 'name is required' });

        // Claimant identity: Discord if they're logged in (Authorization header
        // decoded downstream on submit; here we parse ourselves since the route
        // is public), else anon-token from x-user-id, else sessionless.
        let discordUserId: string | undefined;
        const authHeader = req.headers['authorization'];
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(token);
                if (payload?.discordId) discordUserId = payload.discordId;
            } catch { /* ignore; fall through to anon */ }
        }
        const rawAnonHeader = req.headers['x-user-id'];
        const anonToken = typeof rawAnonHeader === 'string' && rawAnonHeader.trim() ? rawAnonHeader.trim() : null;

        const { RoomNameClaimService } = await import('../../services/RoomNameClaimService.js');
        const claimant = RoomNameClaimService.buildClaimant({ discordUserId, anonToken });
        const result = await RoomNameClaimService.checkAvailability(roomId, name, claimant);
        res.json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/submit/name-check):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Score submission with photo upload (public, rate-limited)
// Discord login conditionally enforced via REQUIRE_DISCORD_LOGIN room setting.
router.post('/:roomId/submit-score/:gameName', writeLimiter, conditionalRequireDiscordUser('roomId'), roomAssetUpload.single('photo'), async (req, res) => {
    try {
        const validationResult = validate(ScoreSubmissionSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.gameName as string);
        const { username, score } = validationResult.data;
        const excludeFromGlobal = req.body.excludeGlobal === 'true' || req.body.excludeGlobal === true;

        // Check if photo is required
        const requirePhoto = await GameRoomSettingsService.get(roomId, 'REQUIRE_SCORE_PHOTO');
        if (requirePhoto === 'true' && !req.file) {
            return res.status(400).json({ error: 'A photo is required with score submissions.' });
        }

        // Save photo to persistent storage if provided
        let photoUrl: string | undefined;
        let persistentPhotoPath: string | undefined;
        if (req.file) {
            const ext = (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/apng') ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
            const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
            const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
            fs.mkdirSync(dir, { recursive: true });
            persistentPhotoPath = path.join(dir, filename);
            fs.writeFileSync(persistentPhotoPath, req.file.buffer);
            photoUrl = `/api/score-photos/${roomId}/${filename}`;
        }

        // v2.2.0: read the localStorage-derived anon token so guest claims are
        // sticky-per-browser. The `x-user-id` header may be undefined for
        // sessionless clients (curl, Discord-embed, etc.) — that's handled
        // downstream as a no-claim resolution.
        const rawAnonHeader = req.headers['x-user-id'];
        const anonToken = typeof rawAnonHeader === 'string' && rawAnonHeader.trim() ? rawAnonHeader.trim() : null;

        // Save to community_scores + score_history. Fan-out to global_scores
        // is handled inside CommunityScoreService.submitScore (best-effort).
        // The service routes username through RoomNameClaimService and returns
        // the resolved displayName (possibly suffixed e.g. "Bob_2").
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const result = await CommunityScoreService.submitScore(
            roomId, gameName, username, score, req.user?.discordId, photoUrl, { excludeFromGlobal, anonToken }
        );
        const effectiveUsername = result.displayName;

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'score_submission', { gameName, username: effectiveUsername, score }).catch(() => {});

        // Also upsert into submissions so the main leaderboard reflects the highest score.
        // Use the resolved displayName so the submission ID and stored name match
        // the community/score_history rows — keeps the leaderboard grouping clean.
        const db = await getDatabase();
        const activeGame = await db.get(`
            SELECT g.id, g.tournament_id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status IN ('ACTIVE', 'COMPLETED')
            LIMIT 1
        `, gameName, roomId);
        if (activeGame) {
            const submissionId = `${activeGame.id}-${effectiveUsername.toLowerCase()}`;
            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
            if (!existing || score > existing.score) {
                const submittedByUserId = normalizeSubmitterUserId(req.user?.discordId);
                const submittedByAnonymousName = submittedByUserId ? null : effectiveUsername;
                await db.run(
                    `INSERT OR REPLACE INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                    submissionId, activeGame.id, 'COMMUNITY', effectiveUsername, score, photoUrl || null, new Date().toISOString(),
                    roomId, activeGame.tournament_id || null, submittedByUserId, submittedByAnonymousName
                );
                const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                await LeaderboardService.invalidate(activeGame.id);
            }
        }

        // v2.2.2: iScored sync extracted to a shared helper so all three web
        // submission paths sync identically. Pass the resolved displayName so the
        // name on iScored matches the name on ArcAid's scoreboard.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName,
            username: effectiveUsername,
            score,
            persistentPhotoPath,
        });

        res.status(201).json(result);
    } catch (error) {
        logError('API Error (POST rooms/:roomId/submit-score/:gameName):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /:roomId/freeplay-score — submit a freeplay score for any game in the
 * global catalogue, attributed to this room. The game does NOT need to be an
 * active tournament game in the room. Photo required.
 *
 * Saves to community_scores + score_history (room-scoped views) and fans out
 * to global_scores (subject to room GLOBAL_SCOREBOARD_ENABLED and user exclude_global).
 */
router.post('/:roomId/freeplay-score', writeLimiter, conditionalRequireDiscordUser('roomId'), roomAssetUpload.single('photo'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { globalGameId, username, score: scoreRaw, excludeGlobal: excludeRaw } = req.body || {};
        if (!globalGameId || !username) {
            return res.status(400).json({ error: 'globalGameId and username are required' });
        }
        const score = typeof scoreRaw === 'string' ? parseInt(scoreRaw, 10) : scoreRaw;
        if (!Number.isInteger(score) || score < 0) {
            return res.status(400).json({ error: 'Valid positive score required' });
        }
        const excludeFromGlobal = excludeRaw === 'true' || excludeRaw === true;

        // Photo is required for freeplay (no tournament cross-check, so evidence matters)
        if (!req.file) {
            return res.status(400).json({ error: 'A photo is required for freeplay score submissions.' });
        }

        // Resolve the game from the global catalogue
        const db = await getDatabase();
        const globalGame = await db.get(
            'SELECT id, name FROM global_games WHERE id = ? AND status = \'approved\'',
            globalGameId
        );
        if (!globalGame) {
            return res.status(404).json({ error: 'Game not found in the global catalogue' });
        }

        // Persist photo
        const ext = (req.file.mimetype === 'image/png' || req.file.mimetype === 'image/apng') ? 'png' : req.file.mimetype === 'image/webp' ? 'webp' : 'jpg';
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        const dir = path.join(process.cwd(), 'data', 'score-photos', roomId);
        fs.mkdirSync(dir, { recursive: true });
        const persistentPhotoPath = path.join(dir, filename);
        fs.writeFileSync(persistentPhotoPath, req.file.buffer);
        const photoUrl = `/api/score-photos/${roomId}/${filename}`;

        // v2.2.0: anon-token plumbed for first-claim-wins (see tournament submit handler comment).
        const rawAnonHeader = req.headers['x-user-id'];
        const anonToken = typeof rawAnonHeader === 'string' && rawAnonHeader.trim() ? rawAnonHeader.trim() : null;

        // Save to community_scores (room-scoped) — uses the global_games.name for
        // consistent cross-referencing. CommunityScoreService will also fan-out to
        // global_scores via GlobalScoreService, respecting exclude_from_global.
        // Returns resolved displayName when the requested username collided.
        const { CommunityScoreService } = await import('../../services/CommunityScoreService.js');
        const result = await CommunityScoreService.submitScore(
            roomId,
            globalGame.name,
            username,
            score,
            req.user?.discordId,
            photoUrl,
            { excludeFromGlobal, anonToken }
        );

        // v2.2.0: use the resolved displayName (possibly suffixed) for activity
        // logging and the submissions upsert, so leaderboard groupings match
        // what's stored in community_scores/score_history.
        const effectiveUsername = result.displayName;

        // Log activity
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'freeplay_score_submission', {
            globalGameId,
            gameName: globalGame.name,
            username: effectiveUsername,
            score,
        }).catch(() => {});

        // v2.0.3: if this room has an ACTIVE/COMPLETED tournament game matching
        // this name, upsert into submissions too so the Tournament card
        // reflects the score. Matches the behavior of /submit-score — the path
        // a user takes to submit shouldn't change whether the score counts
        // toward the active tournament.
        const activeGame = await db.get(`
            SELECT g.id, g.tournament_id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status IN ('ACTIVE', 'COMPLETED')
            LIMIT 1
        `, globalGame.name, roomId);
        if (activeGame) {
            const submissionId = `${activeGame.id}-${effectiveUsername.toLowerCase()}`;
            const existing = await db.get('SELECT score FROM submissions WHERE id = ?', submissionId);
            if (!existing || score > existing.score) {
                const { normalizeSubmitterUserId } = await import('../../services/SubmissionContextService.js');
                const submittedByUserId = normalizeSubmitterUserId(req.user?.discordId);
                const submittedByAnonymousName = submittedByUserId ? null : effectiveUsername;
                await db.run(
                    `INSERT OR REPLACE INTO submissions (
                        id, game_id, discord_user_id, iscored_username, score, photo_url, timestamp,
                        submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                        submitted_by_anonymous_name, merged_from_anonymous_identity_id
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                    submissionId, activeGame.id, 'COMMUNITY', effectiveUsername, score, photoUrl, new Date().toISOString(),
                    roomId, activeGame.tournament_id || null, submittedByUserId, submittedByAnonymousName
                );
                const { LeaderboardService } = await import('../../services/LeaderboardService.js');
                await LeaderboardService.invalidate(activeGame.id);
            }
        }

        // v2.2.2: sync to iScored too when the freeplay target matches an ACTIVE
        // tournament game. Closes the "freeplay scores never reach iScored" gap.
        const { syncScoreToIScored } = await import('../../services/IScoredSubmitSync.js');
        syncScoreToIScored({
            roomId,
            gameName: globalGame.name,
            username: effectiveUsername,
            score,
            persistentPhotoPath,
        });

        res.status(201).json({
            id: result.id,
            gameName: globalGame.name,
            displayName: result.displayName,
            suffixed: result.suffixed,
            requested: result.requested,
        });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/freeplay-score):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Lobby Feed ───

// Public feed — no auth required, optional player token for friend events
router.get('/:roomId/lobby/feed', async (req, res) => {
    try {
        const { LobbyFeedService } = await import('../../services/LobbyFeedService.js');
        const roomId = req.params.roomId as string;
        const limit = parseInt(req.query.limit as string) || 20;
        const before = req.query.before as string | undefined;
        const typesParam = req.query.types as string | undefined;
        const types = typesParam ? typesParam.split(',').filter(Boolean) : undefined;

        // If viewer is authenticated, pass their ID for targeted events (friend scores)
        const viewerUserId = req.user?.discordId;

        const feed = await LobbyFeedService.getFeed(roomId, {
            limit: Math.min(limit, 50),
            before,
            types,
            viewerUserId,
        });

        res.json(feed);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/lobby/feed):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin curated feed posts
router.post('/:roomId/lobby/feed', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { LobbyFeedService } = await import('../../services/LobbyFeedService.js');
        const roomId = req.params.roomId as string;
        const { type, title, subtitle } = req.body;

        if (!type || !title) {
            return res.status(400).json({ error: 'type and title are required' });
        }

        if (!['admin_message', 'admin_shoutout'].includes(type)) {
            return res.status(400).json({ error: 'type must be admin_message or admin_shoutout' });
        }

        const id = await LobbyFeedService.emit({
            gameRoomId: roomId,
            type,
            source: 'admin',
            icon: type === 'admin_shoutout' ? '⭐' : '📢',
            title,
            subtitle,
        });

        res.status(201).json({ id });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/lobby/feed):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Community leaderboards — all games with freeplay/community scores
router.get('/:roomId/community-leaderboards', async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const sort = (req.query.sort as string) || 'recent';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        const offset = parseInt(req.query.offset as string) || 0;
        const search = (req.query.search as string) || '';
        const db = await getDatabase();

        // Get unique games with community scores
        const orderBy = sort === 'alpha'
            ? 'game_name ASC'
            : 'last_played DESC';
        const searchFilter = search ? 'AND LOWER(game_name) LIKE LOWER(?)' : '';
        const searchParams = search ? [`%${search}%`] : [];

        const games = await db.all(`
            SELECT
                game_name,
                COUNT(DISTINCT LOWER(iscored_username)) as player_count,
                COUNT(*) as total_scores,
                MAX(created_at) as last_played
            FROM community_scores
            WHERE game_room_id = ?
              AND orphaned_at IS NULL
              ${searchFilter}
            GROUP BY LOWER(game_name)
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `, roomId, ...searchParams, limit, offset);

        // For each game, get top scores with style resolution for card rendering
        const results = await Promise.all(games.map(async (game: any) => {
            const topScores = await db.all(`
                SELECT
                    cs.iscored_username,
                    MAX(cs.score) as best_score,
                    cs.discord_user_id,
                    um.avatar_hash
                FROM community_scores cs
                LEFT JOIN user_mappings um ON cs.discord_user_id = um.discord_user_id
                WHERE cs.game_room_id = ? AND LOWER(cs.game_name) = LOWER(?)
                  AND cs.orphaned_at IS NULL
                GROUP BY LOWER(cs.iscored_username)
                ORDER BY best_score DESC
                LIMIT 10
            `, roomId, game.game_name);

            // Style resolution: room library → game_library → global_games
            const roomLib = await db.get(`
                SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled, global_game_id
                FROM game_room_game_library
                WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
            `, roomId, game.game_name);

            const globalLib = await db.get(`
                SELECT global_game_id, display_name, image_url
                FROM game_library WHERE LOWER(name) = LOWER(?)
            `, game.game_name);

            const catalogueGame = await db.get(
                "SELECT id, local_image_path, wheel_image_path, image_url FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 1",
                game.game_name
            );

            const catalogueStyleId = roomLib?.catalogue_style_id || null;
            const logoStyleId = roomLib?.logo_style_id || null;
            const bgStyleId = roomLib?.bg_style_id || null;
            const styleHeaderDisabled = !!(roomLib?.style_header_disabled);

            // Style catalogue image-presence flags
            let bgHasBg = null, logoHasHeader = null, catHasBg = null, catHasHeader = null;
            const styleIds = new Set([bgStyleId, logoStyleId, catalogueStyleId].filter(Boolean));
            if (styleIds.size > 0) {
                const placeholders = [...styleIds].map(() => '?').join(',');
                const rows = await db.all(
                    `SELECT id, has_background, has_header FROM style_catalogue WHERE id IN (${placeholders})`,
                    ...[...styleIds]
                );
                const byId: Record<string, any> = {};
                for (const r of rows) byId[r.id] = r;
                if (bgStyleId && byId[bgStyleId]) bgHasBg = byId[bgStyleId].has_background;
                if (logoStyleId && byId[logoStyleId]) logoHasHeader = byId[logoStyleId].has_header;
                if (catalogueStyleId && byId[catalogueStyleId]) {
                    catHasBg = byId[catalogueStyleId].has_background;
                    catHasHeader = byId[catalogueStyleId].has_header;
                }
            }

            const globalGameId = roomLib?.global_game_id || globalLib?.global_game_id || catalogueGame?.id || null;
            const imageUrl = catalogueGame?.local_image_path || catalogueGame?.wheel_image_path || catalogueGame?.image_url || globalLib?.image_url || null;

            return {
                // Card-compatible fields (GameLeaderboard shape)
                gameId: globalGameId || `community_${game.game_name}`,
                gameName: game.game_name,
                displayName: globalLib?.display_name || null,
                tournamentName: '', // v2.0.1 — no user-facing "Community" label; cards hide when empty.
                tournamentType: 'community',
                imageUrl,
                gameStatus: 'COMMUNITY',
                catalogueStyleId,
                logoStyleId,
                bgStyleId,
                styleHeaderDisabled,
                bgHasBg,
                logoHasHeader,
                catHasBg,
                catHasHeader,
                externalUrl: null,
                notes: null,
                rankings: topScores.map((s: any, i: number) => ({
                    rank: i + 1,
                    discord_user_id: s.discord_user_id || '',
                    iscored_username: s.iscored_username,
                    score: s.best_score,
                    avatar_hash: s.avatar_hash || null,
                })),
                // Extra metadata
                globalGameId,
                lastPlayed: game.last_played,
                playerCount: game.player_count,
                totalScores: game.total_scores,
                // Legacy format for Freeplay backward compat
                topScores: topScores.map((s: any) => ({
                    iscored_username: s.iscored_username,
                    best_score: s.best_score,
                })),
            };
        }));

        res.json(results);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/community-leaderboards):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ── Lobby Content (announcements, shelf, config) ──

// Public: active announcements
router.get('/:roomId/lobby/announcements', async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcements = await AnnouncementService.getActive(req.params.roomId as string);
        res.json(announcements);
    } catch (error) {
        logError('API Error (GET lobby/announcements):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: all announcements (includes expired/scheduled)
router.get('/:roomId/lobby/announcements/all', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcements = await AnnouncementService.getAll(req.params.roomId as string);
        res.json(announcements);
    } catch (error) {
        logError('API Error (GET lobby/announcements/all):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: create announcement
router.post('/:roomId/lobby/announcements', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { title, body, image_url, cta_url, cta_label, type, event_datetime, display_from, display_until, sort_order } = req.body;
        if (!title) return res.status(400).json({ error: 'title is required' });
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const announcement = await AnnouncementService.create(req.params.roomId as string, {
            title, body, image_url, cta_url, cta_label, type, event_datetime, display_from, display_until, sort_order,
        });
        res.status(201).json(announcement);
    } catch (error) {
        logError('API Error (POST lobby/announcements):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: update announcement
router.put('/:roomId/lobby/announcements/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        const updated = await AnnouncementService.update(req.params.id as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        logError('API Error (PUT lobby/announcements/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: delete announcement
router.delete('/:roomId/lobby/announcements/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { AnnouncementService } = await import('../../services/AnnouncementService.js');
        await AnnouncementService.delete(req.params.id as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE lobby/announcements/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public: community shelf items
router.get('/:roomId/lobby/shelf', async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const items = await CommunityShelfService.getAll(req.params.roomId as string);
        res.json(items);
    } catch (error) {
        logError('API Error (GET lobby/shelf):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: add shelf item
router.post('/:roomId/lobby/shelf', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { url, title, type, thumbnail, description, sort_order } = req.body;
        if (!url || !title) return res.status(400).json({ error: 'url and title are required' });
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const item = await CommunityShelfService.create(req.params.roomId as string, {
            url, title, type, thumbnail, description, sort_order,
        });
        res.status(201).json(item);
    } catch (error) {
        logError('API Error (POST lobby/shelf):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: update shelf item
router.put('/:roomId/lobby/shelf/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        const updated = await CommunityShelfService.update(req.params.id as string, req.body);
        if (!updated) return res.status(404).json({ error: 'Not found' });
        res.json(updated);
    } catch (error) {
        logError('API Error (PUT lobby/shelf/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: delete shelf item
router.delete('/:roomId/lobby/shelf/:id', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        await CommunityShelfService.delete(req.params.id as string);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE lobby/shelf/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: reorder shelf items
router.put('/:roomId/lobby/shelf-reorder', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { orderedIds } = req.body;
        if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIds array is required' });
        const { CommunityShelfService } = await import('../../services/CommunityShelfService.js');
        await CommunityShelfService.reorder(req.params.roomId as string, orderedIds);
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (PUT lobby/shelf-reorder):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public: lobby config (social links, pinned message, feed settings)
router.get('/:roomId/lobby/config', async (req, res) => {
    try {
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const roomId = req.params.roomId as string;
        const [socialLinks, pinnedMessage, feedSettings, defaultLanding] = await Promise.all([
            GameRoomSettingsService.get(roomId, 'LOBBY_SOCIAL_LINKS'),
            GameRoomSettingsService.get(roomId, 'LOBBY_PINNED_MESSAGE'),
            GameRoomSettingsService.get(roomId, 'LOBBY_FEED_SETTINGS'),
            GameRoomSettingsService.get(roomId, 'LOBBY_DEFAULT_LANDING'),
        ]);
        res.json({
            socialLinks: socialLinks ? JSON.parse(socialLinks) : [],
            pinnedMessage: pinnedMessage ? JSON.parse(pinnedMessage) : null,
            feedSettings: feedSettings ? JSON.parse(feedSettings) : null,
            defaultLanding: defaultLanding === 'true',
        });
    } catch (error) {
        logError('API Error (GET lobby/config):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Admin: save lobby config
router.put('/:roomId/lobby/config', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const roomId = req.params.roomId as string;
        const { socialLinks, pinnedMessage, feedSettings, defaultLanding } = req.body;
        if (socialLinks !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_SOCIAL_LINKS', JSON.stringify(socialLinks));
        }
        if (pinnedMessage !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_PINNED_MESSAGE', JSON.stringify(pinnedMessage));
        }
        if (feedSettings !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_FEED_SETTINGS', JSON.stringify(feedSettings));
        }
        if (defaultLanding !== undefined) {
            await GameRoomSettingsService.set(roomId, 'LOBBY_DEFAULT_LANDING', defaultLanding ? 'true' : 'false');
        }
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (PUT lobby/config):', error);
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
                WHERE orphaned_at IS NULL
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
        const tournament = await db.get('SELECT id, name, type, mode, discord_channel_id, game_room_id, platform_rules FROM tournaments WHERE id = ?', tournamentId);
        if (!tournament) return res.status(404).json({ error: 'Tournament not found' });

        // Enforce platform rules
        let platformRules = { required: [] as string[], excluded: [] as string[] };
        try { platformRules = { ...platformRules, ...JSON.parse(tournament.platform_rules || '{}') }; } catch {}
        if (platformRules.required.length > 0 || platformRules.excluded.length > 0) {
            const gameLibRow = await db.get('SELECT platforms FROM game_library WHERE name = ? COLLATE NOCASE', gameName);
            const gamePlatforms = parsePlatformsList(gameLibRow?.platforms || '');
            if (!passesplatformRules(gamePlatforms, platformRules)) {
                return res.status(400).json({ error: `Game "${gameName}" does not meet this tournament's platform requirements` });
            }
        }

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
            `SELECT g.id, g.name, g.display_name, g.tournament_id, g.iscored_id, g.start_date,
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

// Update game display name
router.patch('/:roomId/admin/games/:gameId/display-name', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const roomId = req.params.roomId as string;
        const { displayName } = req.body;
        if (displayName !== null && displayName !== undefined && typeof displayName !== 'string') {
            return res.status(400).json({ error: 'displayName must be a string or null' });
        }
        const db = await getDatabase();
        // Verify game belongs to this room
        const game = await db.get(
            `SELECT g.id, g.name FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE g.id = ? AND t.game_room_id = ?`,
            gameId, roomId
        );
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const value = displayName?.trim() || null;
        await db.run('UPDATE games SET display_name = ? WHERE id = ?', value, gameId);

        // Also update the game library entry if it exists
        await db.run('UPDATE game_library SET display_name = ? WHERE name = ? COLLATE NOCASE', value, game.name);

        // Invalidate leaderboard cache
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        res.json({ success: true, displayName: value });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/admin/games/:gameId/display-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update game notes
router.patch('/:roomId/admin/games/:gameId/notes', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const gameId = req.params.gameId as string;
        const roomId = req.params.roomId as string;
        const { notes } = req.body;
        const db = await getDatabase();

        const game = await db.get(`
            SELECT g.*, t.game_room_id
            FROM games g JOIN tournaments t ON g.tournament_id = t.id
            WHERE g.id = ? AND t.game_room_id = ?
        `, gameId, roomId);
        if (!game) return res.status(404).json({ error: 'Game not found in this room' });

        const value = typeof notes === 'string' ? notes.trim() || null : null;
        await db.run('UPDATE games SET notes = ? WHERE id = ?', value, gameId);

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        res.json({ success: true, notes: value });
    } catch (error) {
        logError('API Error (PATCH rooms/:roomId/admin/games/:gameId/notes):', error);
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
        let mergedCount = 0;

        // 1. Handle submissions: rename IDs and keep higher score on conflicts
        const syncRows = await db.all(
            `SELECT id, game_id, score FROM submissions WHERE LOWER(iscored_username) = LOWER(?) AND id LIKE '%' || '-' || ?`,
            fromUsername, fromUsername.toLowerCase()
        );
        for (const row of syncRows) {
            const newId = `${row.game_id}-${toUsername.toLowerCase()}`;
            const existing = await db.get('SELECT id, score FROM submissions WHERE id = ?', newId);
            if (existing) {
                if (row.score > existing.score) {
                    // Source has higher score — replace target
                    await db.run('DELETE FROM submissions WHERE id = ?', existing.id);
                    await db.run('UPDATE submissions SET id = ?, iscored_username = ? WHERE id = ?', newId, toUsername, row.id);
                } else {
                    // Target has higher or equal score — delete source
                    await db.run('DELETE FROM submissions WHERE id = ?', row.id);
                }
            } else {
                await db.run('UPDATE submissions SET id = ?, iscored_username = ? WHERE id = ?', newId, toUsername, row.id);
            }
            mergedCount++;
        }

        // 2. Catch any remaining submissions not matched by ID pattern
        const subResult = await db.run(
            'UPDATE submissions SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );
        mergedCount += subResult.changes || 0;

        // 3. Scores table
        const scoreResult = await db.run(
            'UPDATE scores SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );
        mergedCount += scoreResult.changes || 0;

        // 4. Community scores
        const communityResult = await db.run(
            'UPDATE community_scores SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );
        mergedCount += communityResult.changes || 0;

        // 5. Score history
        const historyResult = await db.run(
            'UPDATE score_history SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );
        mergedCount += historyResult.changes || 0;

        // 6. User mappings
        await db.run(
            'UPDATE user_mappings SET iscored_username = ? WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername, fromUsername
        );

        // 7. Fix discord_user_id on merged submissions — resolve target's real Discord ID
        const targetMapping = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
            toUsername
        );
        if (targetMapping?.discord_user_id) {
            await db.run(
                `UPDATE submissions SET discord_user_id = ? WHERE LOWER(iscored_username) = LOWER(?) AND (discord_user_id LIKE 'iscored:%' OR discord_user_id IN ('COMMUNITY', 'ANON'))`,
                targetMapping.discord_user_id, toUsername
            );
            await db.run(
                `UPDATE community_scores SET discord_user_id = ? WHERE LOWER(iscored_username) = LOWER(?) AND (discord_user_id LIKE 'iscored:%' OR discord_user_id IN ('COMMUNITY', 'ANON'))`,
                targetMapping.discord_user_id, toUsername
            );
        }

        // 8. Record alias so ScoreSyncPoller maps this username going forward
        await db.run(
            'INSERT OR REPLACE INTO player_aliases (old_username, new_username) VALUES (?, ?)',
            fromUsername.toLowerCase(), toUsername
        );

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidateAll();
        const { RankingService } = await import('../../services/RankingService.js');
        await RankingService.invalidateAll();

        logInfo(`Merged player '${fromUsername}' -> '${toUsername}': ${mergedCount} records updated`);

        res.json({
            success: true,
            submissionsUpdated: syncRows.length + (subResult.changes || 0),
            scoresUpdated: (scoreResult.changes || 0) + (communityResult.changes || 0) + (historyResult.changes || 0),
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

// Assign a style image (logo/background/both) to an active game
router.put('/:roomId/admin/games/:gameId/image', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignImageSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { styleId, imageType } = validationResult.data;
        const gameId = req.params.gameId as string;

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.assignImageToGame(gameId, styleId, imageType);
        if (!result.ok) return res.status(400).json({ error: result.error });

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/admin/games/:gameId/image):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Assign a style image (logo/background/both) as room library default
router.put('/:roomId/game_library/:name/image', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const validationResult = validate(AssignImageSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });
        const { styleId, imageType } = validationResult.data;
        const roomId = req.params.roomId as string;
        const gameName = decodeURIComponent(req.params.name as string);

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const result = await StyleCatalogueService.assignImageToLibrary(roomId, gameName, styleId, imageType);
        if (!result.ok) return res.status(400).json({ error: result.error });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (PUT rooms/:roomId/game_library/:name/image):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get games for the "Apply to Game" picker (leaderboard games + library games)
router.get('/:roomId/admin/games-for-picker', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        const { GameLibraryService } = await import('../../services/GameLibraryService.js');

        const leaderboards = await LeaderboardService.getActiveLeaderboards(roomId);
        const leaderboardGames = leaderboards.map(lb => ({
            gameId: lb.gameId,
            gameName: lb.gameName,
            tournamentName: lb.tournamentName,
            gameStatus: lb.gameStatus,
        }));

        const libraryGames = await GameLibraryService.getForRoom(roomId);
        const leaderboardNames = new Set(leaderboardGames.map(g => g.gameName.toLowerCase()));
        const libraryOnly = (libraryGames as any[])
            .filter((g: any) => !leaderboardNames.has((g.name || g.game_name || '').toLowerCase()))
            .map((g: any) => ({ gameName: g.name || g.game_name }));

        res.json({ leaderboardGames, libraryGames: libraryOnly });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/games-for-picker):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Upload a custom style to the global catalogue (room admins can contribute)
router.post('/:roomId/admin/styles/upload', requireAuth, requireRoomAccess('roomId'), roomAssetUpload.fields([
    { name: 'background', maxCount: 1 },
    { name: 'header', maxCount: 1 },
]), async (req, res) => {
    try {
        const validationResult = validate(StyleUploadSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
        const bgFile = files?.background?.[0];
        const headerFile = files?.header?.[0];
        if (!bgFile && !headerFile) {
            return res.status(400).json({ error: 'At least one image (background or header) is required' });
        }

        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const id = await StyleCatalogueService.createCustom({
            name: validationResult.data.name,
            author: validationResult.data.author,
            notes: validationResult.data.notes,
            backgroundBuffer: bgFile?.buffer,
            headerBuffer: headerFile?.buffer,
        });

        const style = await StyleCatalogueService.getById(id);

        // Log activity event
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(req.params.roomId as string, 'style_uploaded', {
            styleId: id,
            styleName: validationResult.data.name,
        }).catch(() => {});

        res.status(201).json({ success: true, style });
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/styles/upload):', error);
        res.status(500).json({ error: error instanceof Error ? error.message : 'Style upload failed' });
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

        const ext = (file.mimetype === 'image/png' || file.mimetype === 'image/apng') ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
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

        const ext = (file.mimetype === 'image/png' || file.mimetype === 'image/apng') ? 'png' : file.mimetype === 'image/webp' ? 'webp' : 'jpg';
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

// Sprint 11 — Anonymous-identity merge admin endpoints (plan §15).
//
// Pending claim queue: active anonymous identities in this room, plus a rough
// Discord-match hint (server nickname ↔ user_mappings.iscored_username).
router.get('/:roomId/admin/identity/queue', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const db = await getDatabase();
        const identities = await db.all(
            `SELECT ai.id, ai.server_nickname, ai.guild_id, ai.first_seen_at, ai.status
             FROM anonymous_identities ai
             WHERE ai.status = 'active' AND (ai.room_id = ? OR ai.room_id IS NULL)
             ORDER BY ai.first_seen_at DESC
             LIMIT 200`,
            roomId,
        );
        const results = await Promise.all(identities.map(async (ai: any) => {
            // Row counts across the 4 score tables for this nickname.
            const csRow = await db.get(
                `SELECT COUNT(*) AS c FROM community_scores
                 WHERE game_room_id = ? AND submitted_by_user_id IS NULL
                   AND merged_from_anonymous_identity_id IS NULL
                   AND LOWER(submitted_by_anonymous_name) = LOWER(?)`,
                roomId, ai.server_nickname,
            );
            // Potential target from user_mappings by nickname.
            const match = await db.get(
                `SELECT discord_user_id, iscored_username, avatar_hash FROM user_mappings
                 WHERE LOWER(iscored_username) = LOWER(?) LIMIT 1`,
                ai.server_nickname,
            );
            return {
                id: ai.id,
                serverNickname: ai.server_nickname,
                guildId: ai.guild_id,
                firstSeenAt: ai.first_seen_at,
                status: ai.status,
                anonymousScoreCount: csRow?.c ?? 0,
                potentialMatch: match ? {
                    discordUserId: match.discord_user_id,
                    username: match.iscored_username,
                    avatarHash: match.avatar_hash,
                } : null,
            };
        }));
        res.json(results);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/queue):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/:roomId/admin/identity/audit', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const { MergeService } = await import('../../services/MergeService.js');
        const records = await MergeService.listMergeHistory(roomId, limit);
        // Enrich with the anonymous nickname + target username for display.
        const db = await getDatabase();
        const enriched = await Promise.all(records.map(async r => {
            const ai = await db.get(`SELECT server_nickname, status FROM anonymous_identities WHERE id = ?`, r.anonymousIdentityId);
            const targetMap = await db.get(`SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?`, r.targetDiscordUserId);
            let summary = { moving: 0, frozen: 0 };
            try {
                const snap = JSON.parse(r.scoreIdsSnapshot) as { submissions?: string[]; community_scores?: number[]; score_history?: number[]; global_scores?: string[]; frozen_tournament_ids_at_merge?: string[] };
                summary.moving = (snap.submissions?.length ?? 0) + (snap.community_scores?.length ?? 0) + (snap.score_history?.length ?? 0) + (snap.global_scores?.length ?? 0);
                summary.frozen = snap.frozen_tournament_ids_at_merge?.length ?? 0;
            } catch { /* bad JSON — report zeros */ }
            return {
                ...r,
                anonymousNickname: ai?.server_nickname ?? null,
                anonymousStatus: ai?.status ?? null,
                targetUsername: targetMap?.iscored_username ?? null,
                summary,
            };
        }));
        res.json(enriched);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/audit):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/identity/preview', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { anonymousIdentityId, targetUserId } = req.body || {};
        if (!Number.isInteger(anonymousIdentityId)) return res.status(400).json({ error: 'anonymousIdentityId (int) required' });
        if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ error: 'targetUserId required' });
        const { MergeService } = await import('../../services/MergeService.js');
        const preview = await MergeService.previewMerge(roomId, anonymousIdentityId, targetUserId);
        res.json(preview);
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'preview failed';
        logError('API Error (POST rooms/:roomId/admin/identity/preview):', error);
        res.status(400).json({ error: msg });
    }
});

router.post('/:roomId/admin/identity/merge', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const { anonymousIdentityId, targetUserId, reason, previewHash } = req.body || {};
        if (!Number.isInteger(anonymousIdentityId)) return res.status(400).json({ error: 'anonymousIdentityId (int) required' });
        if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ error: 'targetUserId required' });
        if (!previewHash || typeof previewHash !== 'string') return res.status(400).json({ error: 'previewHash required' });
        const adminId = req.user?.discordId || req.user?.localAdminId || 'unknown';

        const { MergeService } = await import('../../services/MergeService.js');
        try {
            const out = await MergeService.recordMerge({
                roomId,
                anonymousIdentityId,
                targetDiscordUserId: targetUserId,
                adminDiscordUserId: adminId,
                reason,
                previewHash,
            });
            const { RoomEventService } = await import('../../services/RoomEventService.js');
            RoomEventService.log(roomId, 'identity_merge', {
                mergeId: out.mergeId,
                anonymousIdentityId,
                targetUserId,
                movedRows: out.movedRows,
                reason: reason ?? null,
            }).catch(() => {});
            res.status(201).json(out);
        } catch (err) {
            if (err instanceof Error && (err as Error & { code?: string }).code === 'MERGE_CONFLICT') {
                return res.status(409).json({ error: 'preview drift', fresh: (err as Error & { fresh?: unknown }).fresh });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST rooms/:roomId/admin/identity/merge):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/:roomId/admin/identity/:mergeId/reverse', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const roomId = req.params.roomId as string;
        const mergeId = Number(req.params.mergeId);
        if (!Number.isInteger(mergeId)) return res.status(400).json({ error: 'mergeId must be integer' });
        const adminId = req.user?.discordId || req.user?.localAdminId || 'unknown';
        const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;

        const { MergeService } = await import('../../services/MergeService.js');
        const out = await MergeService.reverseMerge({ mergeId, reversalAdminId: adminId, reason });
        const { RoomEventService } = await import('../../services/RoomEventService.js');
        RoomEventService.log(roomId, 'identity_unmerge', {
            mergeId,
            returnedRows: out.returned,
            stayingRows: out.staying,
            reason: reason ?? null,
        }).catch(() => {});
        res.json(out);
    } catch (error) {
        const msg = error instanceof Error ? error.message : 'reverse failed';
        logError('API Error (POST rooms/:roomId/admin/identity/:mergeId/reverse):', error);
        res.status(400).json({ error: msg });
    }
});

router.get('/:roomId/admin/identity/:mergeId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        const mergeId = Number(req.params.mergeId);
        if (!Number.isInteger(mergeId)) return res.status(400).json({ error: 'mergeId must be integer' });
        const { MergeService } = await import('../../services/MergeService.js');
        const record = await MergeService.getMergeRecord(mergeId);
        if (!record) return res.status(404).json({ error: 'merge record not found' });
        // If unreversed, include a fresh reversal preview to power the drill-down UI.
        let reversalPreview = null;
        if (!record.reversedAt) {
            try {
                reversalPreview = await MergeService.previewReversal(mergeId);
            } catch { /* best effort */ }
        }
        res.json({ record, reversalPreview });
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/identity/:mergeId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
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

// Remove a game from leaderboard (retains scores/history for player records)
router.delete('/:roomId/admin/games/:gameId', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
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

        // Clean up on iScored if the game has an iScored ID
        if (game.iscored_id) {
            const client = new IScoredClient();
            try {
                await client.connect();
                await client.deleteGame(game.iscored_id);
                logInfo(`Deleted game from iScored: ${game.name} (${game.iscored_id})`);
            } catch (err) {
                logError(`Failed to delete game ${gameId} from iScored:`, err);
                // Continue with local deletion even if iScored fails
            } finally {
                await client.disconnect();
            }
        }

        // Delete leaderboard cache only — retain submissions and score_history
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
        await db.run('DELETE FROM games WHERE id = ?', gameId);

        const { LeaderboardService } = await import('../../services/LeaderboardService.js');
        await LeaderboardService.invalidate(gameId);

        const { RoomEventService } = await import('../../services/RoomEventService.js');
        await RoomEventService.log(roomId, 'game_removed', {
            gameName: game.name,
            status: game.status,
            hadIScored: !!game.iscored_id,
            scoresRetained: true,
        });

        logInfo(`Admin removed game from leaderboard: ${game.name} (status: ${game.status}, room: ${roomId}, scores retained)`);
        res.json({ success: true });
    } catch (error: any) {
        logError('API Error (DELETE admin/games/:gameId):', error);
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
