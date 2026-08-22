import { getDatabase } from '../database/database.js';
import { logError, logInfo } from '../utils/logger.js';
import { assertNameAllowed, sanitizeProviderUsername } from '../utils/contentBlocklist.js';

/**
 * Per-Discord-user global profile. Owns the user-chosen display name and the
 * cached avatar hash. Display name is globally unique (case-insensitive) and
 * may not collide with another user's iScored alias either — picking your own
 * alias as your display name IS allowed.
 *
 * Data lives in the `user_profiles` table (migration 095). The aliases
 * themselves stay in `user_mappings`.
 */

export type DisplayNameAvailability =
    | { available: true }
    | { available: false; reason: 'too_short' | 'too_long' | 'taken_display' | 'taken_alias' | 'invalid_chars' };

const MIN_LEN = 2;
const MAX_LEN = 32;
// Discord-style: letters, numbers, underscore, dash, period, space. No
// leading/trailing whitespace (caller normalizes).
const VALID_PATTERN = /^[\p{L}\p{N}_\-. ]+$/u;

export class UserProfileService {
    /** Returns the user's chosen display name, or null if unset. */
    static async getDisplayName(discordUserId: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get<{ display_name: string | null }>(
            `SELECT display_name FROM user_profiles WHERE discord_user_id = ?`,
            discordUserId,
        );
        return row?.display_name ?? null;
    }

    /**
     * Batch lookup. Returns a map of discord_user_id → display_name for any
     * IDs with a non-null display_name. Missing/null IDs are simply absent
     * from the map — callers fall back to their `iscored_username`.
     */
    static async getDisplayNameMap(discordUserIds: string[]): Promise<Map<string, string>> {
        const map = new Map<string, string>();
        if (discordUserIds.length === 0) return map;
        const db = await getDatabase();
        const placeholders = discordUserIds.map(() => '?').join(',');
        const rows = await db.all(
            `SELECT discord_user_id, display_name FROM user_profiles
             WHERE discord_user_id IN (${placeholders})
               AND display_name IS NOT NULL`,
            ...discordUserIds,
        ) as Array<{ discord_user_id: string; display_name: string }>;
        for (const r of rows) map.set(r.discord_user_id, r.display_name);
        return map;
    }

    /**
     * Returns the user's full profile row (creating it if missing — every
     * Discord-authenticated request can rely on a row existing).
     */
    static async ensureProfile(discordUserId: string): Promise<{
        discord_user_id: string;
        display_name: string | null;
        avatar_hash: string | null;
        avatar_url: string | null;
        avatar_fetched_at: string | null;
    }> {
        const db = await getDatabase();
        await db.run(
            `INSERT OR IGNORE INTO user_profiles (discord_user_id) VALUES (?)`,
            discordUserId,
        );
        const row = await db.get(
            `SELECT discord_user_id, display_name, avatar_hash, avatar_url, avatar_fetched_at
             FROM user_profiles WHERE discord_user_id = ?`,
            discordUserId,
        );
        return row as {
            discord_user_id: string;
            display_name: string | null;
            avatar_hash: string | null;
            avatar_url: string | null;
            avatar_fetched_at: string | null;
        };
    }

    /**
     * Pre-flight availability check used by the FE's debounced input. Does NOT
     * mutate. Returns a structured reason on failure so the UI can render
     * targeted copy. Lookup is case-insensitive across both display names and
     * iScored aliases; the user's own aliases are excluded from the alias
     * check (they may pick their own iScored name as display).
     */
    static async checkDisplayNameAvailability(
        discordUserId: string,
        nameRaw: string,
    ): Promise<DisplayNameAvailability> {
        const name = nameRaw.trim();
        if (name.length < MIN_LEN) return { available: false, reason: 'too_short' };
        if (name.length > MAX_LEN) return { available: false, reason: 'too_long' };
        if (!VALID_PATTERN.test(name)) return { available: false, reason: 'invalid_chars' };

        const db = await getDatabase();
        const dispClash = await db.get<{ discord_user_id: string }>(
            `SELECT discord_user_id FROM user_profiles
             WHERE LOWER(display_name) = LOWER(?) AND discord_user_id != ?`,
            name, discordUserId,
        );
        if (dispClash) return { available: false, reason: 'taken_display' };

        const aliasClash = await db.get<{ discord_user_id: string }>(
            `SELECT discord_user_id FROM user_mappings
             WHERE LOWER(iscored_username) = LOWER(?) AND discord_user_id != ?`,
            name, discordUserId,
        );
        if (aliasClash) return { available: false, reason: 'taken_alias' };

        return { available: true };
    }

