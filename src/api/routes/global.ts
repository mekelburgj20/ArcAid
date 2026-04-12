import { Router } from 'express';
import multer from 'multer';
import { logError, logInfo } from '../../utils/logger.js';
import { requireAuth, requireDiscordUser } from '../middleware.js';
import { writeLimiter, globalSubmitLimiter } from '../rateLimit.js';
import { validate } from '../validate.js';
import { UpdatePreferencesSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { GlobalGameService } from '../../services/GlobalGameService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { GlobalLeaderboardService } from '../../services/GlobalLeaderboardService.js';
import { GlobalRatingService } from '../../services/GlobalRatingService.js';
import { GlobalCommentService } from '../../services/GlobalCommentService.js';
import { emitScoreNewGlobal } from '../websocket.js';
import { getDatabase } from '../../database/database.js';

const router = Router();

const globalScoreUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 }, // 30MB — matches room submission cap
    fileFilter: (_req, file, cb) => {
        const ok = ['image/png', 'image/apng', 'image/jpeg', 'image/webp'].includes(file.mimetype);
        if (ok) return cb(null, true);
        cb(new Error('Only PNG, APNG, JPEG, or WebP images allowed.'));
    },
});

// System status — comprehensive health check
router.get('/status', async (req, res) => {
    try {
        const isSetup = await SettingsService.isSetupComplete();
        const checks: Record<string, { status: string; detail?: string }> = {};

        // Database check
        try {
            const db = await getDatabase();
            const row = await db.get('SELECT COUNT(*) as count FROM game_rooms');
            checks.database = { status: 'ok', detail: `${row?.count ?? 0} room(s)` };
        } catch (err) {
            checks.database = { status: 'error', detail: err instanceof Error ? err.message : 'unknown' };
        }

        // Discord bot check
        const hasDiscord = !!(process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID);
        checks.discord = hasDiscord
            ? { status: 'ok', detail: 'configured' }
            : { status: 'unconfigured', detail: 'credentials not set' };

        // iScored check
        const hasIScored = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
        checks.iscored = hasIScored
            ? { status: 'ok', detail: 'configured' }
            : { status: 'unconfigured', detail: 'credentials not set' };

        // Overall status
        const hasError = Object.values(checks).some(c => c.status === 'error');

        res.json({
            status: hasError ? 'degraded' : 'online',
            needsSetup: !isSetup,
            uptime: Math.floor(process.uptime()),
            checks,
        });
    } catch (error) {
        logError('API Error (/api/status):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// User preferences
router.get('/me/preferences', requireAuth, async (req, res) => {
    try {
        const userId = req.user!.discordId || req.user!.localAdminId || 'admin-password';
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const prefs = await PreferencesService.getAll(userId);
        res.json(prefs);
    } catch (error) {
        logError('API Error (GET /api/me/preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/preferences', requireAuth, async (req, res) => {
    try {
        const validationResult = validate(UpdatePreferencesSchema, req.body);
        if ('error' in validationResult) return res.status(400).json({ error: validationResult.error });

        const userId = req.user!.discordId || req.user!.localAdminId || 'admin-password';
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        await PreferencesService.setTheme(userId, validationResult.data.ui_theme);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (POST /api/me/preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Scoreboard display preferences (per-user overrides for room defaults)
router.get('/me/scoreboard-preferences', requireDiscordUser, async (req, res) => {
    try {
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const prefs = await PreferencesService.getScoreboardPrefs(req.user!.discordId!);
        res.json(prefs);
    } catch (error) {
        logError('API Error (GET /api/me/scoreboard-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.post('/me/scoreboard-preferences', requireDiscordUser, async (req, res) => {
    try {
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Body must be a JSON object of preference keys' });
        }
        const { PreferencesService } = await import('../../services/PreferencesService.js');
        const merged = await PreferencesService.setScoreboardPrefs(req.user!.discordId!, req.body);
        res.json(merged);
    } catch (error) {
        logError('API Error (POST /api/me/scoreboard-preferences):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Public Invite Endpoints ---

// Get invite info (no auth)
router.get('/invite/:token', async (req, res) => {
    try {
        const { AdminService } = await import('../../services/AdminService.js');
        const invite = await AdminService.getInviteByToken(req.params.token as string);
        if (!invite) return res.status(404).json({ error: 'Invite not found' });
        if (invite.accepted_at) return res.status(410).json({ error: 'This invite has already been used' });
        if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'This invite has expired' });

        const { GameRoomService } = await import('../../services/GameRoomService.js');
        const room = await GameRoomService.getById(invite.game_room_id);

        res.json({
            display_name: invite.display_name,
            room_name: room?.name || 'Unknown Room',
            room_slug: room?.slug || '',
            expires_at: invite.expires_at,
        });
    } catch (error) {
        logError('API Error (GET /api/invite/:token):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Accept invite (no auth)
router.post('/invite/:token/accept', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || typeof username !== 'string' || username.trim().length === 0) {
            return res.status(400).json({ error: 'Username is required' });
        }
        if (!password || typeof password !== 'string' || password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters' });
        }

        const { AdminService } = await import('../../services/AdminService.js');
        const admin = await AdminService.acceptInvite(req.params.token as string, username.trim(), password);

        // Get room slug for redirect
        const { GameRoomService } = await import('../../services/GameRoomService.js');
        const room = await GameRoomService.getById(admin.game_room_id);

        res.json({ success: true, room_slug: room?.slug || '' });
    } catch (error: any) {
        if (error.message === 'Invite not found') return res.status(404).json({ error: error.message });
        if (error.message === 'Invite already used') return res.status(410).json({ error: error.message });
        if (error.message === 'Invite expired') return res.status(410).json({ error: error.message });
        if (error.message === 'Username already exists for this room') return res.status(409).json({ error: error.message });
        logError('API Error (POST /api/invite/:token/accept):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- Style Catalogue (read-only, requires auth) ---
router.get('/styles', requireAuth, async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const result = await StyleCatalogueService.search(q, limit, offset);
        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/styles):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/styles/:id', requireAuth, async (req, res) => {
    try {
        const { StyleCatalogueService } = await import('../../services/StyleCatalogueService.js');
        const style = await StyleCatalogueService.getById(req.params.id as string);
        if (!style) return res.status(404).json({ error: 'Style not found' });
        res.json(style);
    } catch (error) {
        logError('API Error (GET /api/styles/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Portal info by slug (public — used by Scoreboard, GameAvailability, etc.)
router.get('/portal', async (req, res) => {
    try {
        const slug = req.query.slug as string;
        if (!slug) return res.status(400).json({ error: 'slug query parameter is required' });
        const room = await GameRoomService.getBySlug(slug);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');
        const uiTheme = await GameRoomSettingsService.get(room.id, 'UI_THEME');
        const adminTheme = await GameRoomSettingsService.get(room.id, 'ADMIN_THEME');
        res.json({
            id: room.id,
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            admin_theme: adminTheme || 'dark',
            is_public: !!room.is_public,
        });
    } catch (error) {
        logError('API Error (GET /api/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public room listing with stats
router.get('/rooms', async (req, res) => {
    try {
        const rooms = await GameRoomService.getPublic();
        const db = await getDatabase();
        const { GameRoomSettingsService } = await import('../../services/GameRoomSettingsService.js');

        const enriched = await Promise.all(rooms.map(async (room) => {
            // Count active games (games → tournaments → room)
            const activeGames = await db.get(
                `SELECT COUNT(*) as count FROM games g
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE t.game_room_id = ? AND g.status = 'ACTIVE'`,
                room.id
            );
            // Count unique players
            const activePlayers = await db.get(
                `SELECT COUNT(DISTINCT LOWER(s.iscored_username)) as count FROM submissions s
                 JOIN games g ON s.game_id = g.id
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE t.game_room_id = ?`,
                room.id
            );
            const discordInvite = await GameRoomSettingsService.get(room.id, 'DISCORD_INVITE_URL');
            const logoUrl = room.logo_url || null;

            return {
                ...room,
                logo_url: logoUrl,
                activeGames: activeGames?.count || 0,
                activePlayers: activePlayers?.count || 0,
                discordInviteUrl: discordInvite || null,
            };
        }));

        res.json(enriched);
    } catch (error) {
        logError('API Error (GET /api/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ============================================================================
// Global Scoreboard + Catalogue (public, no auth needed for reads)
// ============================================================================

/**
 * GET /api/global/games — search/browse the global catalogue.
 * Cursor-based pagination, 20 per page.
 * Query params: ?search=&type=&platforms=vpx,vpxs&status=approved&cursor=xxx&limit=20
 */
router.get('/global/games', async (req, res) => {
    try {
        const search = (req.query.search as string) || '';
        const type = (req.query.type as string) || undefined;
        const platformsRaw = (req.query.platforms as string) || '';
        const status = (req.query.status as string) || 'approved';
        const cursor = (req.query.cursor as string) || undefined;
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

        const platforms = platformsRaw
            ? platformsRaw.split(',').map(p => p.trim()).filter(Boolean)
            : undefined;

        const result = await GlobalGameService.search(search, {
            type,
            platforms,
            status,
            limit,
            cursor,
        });

        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/global/games):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/games/:id — single game detail (full metadata).
 */
router.get('/global/games/:id', async (req, res) => {
    try {
        const game = await GlobalGameService.getById(req.params.id as string);
        if (!game) return res.status(404).json({ error: 'Game not found' });
        if (game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // Parse JSON fields so clients don't have to
        const parsed = {
            ...game,
            platforms: JSON.parse(game.platforms || '[]'),
            themes: JSON.parse(game.themes || '[]'),
            designers: JSON.parse(game.designers || '[]'),
            features: JSON.parse(game.features || '[]'),
            table_authors: JSON.parse(game.table_authors || '[]'),
            table_download_urls: game.table_download_urls ? JSON.parse(game.table_download_urls) : [],
            tutorial_urls: game.tutorial_urls ? JSON.parse(game.tutorial_urls) : [],
            rules_urls: game.rules_urls ? JSON.parse(game.rules_urls) : [],
        };

        res.json(parsed);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/recent-scores — lightweight feed of recent global scores
 * with game name + image for the landing page ticker. No auth required.
 * Returns up to 20 entries.
 */
router.get('/global/recent-scores', async (req, res) => {
    try {
        const db = await getDatabase();
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
        const rows = await db.all(`
            SELECT
                gs.id,
                gs.score,
                gs.iscored_username,
                gs.submitted_at,
                gs.player_id as discord_user_id,
                gg.id as global_game_id,
                gg.name as game_name,
                gg.display_name,
                gg.local_image_path,
                gg.wheel_image_path,
                gg.image_url,
                um.avatar_hash
            FROM global_scores gs
            JOIN global_games gg ON gg.id = gs.global_game_id
            LEFT JOIN user_mappings um ON (
                um.discord_user_id = gs.player_id
                OR LOWER(um.iscored_username) = LOWER(gs.iscored_username)
            )
            WHERE gs.deleted_at IS NULL
              AND gs.exclude_from_global = 0
            GROUP BY gs.id
            ORDER BY gs.submitted_at DESC
            LIMIT ?
        `, limit);
        res.json(rows);
    } catch (error) {
        logError('API Error (GET /api/global/recent-scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/scoreboard — paginated catalogue + per-game score aggregates.
 * All catalogue games appear, even with zero scores. Default sort is `popular`
 * (recency-weighted score count). Query params:
 *   ?sort=popular|most_scores|highest_rated|most_recent|name_asc
 *   &scope=global|<roomId>
 *   &limit=30&offset=0
 *   &search=&type=&platforms=vpx,real,...
 */
router.get('/global/scoreboard', async (req, res) => {
    try {
        const sort = (req.query.sort as 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc') || 'popular';
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 30, 200);
        const offset = parseInt(req.query.offset as string) || 0;
        const search = (req.query.search as string) || undefined;
        const type = (req.query.type as string) || undefined;
        const platformsRaw = (req.query.platforms as string) || '';
        const platforms = platformsRaw
            ? platformsRaw.split(',').map(p => p.trim()).filter(Boolean)
            : undefined;

        const result = await GlobalLeaderboardService.getTopGames({
            sort, scope, limit, offset, search, type, platforms,
        });

        // Enrich each game with top 5 leaderboard entries for card previews
        const gameIds = result.data.map((g: any) => g.global_game_id);
        const topScores = await GlobalLeaderboardService.getTopScoresForGames(gameIds, 5, scope);
        const enriched = result.data.map((g: any) => ({
            ...g,
            top_scores: topScores[g.global_game_id] || [],
        }));

        res.json({ ...result, data: enriched });
    } catch (error) {
        logError('API Error (GET /api/global/scoreboard):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/scoreboard/:globalGameId — full leaderboard for a single game.
 * Query params: ?scope=global|<roomId>&offset=0&limit=50
 */
router.get('/global/scoreboard/:globalGameId', async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        const offset = parseInt(req.query.offset as string) || 0;

        const game = await GlobalGameService.getById(globalGameId);
        if (!game) return res.status(404).json({ error: 'Game not found' });

        const rankings = await GlobalLeaderboardService.getForGame(globalGameId, scope);
        const paged = rankings.slice(offset, offset + limit);

        res.json({
            game: {
                id: game.id,
                name: game.display_name || game.name,
                manufacturer: game.manufacturer,
                year: game.year,
                type: game.type,
                image_url: game.local_image_path || game.image_url,
            },
            data: paged,
            total: rankings.length,
            hasMore: offset + limit < rankings.length,
        });
    } catch (error) {
        logError('API Error (GET /api/global/scoreboard/:globalGameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/me/display-name — returns the Discord user's saved display
 * name (iscored_username in user_mappings), or null if they've never set one.
 * Used by the submit modal to pre-fill the display-name field.
 */
router.get('/global/me/display-name', requireDiscordUser, async (req, res) => {
    try {
        const db = await getDatabase();
        const mapping = await db.get(
            'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
            req.user!.discordId
        );
        res.json({ displayName: mapping?.iscored_username || null });
    } catch (error) {
        logError('API Error (GET /api/global/me/display-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/scores — direct global score submission.
 * Requires Discord login, photo, and a valid approved global_game_id.
 * Body: multipart/form-data with { globalGameId, score, displayName, excludeFromGlobal?, photo }
 *
 * `displayName` is the name shown on the scoreboard. If omitted, falls back
 * through user_mappings → Discord username → discordId. When provided, it is
 * persisted to user_mappings so future submissions default to it.
 */
router.post('/global/scores', requireDiscordUser, globalSubmitLimiter, globalScoreUpload.single('photo'), async (req, res) => {
    try {
        const globalGameId = req.body.globalGameId;
        const scoreRaw = req.body.score;
        const excludeFromGlobal = req.body.excludeFromGlobal === 'true' || req.body.excludeFromGlobal === true;
        const displayNameRaw = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';

        if (!globalGameId || typeof globalGameId !== 'string') {
            return res.status(400).json({ error: 'globalGameId is required' });
        }
        const score = parseInt(scoreRaw, 10);
        if (!Number.isFinite(score) || score < 0) {
            return res.status(400).json({ error: 'A valid non-negative score is required' });
        }
        if (!req.file) {
            return res.status(400).json({ error: 'A photo is required with global score submissions.' });
        }
        if (displayNameRaw.length > 50) {
            return res.status(400).json({ error: 'Display name must be 50 characters or fewer.' });
        }

        const game = await GlobalGameService.getById(globalGameId);
        if (!game || game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // Resolve the iscored username / display name for the logged-in Discord user.
        // Precedence: explicit form field > existing user_mappings row > Discord
        // username from the JWT > raw discordId (legacy fallback).
        const db = await getDatabase();
        let iscoredUsername = displayNameRaw;
        if (!iscoredUsername) {
            const mapping = await db.get(
                'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
                req.user!.discordId
            );
            iscoredUsername = mapping?.iscored_username || req.user!.username || req.user!.discordId || 'Unknown';
        }

        // Persist the display name so future submissions pre-fill with it.
        // `user_mappings.iscored_username` has a UNIQUE index — if this name is
        // already taken by a different Discord user, reject before the INSERT
        // would fail, returning a clear 409 instead of a cryptic DB error.
        if (displayNameRaw && req.user!.discordId) {
            const clash = await db.get<{ discord_user_id: string }>(
                `SELECT discord_user_id FROM user_mappings
                 WHERE LOWER(iscored_username) = LOWER(?) AND discord_user_id != ?`,
                displayNameRaw, req.user!.discordId
            );
            if (clash) {
                return res.status(409).json({ error: 'That display name is already taken. Pick another.' });
            }
            await db.run(
                `INSERT INTO user_mappings (discord_user_id, iscored_username)
                 VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET iscored_username = excluded.iscored_username`,
                req.user!.discordId, displayNameRaw
            );
        }

        try {
            const saved = await GlobalScoreService.submit({
                globalGameId,
                playerId: req.user!.discordId!,
                iscoredUsername,
                score,
                photoBuffer: req.file.buffer,
                photoMimeType: req.file.mimetype,
                originType: 'global',
                excludeFromGlobal,
            });

            emitScoreNewGlobal({
                globalGameId,
                gameName: game.display_name || game.name,
                playerName: iscoredUsername,
                score,
            });

            res.status(201).json(saved);
        } catch (err: any) {
            if (err?.message === 'BANNED') {
                return res.status(403).json({ error: 'Your account is banned from submitting global scores.' });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST /api/global/scores):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/me/global-scores/:scoreId — user deletes one of their own scores.
 * Soft-delete only; the row stays for audit/restore. Verifies the authenticated
 * Discord user owns the score before delegating to GlobalScoreService.softDelete.
 */
router.delete('/me/global-scores/:scoreId', requireDiscordUser, async (req, res) => {
    try {
        const scoreId = req.params.scoreId as string;
        const score = await GlobalScoreService.getById(scoreId);
        if (!score || score.deleted_at) {
            return res.status(404).json({ error: 'Score not found' });
        }
        if (score.player_id !== req.user!.discordId) {
            return res.status(403).json({ error: 'You can only delete your own scores' });
        }
        const ok = await GlobalScoreService.softDelete(scoreId, req.user!.discordId!);
        if (!ok) return res.status(404).json({ error: 'Score not found' });
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/me/global-scores/:scoreId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/me/global-scores/game/:globalGameId — delete ALL of the
 * authenticated user's scores for a specific game (soft-delete).
 */
router.delete('/me/global-scores/game/:globalGameId', requireDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.globalGameId as string;
        const discordId = req.user!.discordId!;
        const db = (await import('../../database/database.js')).getDatabase;
        const dbConn = await db();

        const scores = await dbConn.all(
            `SELECT id FROM global_scores WHERE global_game_id = ? AND player_id = ? AND deleted_at IS NULL`,
            globalGameId, discordId
        );
        if (scores.length === 0) {
            return res.status(404).json({ error: 'No scores found' });
        }

        for (const s of scores) {
            await GlobalScoreService.softDelete(s.id, discordId);
        }

        res.json({ success: true, deleted: scores.length });
    } catch (error) {
        logError('API Error (DELETE /api/me/global-scores/game/:globalGameId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/scores/:scoreId/report — flag a score.
 * Rate-limited via writeLimiter, requires Discord login.
 */
router.post('/global/scores/:scoreId/report', writeLimiter, requireDiscordUser, async (req, res) => {
    try {
        const scoreId = req.params.scoreId as string;
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 500) : null;

        const db = await getDatabase();
        const score = await db.get('SELECT id FROM global_scores WHERE id = ? AND deleted_at IS NULL', scoreId);
        if (!score) return res.status(404).json({ error: 'Score not found' });

        // Don't let a user report the same score twice while a prior report is open
        const existing = await db.get(
            `SELECT id FROM score_reports
             WHERE score_id = ? AND reporter_discord_id = ? AND resolved_at IS NULL`,
            scoreId, req.user!.discordId
        );
        if (existing) {
            return res.status(409).json({ error: 'You have already reported this score.' });
        }

        const crypto = await import('crypto');
        const reportId = crypto.randomUUID();
        await db.run(
            `INSERT INTO score_reports (id, score_id, reporter_discord_id, reason)
             VALUES (?, ?, ?, ?)`,
            reportId, scoreId, req.user!.discordId, reason
        );

        logInfo(`Score ${scoreId} reported by ${req.user!.discordId}`);
        res.status(201).json({ id: reportId });
    } catch (error) {
        logError('API Error (POST /api/global/scores/:scoreId/report):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Global Game Ratings ───

/**
 * GET /api/global/games/:id/rating — get avg rating + optional user rating
 */
router.get('/global/games/:id/rating', async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        // Optionally accept a Discord user via Authorization header
        let discordUserId: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) discordUserId = payload.discordId;
            } catch { /* no valid token — fine, just skip user rating */ }
        }
        const info = await GlobalRatingService.getGameRating(globalGameId, discordUserId);
        res.json(info);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id/rating):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/games/:id/rating — set user's rating (1-5). Requires Discord login.
 */
router.post('/global/games/:id/rating', requireDiscordUser, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const rating = parseInt(req.body.rating, 10);
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be 1-5' });
        }
        await GlobalRatingService.setRating(globalGameId, req.user!.discordId!, rating);
        const info = await GlobalRatingService.getGameRating(globalGameId, req.user!.discordId!);
        res.json(info);
    } catch (error) {
        logError('API Error (POST /api/global/games/:id/rating):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/global/ratings — bulk ratings for scoreboard page.
 * Optionally includes user ratings if Bearer token provided.
 */
router.get('/global/ratings', async (req, res) => {
    try {
        let discordUserId: string | undefined;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
            try {
                const { verifyToken } = await import('../auth.js');
                const payload = verifyToken(authHeader.slice(7));
                if (payload?.discordId) discordUserId = payload.discordId;
            } catch { /* skip user ratings */ }
        }
        const result = await GlobalRatingService.getBulkRatings(discordUserId);
        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/global/ratings):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ─── Global Game Comments ───

/**
 * GET /api/global/games/:id/comments — get comments/tips for a global game.
 * Query params: ?type=comment|tip
 */
router.get('/global/games/:id/comments', async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const type = req.query.type as 'comment' | 'tip' | undefined;
        const comments = await GlobalCommentService.getComments(globalGameId, type);
        res.json(comments);
    } catch (error) {
        logError('API Error (GET /api/global/games/:id/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/global/games/:id/comments — add a comment or tip. Requires Discord login.
 */
router.post('/global/games/:id/comments', requireDiscordUser, writeLimiter, async (req, res) => {
    try {
        const globalGameId = req.params.id as string;
        const { type, body, display_name } = req.body;
        if (!type || !['comment', 'tip'].includes(type)) {
            return res.status(400).json({ error: 'type must be "comment" or "tip"' });
        }
        if (!body || typeof body !== 'string' || body.length < 1 || body.length > 500) {
            return res.status(400).json({ error: 'body must be 1-500 characters' });
        }
        if (!display_name || typeof display_name !== 'string' || display_name.length < 1 || display_name.length > 50) {
            return res.status(400).json({ error: 'display_name must be 1-50 characters' });
        }
        const comment = await GlobalCommentService.addComment(
            globalGameId, req.user!.discordId!, display_name, type, body
        );
        res.status(201).json(comment);
    } catch (error) {
        logError('API Error (POST /api/global/games/:id/comments):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/global/games/:id/comments/:commentId — delete own comment. Requires Discord login.
 */
router.delete('/global/games/:id/comments/:commentId', requireDiscordUser, async (req, res) => {
    try {
        const commentId = parseInt(req.params.commentId as string, 10);
        const comment = await GlobalCommentService.getCommentById(commentId);
        if (!comment) return res.status(404).json({ error: 'Comment not found' });
        if (comment.discord_user_id !== req.user!.discordId) {
            return res.status(403).json({ error: 'Not authorized' });
        }
        await GlobalCommentService.deleteComment(commentId);
        res.json({ success: true });
    } catch (error) {
        logError('API Error (DELETE /api/global/games/:id/comments/:commentId):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
