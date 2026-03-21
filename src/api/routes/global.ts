import { Router } from 'express';
import { logError } from '../../utils/logger.js';
import { requireAuth } from '../middleware.js';
import { validate } from '../validate.js';
import { UpdatePreferencesSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';
import { getDatabase } from '../../database/database.js';

const router = Router();

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
        res.json({
            id: room.id,
            slug: room.slug,
            name: room.name,
            description: room.description || '',
            logo_url: room.logo_url || null,
            ui_theme: uiTheme || 'dark',
            is_public: !!room.is_public,
        });
    } catch (error) {
        logError('API Error (GET /api/portal):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Public room listing
router.get('/rooms', async (req, res) => {
    try {
        const rooms = await GameRoomService.getPublic();
        res.json(rooms);
    } catch (error) {
        logError('API Error (GET /api/rooms):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
