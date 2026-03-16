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
