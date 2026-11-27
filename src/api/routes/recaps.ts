import { Router } from 'express';
import { logError } from '../../utils/logger.js';
import { roomVisibilityGate } from '../middleware.js';
import { RunRecapService } from '../../services/RunRecapService.js';
import { RunRollupService } from '../../services/RunRollupService.js';

/**
 * Run recaps, "By the numbers" (B31). Public reads, room-scoped, mounted at
 * `/api` beside `integrityRouter`. Each slice owns the block between its own
 * markers; later slices insert ONLY there (docs/run-recap-plan.md).
 */
const router = Router();

// ===== B31.1: run recap =====
router.get('/rooms/:roomId/runs/:gameId/recap', roomVisibilityGate, async (req, res) => {
    try {
        const recap = await RunRecapService.getRunRecap(req.params.roomId as string, req.params.gameId as string);
        if (!recap) return res.status(404).json({ error: 'Run not found' });
        res.json(recap);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/runs/:gameId/recap):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/rooms/:roomId/runs/:gameId/recap/players/:playerKey', roomVisibilityGate, async (req, res) => {
    try {
        // Express 5 has already decoded the param; decoding again throws on a key with a '%'.
        const playerKey = req.params.playerKey as string;
        const detail = await RunRecapService.getPlayerRunDetail(req.params.roomId as string, req.params.gameId as string, playerKey);
        if (!detail) return res.status(404).json({ error: 'Run not found' });
        res.json(detail);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/runs/:gameId/recap/players/:playerKey):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/rooms/:roomId/tournaments/:tournamentId/runs/live', roomVisibilityGate, async (req, res) => {
    try {
        const live = await RunRecapService.listLiveRuns(req.params.roomId as string, req.params.tournamentId as string);
        if (!live) return res.status(404).json({ error: 'Run not found' });
        res.json(live);
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tournaments/:tournamentId/runs/live):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
// ===== end B31.1 =====


// ===== B31.3: player and table runs (B31.3 inserts here) =====
router.get('/rooms/:roomId/players/:identifier/runs', roomVisibilityGate, async (req, res) => {
    try {
        let identifier: string;
        try { identifier = decodeURIComponent(req.params.identifier as string); } catch { return res.status(404).json({ error: 'Player not found' }); }
        res.json(await RunRollupService.playerRuns(req.params.roomId as string, identifier));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/players/:identifier/runs):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/rooms/:roomId/tables/:gameName/runs', roomVisibilityGate, async (req, res) => {
    try {
        let gameName: string;
        try { gameName = decodeURIComponent(req.params.gameName as string); } catch { return res.status(404).json({ error: 'Table not found' }); }
        res.json(await RunRollupService.tableRuns(req.params.roomId as string, gameName));
    } catch (error) {
        logError('API Error (GET rooms/:roomId/tables/:gameName/runs):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// ===== end B31.3 =====


// ===== B31.4: season recap and room records (B31.4 inserts here) =====
// ===== end B31.4 =====
export default router;