    /**
     * Sets or clears the user's display name. Pass null/empty to clear.
     * Throws DISPLAY_NAME_TAKEN (with a reason payload) on collision —
     * callers should surface this as a 409 with the reason in the body.
     */
    static async setDisplayName(discordUserId: string, nameRaw: string | null): Promise<string | null> {
        const name = nameRaw == null ? null : nameRaw.trim();
        if (name === null || name === '') {
            const db = await getDatabase();
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, NULL)
                 ON CONFLICT(discord_user_id) DO UPDATE SET display_name = NULL, updated_at = datetime('now')`,
                discordUserId,
            );
            logInfo(`UserProfileService.setDisplayName: cleared for ${discordUserId}`);
            return null;
        }

        // S22 Phase 1 (v2.43.0) — blocklist check before the existing
        // availability checks. Throws NAME_NOT_ALLOWED; users.ts maps coded
        // errors from this method to HTTP the same way it already does for
        // DISPLAY_NAME_TAKEN.
        assertNameAllowed(name, 'display_name');

        const check = await this.checkDisplayNameAvailability(discordUserId, name);
        if (!check.available) {
            const err = new Error(`DISPLAY_NAME_TAKEN: ${check.reason}`);
            (err as Error & { code?: string; reason?: string }).code = 'DISPLAY_NAME_TAKEN';
            (err as Error & { reason?: string }).reason = check.reason;
            throw err;
        }

        const db = await getDatabase();
        try {
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`,
                discordUserId, name,
            );
        } catch (err) {
            // Race against the partial-unique index — surface the same shape.
            const e = err as Error;
            if (/UNIQUE constraint failed/i.test(e.message)) {
                const taken = new Error('DISPLAY_NAME_TAKEN: taken_display');
                (taken as Error & { code?: string; reason?: string }).code = 'DISPLAY_NAME_TAKEN';
                (taken as Error & { reason?: string }).reason = 'taken_display';
                throw taken;
            }
            logError('UserProfileService.setDisplayName: unexpected error', err);
            throw err;
        }

        logInfo(`UserProfileService.setDisplayName: ${discordUserId} → '${name}'`);
        return name;
    }

    /**
     * Canonical submit-name resolver for an AUTHENTICATED submitter.
     *
     * Product rule (username lock): a logged-in user submits under their own
     * canonical name only — the per-submit name field is gone from the UI and
     * the client-supplied name is ignored by every web submit handler. Renames
     * happen through `setDisplayName` (Account Settings), not by typing a
     * different name into the score modal. Pre-lock, typing "Chode_Farmer" here
     * wrote that string to `submissions.iscored_username`, claimed it as the
     * user's `room_members.display_name`, and — on the global path — registered
     * it as a permanent `user_mappings` alias.
     *
     * Resolution order (first non-empty wins):
     *   1. The name this user has ALREADY claimed in the submit scope:
     *        • room scope (`roomId` given) → `room_members.display_name`
     *        • global scope (no `roomId`)  → their first `user_mappings` alias
     *      Their established name in that scope always wins, so an existing
     *      player's rows keep grouping under the same name.
     *   2. `user_profiles.display_name` — the user-chosen global name.
     *   3. `jwtUsername` — the token's `username` claim (provider display name
     *      at login; `display_name || username || id` after a refresh).
     *   4. `discordUserId` — last-ditch, matches the pre-existing fallback in
     *      the global submit handler.
     *
     * Downstream is unchanged: the room paths still route this through
     * `RoomNameClaimService.resolveAndClaim`, so a first-time claimant whose
     * canonical name is already taken in that room still gets the `_N` suffix.
     */
    static async resolveSubmitName(opts: {
        discordUserId: string;
        /** Room scope for room submits; omit/null for the global scoreboard path. */
        roomId?: string | null;
        /** `req.user.username` — the JWT display claim. */
        jwtUsername?: string | null;
    }): Promise<string> {
        const { discordUserId, roomId, jwtUsername } = opts;
        const db = await getDatabase();
        const clean = (v: unknown): string | null => {
            const s = typeof v === 'string' ? v.trim() : '';
            return s.length > 0 ? s : null;
        };

        // 1. Already-claimed name in this scope.
        if (roomId) {
            const member = await db.get<{ display_name: string | null }>(
                `SELECT display_name FROM room_members WHERE user_id = ? AND room_id = ?`,
                discordUserId, roomId,
            );
            const claimed = clean(member?.display_name);
            if (claimed) return claimed;
        } else {
            const alias = await db.get<{ iscored_username: string }>(
                `SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?
                 ORDER BY created_at, rowid LIMIT 1`,
                discordUserId,
            );
            const claimed = clean(alias?.iscored_username);
            if (claimed) return claimed;
        }

        // 2. Global user-chosen display name.
        const profile = await db.get<{ display_name: string | null }>(
            `SELECT display_name FROM user_profiles WHERE discord_user_id = ?`,
            discordUserId,
        );
        const display = clean(profile?.display_name);
        if (display) return display;

        // 3/4. JWT username claim, then the raw id.
        return clean(jwtUsername) ?? discordUserId;
    }

    /**
     * Returns the user's iScored aliases (`user_mappings` rows for this Discord
     * user). Used by the account-settings page so users can see which names
     * they own.
     */
    static async getAliases(discordUserId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?
             ORDER BY created_at, rowid`,
            discordUserId,
        ) as Array<{ iscored_username: string }>;
        return rows.map(r => r.iscored_username);
    }

    /**
     * Which avatar providers this user actually has stored, plus their choice.
     *
     * `preference` is the stored intent; `effective` is what will really
     * render, which can differ when the preferred provider has nothing stored
     * (e.g. they picked Discord, then unlinked it).
     */
    static async getAvatarOptions(discordUserId: string): Promise<{
        preference: 'discord' | 'google' | null;
        effective: 'discord' | 'google' | null;
        discordAvatarHash: string | null;
        googleAvatarUrl: string | null;
    }> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT avatar_hash, avatar_url_google, avatar_preference
             FROM user_profiles WHERE discord_user_id = ?`,
            discordUserId,
        ) as { avatar_hash: string | null; avatar_url_google: string | null; avatar_preference: string | null } | undefined;

        const discordAvatarHash = row?.avatar_hash ?? null;
        const googleAvatarUrl = row?.avatar_url_google ?? null;
        const preference = (row?.avatar_preference === 'discord' || row?.avatar_preference === 'google')
            ? row.avatar_preference
            : null;

        return {
            preference,
            effective: resolveEffectiveAvatarProvider(preference, discordAvatarHash, googleAvatarUrl),
            discordAvatarHash,
            googleAvatarUrl,
        };
    }

    /**
     * Recompute `user_profiles.avatar_url` — the EFFECTIVE avatar — from the
     * user's stored preference and whichever provider avatars they actually
     * have. Migration 151 explains the column split.
     *
     * Call this after ANY write that changes an avatar or the preference:
     * a Discord login (new hash), a Google login (new picture), or the picker.
     * Read sites never consult the preference, so this is the only place the
     * choice is applied — miss it and the user's pick silently doesn't stick.
     *
     * No leaderboard-cache invalidation: per CLAUDE.md the caches store
     * identity-stable rows only and `PlayerProfileResolver` attaches avatars at
     * READ time, so the next render picks this up on its own.
     */
    static async applyAvatarPreference(discordUserId: string): Promise<void> {
        const { preference, discordAvatarHash, googleAvatarUrl } = await this.getAvatarOptions(discordUserId);
        const effective = resolveEffectiveAvatarProvider(preference, discordAvatarHash, googleAvatarUrl);
        // 'discord' renders from avatar_hash, which readers reach by finding
        // avatar_url NULL — so choosing Discord means clearing the effective URL.
        const effectiveUrl = effective === 'google' ? googleAvatarUrl : null;

        const db = await getDatabase();
        await db.run(
            `UPDATE user_profiles SET avatar_url = ?, updated_at = datetime('now') WHERE discord_user_id = ?`,
            effectiveUrl, discordUserId,
        );
    }

    /**
     * Store the user's choice, then apply it. `null` restores automatic
     * behavior (Discord when the user has a real Discord avatar, else Google —
     * see `resolveEffectiveAvatarProvider`; v2.127.1 reversed the original
     * Google-first order).
     * Rejects a provider the user has no avatar for, so the picker cannot
     * leave them with a blank.
     */
    static async setAvatarPreference(
        discordUserId: string,
        preference: 'discord' | 'google' | null,
    ): Promise<{ preference: 'discord' | 'google' | null; effective: 'discord' | 'google' | null }> {
        const { discordAvatarHash, googleAvatarUrl } = await this.getAvatarOptions(discordUserId);
        if (preference === 'discord' && !discordAvatarHash) {
            throw Object.assign(new Error('No Discord avatar is linked to this account.'), { code: 'AVATAR_UNAVAILABLE' });
        }
        if (preference === 'google' && !googleAvatarUrl) {
            throw Object.assign(new Error('No Google avatar is linked to this account.'), { code: 'AVATAR_UNAVAILABLE' });
        }

        const db = await getDatabase();
        await db.run(
            `UPDATE user_profiles SET avatar_preference = ?, updated_at = datetime('now') WHERE discord_user_id = ?`,
            preference, discordUserId,
        );
        await this.applyAvatarPreference(discordUserId);
        return { preference, effective: resolveEffectiveAvatarProvider(preference, discordAvatarHash, googleAvatarUrl) };
    }

    /**
     * Fill a `user_profiles` row from Discord's own user object (v2.127.0).
     *
     * WHY. Until now the OAuth login path in `src/api/routes/auth.ts` was the
     * ONLY thing that hydrated `user_profiles`. A player mapped by `/map-user`
     * or by an admin merge who never web-logged-in therefore had no row at all,
     * so every avatar and every name for them fell back to a bare snowflake
     * (BrickShotBobes on rtx_pinball, 2026-08-21).
     *
     * Rules, in order:
     *   • non-Discord ids are skipped — a `google:<sub>` account has no Discord
     *     user behind it and the REST call would be wasted,
     *   • a profile fetched inside 24h is left alone unless `force`,
     *   • ONE REST call (`fetchDiscordUser`) supplies both fields,
     *   • `avatar_fetched_at` is stamped even when the user has NO avatar, so
     *     an avatarless account isn't re-fetched by every nightly sweep,
     *   • `username` is filled ONLY when the stored one is NULL. The login path
     *     is last-write-wins and stays authoritative for anyone who logs in;
     *     this is the fallback for people who never do.
     *   • `display_name` is NEVER touched — that is the user's own choice.
     *
     * Returns true when a row was written. Never throws: every caller is on a
     * path (a claim, a merge, a cron) that must not fail for a cosmetic reason.
     */
    static async hydrateFromDiscord(userId: string, opts: { force?: boolean } = {}): Promise<boolean> {
        try {
            if (!userId) return false;
            const { isDiscordUserId } = await import('../utils/identityProvider.js');
            if (!isDiscordUserId(userId)) return false;
            if (!(await isProfileHydrationEnabled())) return false;

            const db = await getDatabase();
            if (!opts.force) {
                const existing = await db.get<{ avatar_fetched_at: string | null }>(
                    `SELECT avatar_fetched_at FROM user_profiles WHERE discord_user_id = ?`,
                    userId,
                );
                if (existing?.avatar_fetched_at) {
                    const fresh = await db.get<{ fresh: number }>(
                        `SELECT (? > datetime('now', '-24 hours')) AS fresh`,
                        existing.avatar_fetched_at,
                    );
                    if (fresh?.fresh) return false;
                }
            }

            const { fetchDiscordUser } = await import('../utils/discord.js');
            const user = await fetchDiscordUser(userId);
            if (!user) return false;

            const storedUsername = sanitizeProviderUsername(user.globalName ?? user.username);
            await db.run(
                `INSERT INTO user_profiles (discord_user_id, avatar_hash, avatar_fetched_at, username)
                 VALUES (?, ?, datetime('now'), ?)
                 ON CONFLICT(discord_user_id) DO UPDATE SET
                    avatar_hash = excluded.avatar_hash,
                    avatar_fetched_at = excluded.avatar_fetched_at,
                    username = COALESCE(user_profiles.username, excluded.username),
                    updated_at = datetime('now')`,
                userId, user.avatar, storedUsername,
            );
            // Migration 151 — a first-ever Discord avatar can flip which provider
            // is effective, so re-derive rather than assume. (The merge path
            // forgot this for years; that is the bug this call closes.)
            await this.applyAvatarPreference(userId);
            return true;
        } catch (err) {
            logError('UserProfileService.hydrateFromDiscord failed (non-fatal)', err);
            return false;
        }
    }

    /**
     * Nightly sweep: re-fetch the Discord profiles that have gone stale.
     *
     * Discord snowflakes only, NULL stamps first (a profile that has NEVER been
     * fetched is the one actually rendering a blank avatar), sequential with a
     * small gap between REST calls so a large backlog cannot trip Discord's
     * rate limiter. Registered by `Scheduler` at 04:20 — after the 04:00
     * iScored snapshot sweep, so the two nightly jobs don't overlap.
     *
     * Candidates are the UNION of two populations (v2.127.1):
     *   • `user_profiles` rows whose stamp is stale or NULL, and
     *   • Discord ids known from `user_mappings` / `room_members` that have NO
     *     `user_profiles` row at all.
     * The second set exists because link-time hydration is non-fatal: if the
     * Discord REST call fails (or hydration is switched off) when the alias is
     * mapped, no row is ever created — and a sweep that only reads
     * `user_profiles` can never retry it. They sort first, as never-fetched.
     * `hydrateFromDiscord` creates the row on upsert, so nothing else changes.
     */
    static async refreshStaleDiscordProfiles(
        opts: { staleDays?: number; limit?: number } = {},
    ): Promise<{ scanned: number; refreshed: number }> {
        const staleDays = opts.staleDays ?? 7;
        const limit = opts.limit ?? 200;
        if (!(await isProfileHydrationEnabled())) {
            logInfo('Profile hydration sweep skipped (PROFILE_HYDRATION_ENABLED=false).');
            return { scanned: 0, refreshed: 0 };
        }

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT discord_user_id, avatar_fetched_at FROM (
                SELECT discord_user_id, avatar_fetched_at FROM user_profiles
                  WHERE discord_user_id GLOB '[0-9]*'
                    AND LENGTH(discord_user_id) BETWEEN 17 AND 20
                    AND (avatar_fetched_at IS NULL OR avatar_fetched_at < datetime('now', ?))
                UNION
                SELECT um.discord_user_id, NULL AS avatar_fetched_at FROM user_mappings um
                  WHERE um.discord_user_id GLOB '[0-9]*'
                    AND LENGTH(um.discord_user_id) BETWEEN 17 AND 20
                    AND NOT EXISTS (
                        SELECT 1 FROM user_profiles p WHERE p.discord_user_id = um.discord_user_id)
                UNION
                SELECT rm.user_id, NULL AS avatar_fetched_at FROM room_members rm
                  WHERE rm.user_id GLOB '[0-9]*'
                    AND LENGTH(rm.user_id) BETWEEN 17 AND 20
                    AND NOT EXISTS (
                        SELECT 1 FROM user_profiles p WHERE p.discord_user_id = rm.user_id)
             )
             ORDER BY avatar_fetched_at IS NOT NULL, avatar_fetched_at
             LIMIT ?`,
            `-${staleDays} days`, limit,
        ) as Array<{ discord_user_id: string }>;

        let refreshed = 0;
        for (const row of rows) {
            if (await this.hydrateFromDiscord(row.discord_user_id, { force: true })) refreshed++;
            await new Promise(resolve => setTimeout(resolve, REFRESH_GAP_MS));
        }
        logInfo(`Profile hydration sweep: ${refreshed}/${rows.length} stale Discord profile(s) refreshed.`);
        return { scanned: rows.length, refreshed };
    }
}

/** Gap between REST calls in the nightly sweep — polite, not rate-limit-bound. */
const REFRESH_GAP_MS = 250;

/**
 * `PROFILE_HYDRATION_ENABLED` kill switch, same convention as
 * `IDENTITY_AUTO_LINK_EXACT` and `ISCORED_SNAPSHOTS_ENABLED`: absent means ON,
 * only the literal string 'false' turns it off, and an unreadable settings
 * table never decides policy.
 */
export const PROFILE_HYDRATION_SETTING = 'PROFILE_HYDRATION_ENABLED';

async function isProfileHydrationEnabled(): Promise<boolean> {
    if (process.env[PROFILE_HYDRATION_SETTING] === 'false') return false;
    try {
        const { SettingsService } = await import('./SettingsService.js');
        return (await SettingsService.get(PROFILE_HYDRATION_SETTING)) !== 'false';
    } catch {
        return true;
    }
}

/**
 * The avatar URL a token should carry for this user — the EFFECTIVE one, after
 * their provider preference is applied.
 *
 * Both login and refresh must mint the same value. `api/auth.ts`'s refresh path
 * already derived it this way; the LOGIN paths in `routes/auth.ts` did not —
 * they stamped the raw provider picture straight into the JWT. Since the web
 * app caches that claim in localStorage and the nav renders it, a user who
 * chose Discord kept seeing their Google picture everywhere outside Account
 * Settings until their token happened to refresh (owner field report,
 * 2026-08-18). Resolving through here keeps the two paths honest.
 */
export async function effectiveAvatarUrlFor(discordUserId: string): Promise<string | undefined> {
    const db = await getDatabase();
    const row = await db.get(
        'SELECT avatar_hash, avatar_url FROM user_profiles WHERE discord_user_id = ?',
        discordUserId,
    ) as { avatar_hash: string | null; avatar_url: string | null } | undefined;
    if (row?.avatar_url) return row.avatar_url;
    if (row?.avatar_hash) return `https://cdn.discordapp.com/avatars/${discordUserId}/${row.avatar_hash}.png`;
    return undefined;
}

