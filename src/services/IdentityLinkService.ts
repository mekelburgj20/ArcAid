import { getDatabase } from '../database/database.js';
import { isGoogleUserId, isDiscordUserId } from '../utils/identityProvider.js';
import { containsBlockedTerm } from '../utils/contentBlocklist.js';

/**
 * Google<->Discord canonical-identity linking (v2.36.0).
 *
 * DOCTRINE — this is a PARALLEL mechanism to `user_mappings` / `/map-user` /
 * `MergeService`. Do not conflate them:
 *   - `user_mappings` maps iScored USERNAMES (game-handle aliases, e.g.
 *     "Krobs99") to a Discord user id — many-aliases-to-one-user, so a
 *     player's iScored scores under different display names all attribute to
 *     one person.
 *   - `user_identity_links` maps a LOGIN IDENTITY (a `provider_user_id`, e.g.
 *     `google:<sub>`) to a single CANONICAL identity (always a Discord
 *     snowflake in v1) — so a player who logs in via Google and also logs in
 *     via Discord OAuth is recognized as the same account instead of forking
 *     into two.
 * Nothing in this service reads or writes `user_mappings`, and nothing in
 * `MergeService`/`/map-user` reads or writes `user_identity_links`.
 *
 * Beta scope (per contract): `createLink`'s attribution rewrite is
 * last-write-wins, no merge-reversal. `deleteLink` (unlink) is a row delete
 * ONLY — identities diverge going forward, no un-merge.
 */

export interface IdentityLink {
    provider_user_id: string;
    canonical_user_id: string;
    created_at: string;
}

export class IdentityLinkService {
    /**
     * Resolve `userId` to its canonical identity if a link exists, else return
     * it unchanged. Called from both OAuth callbacks and `refreshAccessToken`
     * so login always mints a token for the canonical identity. A bare
     * Discord snowflake is never a `provider_user_id` key in v1, so this is a
     * cheap no-op lookup for Discord logins — kept uniform anyway rather than
     * special-cased out.
     */
    static async resolveCanonical(userId: string): Promise<string> {
        if (!userId) return userId;
        const db = await getDatabase();
        const row = await db.get(
            'SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?',
            userId,
        );
        return row?.canonical_user_id ?? userId;
    }

    /** All provider identities currently linked to `canonicalUserId` (settings UI list). */
    static async getLinkForCanonical(canonicalUserId: string): Promise<IdentityLink[]> {
        const db = await getDatabase();
        return db.all(
            'SELECT provider_user_id, canonical_user_id, created_at FROM user_identity_links WHERE canonical_user_id = ? ORDER BY created_at ASC',
            canonicalUserId,
        );
    }

