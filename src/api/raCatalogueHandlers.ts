import { Request, Response } from 'express';
import { logError } from '../utils/logger.js';
import { RAApiClient } from '../services/RAApiClient.js';
import { RAMasterListService } from '../services/RAMasterListService.js';

/**
 * Shared handlers for the RetroAchievements catalogue endpoints (contract §2/§3).
 *
 * The same search and the same import are exposed on THREE surfaces —
 * room-admin (`/api/rooms/:roomId/ra-catalogue/*`), super-admin
 * (`/api/admin/ra-catalogue/*`) and public/player
 * (`/api/global/ra-catalogue/*`) — because demand comes from all three and the
 * contract requires each to work. They differ ONLY in the middleware in front
 * of them, so the handler bodies live here once. Triplicating them in
 * rooms.ts/admin.ts/global.ts is exactly how three surfaces drift into three
 * slightly different behaviours.
 */

/**
 * Community attribution, shipped with every search response so the UI has no
 * excuse to omit it. Not legally required (RA's data is freely published) —
 * it is courtesy to a volunteer-run project whose index we are searching.
 */
const RA_ATTRIBUTION = {
    source: 'RetroAchievements',
    url: 'https://retroachievements.org',
    label: 'Data from RetroAchievements',
} as const;

/**
 * `GET .../ra-catalogue/search?q=<query>&limit=<n>`
 *
 * Searches the LOCAL master list (`ra_games`), never RA itself — RA has no
 * search endpoint, and hitting their API per keystroke is precisely what
 * their fair-use guidance asks callers not to do.
 *
 * A missing/blank `q` answers 200 with an empty result set rather than 400: a
 * search box legitimately fires with an empty value while the user clears it,
 * and the freshness envelope is still useful in that state.
 */
export async function raSearchHandler(req: Request, res: Response): Promise<void> {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q : '';
        const limitRaw = Number(req.query.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 25;

        // Lazy refresh gate. Fire-and-forget — see `ensureFresh`; a cold table
        // reports `syncing: true` so the UI can say the index is building
        // rather than "no results".
        const masterList = await RAMasterListService.ensureFresh();

        const results = q.trim() ? await RAMasterListService.search(q, limit) : [];

        res.json({
            results,
            masterList,
            configured: RAApiClient.isConfigured(),
            attribution: RA_ATTRIBUTION,
        });
    } catch (error) {
        logError('API Error (GET ra-catalogue/search):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}
