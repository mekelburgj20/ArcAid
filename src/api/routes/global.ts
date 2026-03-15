import { Router } from 'express';
import { logError } from '../../utils/logger.js';
import { requireAuth } from '../middleware.js';
import { validate } from '../validate.js';
import { UpdatePreferencesSchema } from '../schemas.js';
import { SettingsService } from '../../services/SettingsService.js';
import { GameRoomService } from '../../services/GameRoomService.js';

const router = Router();

// System status
router.get('/status', async (req, res) => {
    try {
        const isSetup = await SettingsService.isSetupComplete();
        res.json({
            status: 'online',
            needsSetup: !isSetup
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
