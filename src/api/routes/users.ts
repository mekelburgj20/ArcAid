import { Router } from 'express';
import { requireAuth, requireDiscordUser, requireNotBanned } from '../middleware.js';
import { UserProfileService } from '../../services/UserProfileService.js';
import { LeaderboardService } from '../../services/LeaderboardService.js';
import { GlobalLeaderboardService } from '../../services/GlobalLeaderboardService.js';
import { logError } from '../../utils/logger.js';

const router = Router();

/**
 * GET /api/users/me/profile
 * Returns the logged-in Discord user's profile: chosen display_name, cached
 * avatar_hash, and the iScored aliases linked to this account. The Account
 * Settings page reads this on mount.
 */
router.get('/me/profile', requireAuth, requireDiscordUser, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const profile = await UserProfileService.ensureProfile(discordId);
        const aliases = await UserProfileService.getAliases(discordId);
        res.json({
            discord_user_id: profile.discord_user_id,
            display_name: profile.display_name,
            avatar_hash: profile.avatar_hash,
            avatar_url: profile.avatar_url,
            avatar_fetched_at: profile.avatar_fetched_at,
            aliases,
        });
    } catch (error) {
        logError('API Error (GET /api/users/me/profile):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * PATCH /api/users/me/profile
 * Updates the user's display_name. Body: `{ display_name: string | null }`.
 * Surfaces UserProfileService validation errors as 409 with a structured
 * `reason` (`too_short`, `too_long`, `taken_display`, `taken_alias`,
 * `invalid_chars`) so the FE can render targeted copy.
 */
router.patch('/me/profile', requireAuth, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const raw = req.body?.display_name;
        if (raw !== null && typeof raw !== 'string') {
            return res.status(400).json({ error: 'display_name must be a string or null' });
        }
        const next = await UserProfileService.setDisplayName(discordId, raw);
        // Display name change ripples through every leaderboard render.
        await LeaderboardService.invalidateAll();
        await GlobalLeaderboardService.invalidateAll();
        res.json({ display_name: next });
    } catch (error) {
        const e = error as Error & { code?: string; reason?: string };
        if (e.code === 'DISPLAY_NAME_TAKEN') {
            return res.status(409).json({ error: 'Display name not available', reason: e.reason });
        }
        // S22 Phase 1 (v2.43.0) — blocklist rejection from UserProfileService.setDisplayName.
        if (e.code === 'NAME_NOT_ALLOWED') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        logError('API Error (PATCH /api/users/me/profile):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/users/me/profile/check-display-name?name=...
 * Debounced availability check — read-only, no mutation. Returns
 * `{ available: boolean, reason?: string }` so the FE can render an inline
 * error before the user submits.
 */
router.get('/me/profile/check-display-name', requireAuth, requireDiscordUser, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const name = String(req.query.name ?? '');
        const result = await UserProfileService.checkDisplayNameAvailability(discordId, name);
        res.json(result);
    } catch (error) {
        logError('API Error (GET /api/users/me/profile/check-display-name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
