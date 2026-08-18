import { Router } from 'express';
import { requireAuth, requireDiscordUser, requireNotBanned } from '../middleware.js';
import { UserProfileService } from '../../services/UserProfileService.js';
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
        const avatar = await UserProfileService.getAvatarOptions(discordId);
        res.json({
            discord_user_id: profile.discord_user_id,
            display_name: profile.display_name,
            avatar_hash: profile.avatar_hash,
            avatar_url: profile.avatar_url,
            avatar_fetched_at: profile.avatar_fetched_at,
            aliases,
            // Migration 151 — the raw per-provider avatars plus the user's
            // choice, so Account Settings can render a real picker instead of
            // silently showing whichever provider the resolver happens to
            // prefer. `avatar_url` above stays the EFFECTIVE one.
            avatar_preference: avatar.preference,
            avatar_effective: avatar.effective,
            avatar_discord_hash: avatar.discordAvatarHash,
            avatar_google_url: avatar.googleAvatarUrl,
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
        // v2.74.0 (S24.1): no cache invalidation here any more. Leaderboard
        // caches hold identity-stable rows and join `user_profiles` at READ
        // time, so the new name is live on the next render. The two
        // `invalidateAll()` calls this replaces were whole-table DELETEs of
        // every room's leaderboard — one rename made the next page load
        // serially recalculate every game in the system.
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

/**
 * PATCH /api/users/me/avatar-preference
 * Body: `{ preference: 'discord' | 'google' | null }` — `null` restores the
 * automatic behavior (Google when present).
 *
 * Exists because `PlayerAvatar` resolves `avatarUrl ?? avatarHash`, so a user
 * linked to both providers had their Discord avatar permanently buried by
 * their Google picture with no way to get it back (player report 2026-08-17).
 * The preference is applied by rewriting the EFFECTIVE `avatar_url` column —
 * see migration 151 — so no read site has to know this endpoint exists.
 */
router.patch('/me/avatar-preference', requireAuth, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const raw = req.body?.preference;
        if (raw !== null && raw !== 'discord' && raw !== 'google') {
            return res.status(400).json({ error: "preference must be 'discord', 'google', or null" });
        }

        const result = await UserProfileService.setAvatarPreference(discordId, raw);
        const avatar = await UserProfileService.getAvatarOptions(discordId);
        res.json({
            avatar_preference: result.preference,
            avatar_effective: result.effective,
            avatar_discord_hash: avatar.discordAvatarHash,
            avatar_google_url: avatar.googleAvatarUrl,
        });
    } catch (error) {
        if ((error as { code?: string })?.code === 'AVATAR_UNAVAILABLE') {
            return res.status(409).json({ error: (error as Error).message, reason: 'avatar_unavailable' });
        }
        logError('API Error (PATCH /api/users/me/avatar-preference):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * GET /api/users/me/identity/claims
 * What this account holds and what is awaiting review — drives the Account
 * Settings aliases card.
 */
router.get('/me/identity/claims', requireAuth, requireDiscordUser, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const { IdentityClaimService, MAX_ALIASES } = await import('../../services/IdentityClaimService.js');
        const { getDatabase } = await import('../../database/database.js');
        const db = await getDatabase();
        const pending = await db.all(
            `SELECT c.id, c.iscored_username, c.requested_at, r.name AS room_name
               FROM identity_claims c
               LEFT JOIN game_rooms r ON r.id = c.game_room_id
              WHERE c.claimant_user_id = ? AND c.status = 'pending'
              ORDER BY c.requested_at DESC`,
            discordId,
        );
        res.json({
            aliases: await UserProfileService.getAliases(discordId),
            aliasCount: await IdentityClaimService.aliasCount(discordId),
            maxAliases: MAX_ALIASES,
            pending,
        });
    } catch (error) {
        logError('API Error (GET /api/users/me/identity/claims):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * POST /api/users/me/identity/claims
 * Claim an iScored name from the global Account Settings surface. The review
 * room is resolved server-side — routed to the room where the name actually has
 * history, since those admins are the ones who can judge it.
 */
router.post('/me/identity/claims', requireAuth, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const requested = typeof req.body?.iscoredUsername === 'string' ? req.body.iscoredUsername : '';
        const { IdentityClaimService, ClaimError } = await import('../../services/IdentityClaimService.js');

        const roomId = await IdentityClaimService.resolveReviewRoom(discordId, requested.trim());
        try {
            res.json(await IdentityClaimService.claim(discordId, roomId, requested));
        } catch (err) {
            if (err instanceof ClaimError) {
                const status = err.code === 'INVALID_NAME' ? 400 : 409;
                return res.status(status).json({ error: err.message, reason: err.code });
            }
            throw err;
        }
    } catch (error) {
        logError('API Error (POST /api/users/me/identity/claims):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

/**
 * DELETE /api/users/me/identity/aliases/:name
 * Give up a name, so the 3-alias cap stays manageable.
 */
router.delete('/me/identity/aliases/:name', requireAuth, requireDiscordUser, requireNotBanned, async (req, res) => {
    try {
        const discordId = req.user!.discordId!;
        const name = decodeURIComponent(req.params.name as string);
        const { IdentityClaimService } = await import('../../services/IdentityClaimService.js');
        const removed = await IdentityClaimService.releaseAlias(discordId, name);
        if (!removed) return res.status(404).json({ error: 'You do not hold that iScored name.' });
        res.json({ ok: true });
    } catch (error) {
        logError('API Error (DELETE /api/users/me/identity/aliases/:name):', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
