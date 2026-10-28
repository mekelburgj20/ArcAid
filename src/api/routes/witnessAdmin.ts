import { Router } from 'express';
import { logError } from '../../utils/logger.js';
import { requireAuth, requireRoomAccess } from '../middleware.js';
import { WitnessAdminViewService } from '../../services/WitnessAdminViewService.js';

/**
 * The runner's live device view (v2.187.0, W5): every paired Witness device of
 * a room's members (or direct entrants), with online / last check-in / open
 * table / where its scores go, plus each event lobby's counts. Room admins
 * only (`requireRoomAccess`); read-only, so no audit row. Mounted at `/api`
 * beside `integrityRouter`.
 */
const router = Router();

router.get('/rooms/:roomId/admin/witness/devices', requireAuth, requireRoomAccess('roomId'), async (req, res) => {
    try {
        res.json(await WitnessAdminViewService.roomDevices(req.params.roomId as string));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/admin/witness/devices):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
