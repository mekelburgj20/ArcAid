import { getDatabase } from '../database/database.js';
import { isGoogleUserId } from '../utils/identityProvider.js';

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
     */
    static async createLink(googleUserId: string, discordUserId: string): Promise<void> {
        if (!isGoogleUserId(googleUserId)) {
            throw new Error(`createLink: provider id must be a google:* identity, got "${googleUserId}"`);
        }
        const db = await getDatabase();
        await db.exec('BEGIN');
        try {
            // Pin the link row itself first. ON CONFLICT DO UPDATE allows a
            // google id to be re-linked (e.g. unlink then link to a different
            // Discord account) — re-running createLink for an id already
            // linked to the SAME canonical is a harmless no-op for this row;
            // re-linking to a DIFFERENT canonical after data was already
            // rewritten under the old canonical is an out-of-scope edge case
            // in v1 (the attribution UPDATEs below simply match zero rows,
            // since the google id no longer appears in any score table).
            await db.run(
                `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)
                 ON CONFLICT(provider_user_id) DO UPDATE SET canonical_user_id = excluded.canonical_user_id`,
                googleUserId, discordUserId,
            );

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
                if (googleProfile) {
                    await db.run(
                        `UPDATE user_profiles
                            SET display_name = COALESCE(display_name, ?),
                                avatar_url = COALESCE(avatar_url, ?),
                                updated_at = datetime('now')
                          WHERE discord_user_id = ?`,
                        googleProfile.display_name, googleProfile.avatar_url, discordUserId,
                    );
                }
                await db.run(`DELETE FROM user_profiles WHERE discord_user_id = ?`, googleUserId);
            }

            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
    }
}
