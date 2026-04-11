import { Router } from 'express';
import multer from 'multer';
import { logError, logInfo } from '../../utils/logger.js';
import { requireAuth, requireDiscordUser } from '../middleware.js';
import { writeLimiter } from '../rateLimit.js';
import { validate } from '../validate.js';
import { UpdatePreferencesSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { GlobalGameService } from '../../services/GlobalGameService.js';
import { GlobalScoreService } from '../../services/GlobalScoreService.js';
import { GlobalLeaderboardService } from '../../services/GlobalLeaderboardService.js';
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
 * GET /api/global/scoreboard — top games by aggregate score activity.
 * Query params: ?sort=most_scores|highest_score|most_recent&scope=global|<roomId>&limit=20
 */
router.get('/global/scoreboard', async (req, res) => {
    try {
        const sort = (req.query.sort as 'most_scores' | 'highest_score' | 'most_recent') || 'most_scores';
        const scope = (req.query.scope as string) || 'global';
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

        const games = await GlobalLeaderboardService.getTopGames({ sort, scope, limit });
        res.json({ data: games });
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
 * POST /api/global/scores — direct global score submission.
 * Requires Discord login, photo, and a valid approved global_game_id.
 * Body: multipart/form-data with { globalGameId, score, excludeFromGlobal?, photo }
 */
router.post('/global/scores', writeLimiter, requireDiscordUser, globalScoreUpload.single('photo'), async (req, res) => {
    try {
        const globalGameId = req.body.globalGameId;
        const scoreRaw = req.body.score;
        const excludeFromGlobal = req.body.excludeFromGlobal === 'true' || req.body.excludeFromGlobal === true;

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

        const game = await GlobalGameService.getById(globalGameId);
        if (!game || game.status !== 'approved') {
            return res.status(404).json({ error: 'Game not found' });
        }

        // Resolve the iscored username / display name for the logged-in Discord user
        const db = await getDatabase();
        const mapping = await db.get(
            'SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?',
            req.user!.discordId
        );
        const iscoredUsername = mapping?.iscored_username || req.user!.discordId || 'Unknown';

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

export default router;
