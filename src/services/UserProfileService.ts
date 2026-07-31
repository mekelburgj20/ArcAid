import { getDatabase } from '../database/database.js';
import { logError, logInfo } from '../utils/logger.js';
import { assertNameAllowed } from '../utils/contentBlocklist.js';

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
}