    /** Unlink v1 = row delete ONLY. No un-merge — identities diverge from here forward. */
    static async deleteLink(providerUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            'DELETE FROM user_identity_links WHERE provider_user_id = ?',
            providerUserId,
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Link `googleUserId` (e.g. `google:1234`) to `discordUserId` (a
     * snowflake) as its canonical identity, and rewrite pre-link attribution
     * from the google id to the snowflake in one transaction — last-write-wins,
     * beta-simple (see contract; no merge-reversal in v1).
     *
     * Table list + conflict handling verified against the live schema
     * (`src/database/database.ts`) and `AccountDeletionService` (the closest
     * existing precedent for "every column that can hold this identity").
     * Deviations from the contract's D1 recon list are documented inline.
     *
     * v2.46.0 (mirror-link contract) — conflict guard, both link directions.
     * Pre-v2.46.0 the `ON CONFLICT(provider_user_id) DO UPDATE` silently
     * re-pointed a google id already linked to a DIFFERENT canonical, which
     * becomes a steal-link vector once linking is bidirectional (an attacker
     * who controls a Discord snowflake could re-link a victim's already-linked
     * google id onto themselves just by completing the Google OAuth leg).
     * Pre-flight check below closes it: same canonical is an idempotent
     * no-op, different canonical throws a typed `LINK_CONFLICT` error that
     * both OAuth callbacks map to 409.
     *
     * Adversarial-review fix round (mirror-link-fixes #4, #5, #7):
     *   - Fix 7: canonical-shape doctrine ("canonical is always a Discord
     *     snowflake") is now enforced here, not just conventional.
     *   - Fix 4: a same-canonical relink FALLS THROUGH into the transaction
     *     instead of early-returning — the rewrites are idempotent, and a
     *     stale pre-link `google:*` JWT (24h lifetime) can still create new
     *     attribution rows under the google id after the first link; relink
     *     is the repair path for that, so it must re-run the sweep.
     *   - Fix 5: the conflict guard is now atomic with the write. The
     *     pre-flight SELECT below is a fast path only (avoids opening a
     *     transaction for the common already-linked-elsewhere case); the
     *     authoritative check is the `ON CONFLICT DO NOTHING` + re-read
     *     inside the transaction, closing the race the old pre-flight-only
     *     check (which then went straight to `ON CONFLICT DO UPDATE`, i.e.
     *     last-write-wins) left open.
     */
    static async createLink(googleUserId: string, discordUserId: string): Promise<void> {
        if (!isGoogleUserId(googleUserId)) {
            throw new Error(`createLink: provider id must be a google:* identity, got "${googleUserId}"`);
        }
        if (!isDiscordUserId(discordUserId)) {
            throw new Error(`createLink: canonical id must be a Discord snowflake, got "${discordUserId}"`);
        }
        const db = await getDatabase();

        // Fast-path pre-flight (optional per Fix 5 — the authoritative check
        // is inside the transaction below). Only short-circuits the clear
        // conflict case; same-canonical falls through to re-run the
        // idempotent rewrites (Fix 4).
        const preflight = await db.get(
            'SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?',
            googleUserId,
        );
        if (preflight && preflight.canonical_user_id !== discordUserId) {
            const err = new Error(
                `createLink: "${googleUserId}" is already linked to a different canonical identity`,
            );
            (err as Error & { code?: string }).code = 'LINK_CONFLICT';
            throw err;
        }

        await db.exec('BEGIN');
        try {
            // Fix 5 — atomic conflict guard. DO NOTHING (not DO UPDATE): a
            // race between the pre-flight read above and this write must not
            // silently re-point the link (last-write-wins was the exact
            // steal-link vector this fix closes). If the row already existed
            // (changes === 0), re-read it inside the transaction and decide:
            // same canonical → fall through to the rewrites (Fix 4);
            // different canonical → throw LINK_CONFLICT, caught below, which
            // rolls back (no writes to undo yet, but keeps one exit path).
            const insertResult = await db.run(
                `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)
                 ON CONFLICT(provider_user_id) DO NOTHING`,
                googleUserId, discordUserId,
            );
            if ((insertResult.changes ?? 0) === 0) {
                const row = await db.get(
                    'SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?',
                    googleUserId,
                );
                if (!row || row.canonical_user_id !== discordUserId) {
                    const err = new Error(
                        `createLink: "${googleUserId}" is already linked to a different canonical identity`,
                    );
                    (err as Error & { code?: string }).code = 'LINK_CONFLICT';
                    throw err;
                }
                // Same canonical — the insert was a no-op against the
                // existing row. Fall through: every rewrite below is
                // idempotent and must re-run (Fix 4).
            }

            // --- Score-attribution tables --------------------------------
            // DEVIATION from the contract's D1 list: the contract named
            // `submitted_by_user_id` explicitly only for score_history and
            // global_scores, and only "the submitter column" for
            // community_scores. Recon against the live schema (and
            // AccountDeletionService, which anonymizes the identical shape)
            // shows submissions/community_scores/score_history/global_scores
            // ALL carry both a NOT-NULL identity column (discord_user_id /
            // player_id) and a nullable submitted_by_user_id — and
            // leaderboard partitioning reads
            // COALESCE(submitted_by_user_id, 'iscored:'||LOWER(iscored_username))
            // in preference order. Rewriting only one of the two per table
            // would leave some rows keyed on the stale google id post-link.
            // Applied uniformly across all four tables instead. None of the
            // four have a PK/UNIQUE constraint on either column, so a plain
            // UPDATE cannot collide.
            await db.run(`UPDATE submissions SET discord_user_id = ? WHERE discord_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE submissions SET submitted_by_user_id = ? WHERE submitted_by_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE score_history SET discord_user_id = ? WHERE discord_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE score_history SET submitted_by_user_id = ? WHERE submitted_by_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE community_scores SET discord_user_id = ? WHERE discord_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE community_scores SET submitted_by_user_id = ? WHERE submitted_by_user_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE global_scores SET player_id = ? WHERE player_id = ?`, discordUserId, googleUserId);
            await db.run(`UPDATE global_scores SET submitted_by_user_id = ? WHERE submitted_by_user_id = ?`, discordUserId, googleUserId);

            // --- sessions: plain column, PK is the session id — no conflict
            // possible. Rewriting so the google login's refresh chain (and any
            // OTHER still-open google-identity browser session) survives as
            // the canonical identity's session from now on.
            await db.run(`UPDATE sessions SET discord_user_id = ? WHERE discord_user_id = ?`, discordUserId, googleUserId);

            // --- push_subscriptions: PK is a synthetic autoincrement id;
            // UNIQUE is on `endpoint` (one physical device/browser), so
            // multiple rows can point at the same discord_user_id with no
            // conflict — verified against the live schema per the contract's
            // note to check the PK shape first.
            await db.run(`UPDATE push_subscriptions SET discord_user_id = ? WHERE discord_user_id = ?`, discordUserId, googleUserId);

            // --- room_members: PK (user_id, room_id). Re-key rooms where only
            // the google id has a row; where BOTH have a row for the same
            // room, keep the snowflake's row (it already holds the room's
            // first-claim display_name) and drop the google row.
            await db.run(
                `UPDATE room_members SET user_id = ?
                   WHERE user_id = ?
                     AND room_id NOT IN (SELECT room_id FROM room_members WHERE user_id = ?)`,
                discordUserId, googleUserId, discordUserId,
            );
            await db.run(`DELETE FROM room_members WHERE user_id = ?`, googleUserId);

            // --- user_preferences: PK discord_user_id. Same re-key/keep-snowflake rule.
            await db.run(
                `UPDATE user_preferences SET discord_user_id = ?
                   WHERE discord_user_id = ?
                     AND NOT EXISTS (SELECT 1 FROM user_preferences WHERE discord_user_id = ?)`,
                discordUserId, googleUserId, discordUserId,
            );
            await db.run(`DELETE FROM user_preferences WHERE discord_user_id = ?`, googleUserId);

            // --- game_room_admins: PK (game_room_id, discord_user_id).
            // INSERT-OR-IGNORE-style move: give the snowflake admin rights in
            // every room the google id held them, without disturbing a room
            // where the snowflake is already an admin (its existing role
            // wins), then drop the google row.
            const googleAdminRooms = await db.all(
                `SELECT game_room_id, role FROM game_room_admins WHERE discord_user_id = ?`,
                googleUserId,
            );
            for (const row of googleAdminRooms) {
                await db.run(
                    `INSERT OR IGNORE INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, ?)`,
                    row.game_room_id, discordUserId, row.role,
                );
            }
            await db.run(`DELETE FROM game_room_admins WHERE discord_user_id = ?`, googleUserId);

            // --- user_profiles: PK discord_user_id. If the snowflake has no
            // profile row yet, re-key the google row wholesale. If both exist,
            // keep the snowflake's row (their Discord identity wins) but
            // COALESCE in the google row's display_name/avatar_url for any
            // field the snowflake's row left NULL, then drop the google row.
            const snowflakeProfile = await db.get(
                `SELECT discord_user_id FROM user_profiles WHERE discord_user_id = ?`,
                discordUserId,
            );
            if (!snowflakeProfile) {
                await db.run(
                    `UPDATE user_profiles SET discord_user_id = ? WHERE discord_user_id = ?`,
                    discordUserId, googleUserId,
                );
            } else {
                const googleProfile = await db.get(
                    `SELECT display_name, avatar_url FROM user_profiles WHERE discord_user_id = ?`,
                    googleUserId,
                );
                // Fix 2 (adversarial review) — delete the google row BEFORE
                // the COALESCE update below, not after. The old order ran the
                // UPDATE first: if the snowflake's display_name was NULL and
                // got COALESCEd to the SAME non-null value the google row
                // still held (not yet deleted), the partial UNIQUE INDEX
                // `idx_user_profiles_display_name` briefly saw two rows with
                // that value mid-statement and rejected it — rolling back the
                // ENTIRE link transaction. Fatal in practice: the link nonce
                // is single-use and already consumed by this point, so the
                // user had no way to retry. Deleting the google row first
                // removes the collision before the UPDATE ever runs.
                await db.run(`DELETE FROM user_profiles WHERE discord_user_id = ?`, googleUserId);
                if (googleProfile) {
                    // m3 (S22 Phase 1 adversarial review) — the COALESCE below
                    // copies the google row's display_name onto the canonical
                    // snowflake profile whenever the snowflake's own is unset.
                    // Without a check here, a blocked display_name set before
                    // this doctrine existed (or otherwise never re-validated)
                    // would get laundered onto the canonical profile at link
                    // time. Pass null instead — same as an unset display_name,
                    // COALESCE just leaves the snowflake's own value in place.
                    const safeDisplayName = containsBlockedTerm(googleProfile.display_name) ? null : googleProfile.display_name;
                    await db.run(
                        `UPDATE user_profiles
                            SET display_name = COALESCE(display_name, ?),
                                avatar_url = COALESCE(avatar_url, ?),
                                updated_at = datetime('now')
                          WHERE discord_user_id = ?`,
                        safeDisplayName, googleProfile.avatar_url, discordUserId,
                    );
                }
            }

            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
    }
}
