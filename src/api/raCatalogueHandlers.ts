import { Request, Response } from 'express';
import { logError } from '../utils/logger.js';
import { RAApiClient } from '../services/RAApiClient.js';
import { RAMasterListService } from '../services/RAMasterListService.js';
import {
    RAImportService, RAGameNotFoundError, RAUnsupportedConsoleError,
} from '../services/RAImportService.js';

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

/**
 * Who to record in `global_games.ra_imported_by`.
 *
 * Prefers the Discord/provider identity (stable, and the thing a moderator
 * can act on), falling back to an admin username and finally the local-admin
 * id. Null when none of those exist — the column is nullable and an
 * unattributable import is better than a fabricated actor.
 */
function importerIdentity(req: Request): string | null {
    const user = req.user as
        | { discordId?: string; username?: string; localAdminId?: string }
        | undefined;
    if (!user) return null;
    return user.discordId || user.username || user.localAdminId || null;
}

/**
 * `POST .../ra-catalogue/import/:raGameId`
 *
 * Shared by all three surfaces. The middleware in front differs (room admin,
 * super-admin, or any logged-in identity plus a 5/hour cap); what happens
 * after does not — one service path, so "the admin import" and "the player
 * import" cannot drift apart.
 *
 * Synchronous: returns the created or enriched catalogue row, so the caller
 * can drop the user straight onto it without a refetch.
 */
export async function raImportHandler(req: Request, res: Response): Promise<void> {
    const raGameId = Number(req.params.raGameId);
    if (!Number.isInteger(raGameId) || raGameId <= 0) {
        res.status(400).json({ error: 'A numeric RetroAchievements game id is required.' });
        return;
    }

    if (!RAApiClient.isConfigured()) {
        // 400 with something actionable, not a 500 from the constructor —
        // same discipline as the OPDB/IGDB sync routes.
        res.status(400).json({
            error: 'RetroAchievements import is not configured on this server. ' +
                'A super-admin must set RA_API_KEY under Global Settings → Configuration.',
        });
        return;
    }

    try {
        const result = await RAImportService.importGame(raGameId, {
            importedBy: importerIdentity(req),
        });

        res.json({
            success: true,
            action: result.action,
            raGameId: result.raGameId,
            scoreEligibility: result.scoreEligibility,
            leaderboardCount: result.leaderboardCount,
            game: result.game,
            attribution: RA_ATTRIBUTION,
        });
    } catch (error) {
        if (error instanceof RAGameNotFoundError) {
            res.status(404).json({ error: error.message });
            return;
        }
        if (error instanceof RAUnsupportedConsoleError) {
            res.status(422).json({ error: error.message });
            return;
        }
        logError(`API Error (POST ra-catalogue/import/${raGameId}):`, error);
        res.status(500).json({
            error: 'The RetroAchievements import failed. Please try again in a moment.',
        });
    }
}