/**
 * The one place the preference is interpreted. A stored preference for a
 * provider with nothing behind it degrades to whatever the user does have,
 * rather than rendering an empty avatar.
 */
export function resolveEffectiveAvatarProvider(
    preference: 'discord' | 'google' | null,
    discordAvatarHash: string | null,
    googleAvatarUrl: string | null,
): 'discord' | 'google' | null {
    if (preference === 'discord' && discordAvatarHash) return 'discord';
    if (preference === 'google' && googleAvatarUrl) return 'google';
    // Auto (and the degraded cases): DISCORD first (v2.127.1). This reverses
    // the original rule ("Google when present", carried over from pre-2026-08-17
    // behavior so nobody's avatar changed unless they asked). Prod evidence
    // 2026-08-22: a Google avatar URL is never NULL for a Google-linked account
    // — Google serves a generated letter tile for photo-less accounts — so
    // "Google when present" is really "Google always", and a user with a real
    // Discord avatar rendered the letter tile (ChalataLove on rtx_pinball; 2 of
    // the 5 Google-linked prod users had already overridden to Discord by hand).
    // A Discord `avatar_hash` is only non-NULL when the user actually chose an
    // avatar (NULL = Discord's own default), which makes it the honest signal of
    // intent and therefore the better automatic winner.
    if (discordAvatarHash) return 'discord';
    if (googleAvatarUrl) return 'google';
    return null;
}
