import { logInfo } from '../../utils/logger.js';

/**
 * Migration 160 — the AUTOMATIC avatar provider becomes Discord-first
 * (v2.127.1).
 *
 * Migration 151 introduced the provider preference and shipped "Google when
 * present" as the automatic rule, on the assumption that a Google-linked
 * account with no photo would have a NULL picture URL. It never does: Google
 * serves a generated letter tile instead, so "Google when present" was in
 * practice "Google always". A player with a real Discord avatar and a
 * photo-less Google account therefore rendered the tile (ChalataLove on
 * rtx_pinball, 2026-08-22; two of the five Google-linked prod users had already
 * overridden to Discord by hand). A Discord `avatar_hash` is only non-NULL when
 * the user actually PICKED an avatar — NULL is Discord's own default — which
 * makes it the honest signal, and the better automatic winner.
 *
 * WHAT THIS TOUCHES. Only rows with NO explicit preference: an explicit choice
 * is the user's, in either direction, and stays exactly as they left it.
 * `avatar_url` is the EFFECTIVE column (migration 151) — NULL is how every
 * reader falls through to `avatar_hash`, which is precisely what
 * `UserProfileService.applyAvatarPreference` writes for a Discord-effective
 * user. `avatar_url_google` is untouched, so nothing is lost: switching back to
 * Google, by choice or by losing the Discord avatar, restores the picture.
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
};

export async function avatarAutoPrefersDiscord(db: Db): Promise<void> {
    const res = await db.run(`
        UPDATE user_profiles
           SET avatar_url = NULL, updated_at = datetime('now')
         WHERE avatar_preference IS NULL
           AND avatar_hash IS NOT NULL
           AND avatar_url IS NOT NULL
    `);
    logInfo(`[migration] 160: re-derived ${res.changes ?? 0} automatic avatar(s) to Discord-first`);
}
