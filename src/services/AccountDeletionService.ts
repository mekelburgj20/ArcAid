import { getDatabase } from '../database/database.js';
import { deleteScorePhotoFiles } from '../utils/scorePhotoCleanup.js';
import { logInfo, logWarn } from '../utils/logger.js';

/**
 * Single greppable placeholder written into NOT-NULL identity columns when a row
 * is anonymized rather than deleted (styled like the existing 'SYSTEM' / 'ANON' /
 * 'COMMUNITY' sentinels). Nullable attribution columns are set to NULL instead so
 * leaderboards — which partition on
 *   COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
 * — re-anchor the score to the anonymous iScored handle.
 *
 * NOTE: any FUTURE runtime GROUP BY over discord_user_id / player_id must treat
 * this value as a non-identity (the existing NOT IN ('SYSTEM','COMMUNITY','ANON','')
 * filters are one-time migration backfills, so there is no runtime leak today).
 */
export const DELETED_USER_SENTINEL = 'DELETED';

export interface AccountDeletionOptions {
    /** 'self' = the user deleting their own account; 'admin' = a super-admin acting. */
    actor: 'self' | 'admin';
    /** Acting super-admin's Discord id when actor === 'admin' (audit context only). */
    actorDiscordId?: string;
}

export interface AccountDeletionResult {
    discordUserId: string;
    /** Distinct tables that actually had rows changed (empty on a no-op re-run). */
    tablesAffected: string[];
    /** Total rows removed by DELETE-outright statements. */
    rowsDeleted: number;
    /** Total field-level anonymization writes (sum of UPDATE change counts). */
    rowsAnonymized: number;
    /** On-disk proof-photo files unlinked after commit. */
    photosDeleted: number;
    /** Cached-ranking rows flushed so live scoreboards drop the identity. */
    cachesBusted: number;
    /** Rooms left with zero admins after this user's admin rows were removed. */
    roomsLeftAdminless: string[];
}

/**
 * Thrown BEFORE any mutation when the target is the only remaining super-admin.
 * The route maps this to HTTP 409 — super-admin must be transferred first.
 */
export class LastSuperAdminError extends Error {
    constructor(message = 'Cannot delete the only super-admin account. Transfer super-admin to another account first.') {
        super(message);
        this.name = 'LastSuperAdminError';
    }
}

/**
 * Account deletion = ANONYMIZE-AND-KEEP-SCORES.
 *
 * Strips every piece of personal data tied to a Discord account (identity,
 * sessions, avatar/display name, proof photos, mappings, prefs, social graph,
 * comments, ratings, privileges) while KEEPING the score rows under their
 * anonymous iScored handle so leaderboards / rankings stay intact — the score is
 * de-identified, not deleted.
 *
 * Design contract:
 *  1. Transactional — mirrors GameRoomService.delete (BEGIN → work → COMMIT,
 *     ROLLBACK + rethrow on any error).
 *  2. FK-safe under PRAGMA foreign_keys=ON — the DELETE-outright tables have no
 *     inbound FK children, and merge_records + anonymous_identities are
 *     ANONYMIZED (never deleted) so the NO-ACTION `anonymous_identity_id`
 *     pseudo-FK is never violated.
 *  3. Idempotent — every predicate is `WHERE col = ?`, so a re-run changes 0 rows
 *     and returns zeroed counts.
 *  4. Photos are NON-transactional — URLs are collected BEFORE the tx (the UPDATE
 *     nulls both photo_url and its predicate column), files are unlinked
 *     best-effort AFTER commit, and an unlink failure never rolls back the DB.
 *  5. Precondition guard — throws LastSuperAdminError before the tx if the target
 *     is the sole super-admin.
 *
 * The caller (route) is responsible for AuditService.log (needs req.ip /
 * correlationId) and for emitting the post-commit `leaderboard:updated`
 * WebSocket event.
 */
export class AccountDeletionService {
    static async anonymizeUser(
        discordUserId: string,
        opts: AccountDeletionOptions,
    ): Promise<AccountDeletionResult> {
        const db = await getDatabase();
        const id = discordUserId;
        const S = DELETED_USER_SENTINEL;

        const tablesAffected = new Set<string>();
        let rowsAnonymized = 0;
        let rowsDeleted = 0;
        let cachesBusted = 0;
        const roomsLeftAdminless: string[] = [];

        // UPDATE (anonymize) helper: accumulate changed-row count + table name.
        const anon = async (table: string, sql: string, ...params: unknown[]): Promise<number> => {
            const result = await db.run(sql, ...params);
            const changed = result.changes || 0;
            if (changed > 0) {
                rowsAnonymized += changed;
                tablesAffected.add(table);
            }
            return changed;
        };
        // DELETE (outright) helper: accumulate removed-row count + table name.
        const del = async (table: string, sql: string, ...params: unknown[]): Promise<number> => {
            const result = await db.run(sql, ...params);
            const changed = result.changes || 0;
            if (changed > 0) {
                rowsDeleted += changed;
                tablesAffected.add(table);
            }
            return changed;
        };

        // STEP 0 — last-super-admin precondition (BEFORE the tx). Only blocks when
        // the target actually IS a super-admin AND is the only one; deleting a
        // super-admin while others remain is allowed.
        const isSuper = await db.get('SELECT 1 AS present FROM super_admins WHERE discord_user_id = ?', id);
        if (isSuper) {
            const countRow = await db.get('SELECT COUNT(*) AS c FROM super_admins');
            if ((countRow?.c ?? 0) <= 1) {
                throw new LastSuperAdminError();
            }
        }

        // STEP 1 — collect data needed before the tx nulls its source columns:
        //   (a) on-disk proof-photo URLs across the four score tables (the UPDATE
        //       nulls photo_url AND the identity predicate, so read them first),
        //   (b) anon-identity ids merge-linked to this user (merge_records nulls
        //       target_discord_user_id inside the tx).
        const photoRows = await db.all(
            `SELECT photo_url FROM submissions
                WHERE (submitted_by_user_id = ? OR discord_user_id = ?) AND photo_url LIKE '/api/score-photos/%'
             UNION ALL
             SELECT photo_url FROM score_history
                WHERE (submitted_by_user_id = ? OR discord_user_id = ?) AND photo_url LIKE '/api/score-photos/%'
             UNION ALL
             SELECT photo_url FROM community_scores
                WHERE (submitted_by_user_id = ? OR discord_user_id = ?) AND photo_url LIKE '/api/score-photos/%'
             UNION ALL
             SELECT photo_url FROM global_scores
                WHERE (player_id = ? OR submitted_by_user_id = ?) AND photo_url LIKE '/api/score-photos/%'`,
            id, id, id, id, id, id, id, id,
        );
        const photoUrls: Array<string | null | undefined> = photoRows.map((r) => r.photo_url);

        const mergeAnonRows = await db.all(
            'SELECT anonymous_identity_id FROM merge_records WHERE target_discord_user_id = ?',
            id,
        );
        const mergeAnonIds: number[] = mergeAnonRows
            .map((r) => r.anonymous_identity_id as number | null | undefined)
            .filter((x): x is number => x !== null && x !== undefined);

        // STEP 2 — the transaction.
        await db.exec('BEGIN');
        try {
            // --- ANONYMIZE the four score tables (keep iscored_username + score) ---
            // Nulling submitted_by_user_id re-anchors the score to the anon handle;
            // the NOT-NULL discord_user_id / player_id take the sentinel. score_history
            // rows MUST survive — tournament leaderboards read them via
            // submitted_during_tournament_id.
            await anon('submissions',
                `UPDATE submissions
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = NULL,
                        merged_from_anonymous_identity_id = NULL,
                        discord_user_id = ?,
                        photo_url = NULL
                  WHERE submitted_by_user_id = ? OR discord_user_id = ?`,
                S, id, id);
            await anon('score_history',
                `UPDATE score_history
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = NULL,
                        merged_from_anonymous_identity_id = NULL,
                        discord_user_id = ?,
                        photo_url = NULL
                  WHERE submitted_by_user_id = ? OR discord_user_id = ?`,
                S, id, id);
            await anon('community_scores',
                `UPDATE community_scores
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = NULL,
                        merged_from_anonymous_identity_id = NULL,
                        discord_user_id = ?,
                        photo_url = NULL
                  WHERE submitted_by_user_id = ? OR discord_user_id = ?`,
                S, id, id);
            await anon('global_scores',
                `UPDATE global_scores
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = NULL,
                        merged_from_anonymous_identity_id = NULL,
                        player_id = ?,
                        photo_url = NULL
                  WHERE player_id = ? OR submitted_by_user_id = ?`,
                S, id, id);
            // A row this user soft-deleted as an admin keeps the ledger but loses the actor.
            await anon('global_scores',
                'UPDATE global_scores SET deleted_by = NULL WHERE deleted_by = ?', id);

            // --- ANONYMIZE the legacy verified-flag scores table ---
            await anon('scores',
                'UPDATE scores SET discord_user_id = ? WHERE discord_user_id = ?', S, id);

            // --- ANONYMIZE catalogue contributor attribution (KEEP the shared row + art) ---
            await anon('global_games',
                'UPDATE global_games SET submitted_by_user_id = NULL WHERE submitted_by_user_id = ?', id);
            await anon('global_games',
                'UPDATE global_games SET submitted_by = NULL WHERE submitted_by = ?', id);
            await anon('global_games',
                'UPDATE global_games SET reviewed_by = NULL WHERE reviewed_by = ?', id);

            // --- ANONYMIZE miscellaneous attribution columns ---
            await anon('games',
                'UPDATE games SET picker_discord_id = NULL WHERE picker_discord_id = ?', id);
            await anon('admin_invites',
                'UPDATE admin_invites SET discord_user_id = NULL WHERE discord_user_id = ?', id);
            await anon('admin_invites',
                'UPDATE admin_invites SET created_by = NULL WHERE created_by = ?', id);
            await anon('lobby_announcements',
                'UPDATE lobby_announcements SET created_by = NULL WHERE created_by = ?', id);

            // --- ANONYMIZE the merge chain (scrub anon identities FIRST, then records) ---
            // A merged anon identity's server_nickname may hold the user's real Discord
            // server nickname. server_nickname is NOT NULL and carries UNIQUE partial
            // indexes on (guild_id, LOWER(server_nickname)) and (room_id,
            // LOWER(server_nickname)) (migration 059) — so a plain 'DELETED' would
            // collide across two merge-linked identities in one guild, or across
            // successive account deletions in the same guild, aborting the whole tx.
            // The row's own (unique) id makes the tombstone collision-proof while
            // staying greppable (LIKE 'DELETED-%').
            if (mergeAnonIds.length > 0) {
                const placeholders = mergeAnonIds.map(() => '?').join(',');
                await anon('anonymous_identities',
                    `UPDATE anonymous_identities SET server_nickname = ? || '-' || id WHERE id IN (${placeholders})`,
                    S, ...mergeAnonIds);
            }
            // Keep the merge audit trail; strip the PII from it.
            await anon('merge_records',
                'UPDATE merge_records SET target_discord_user_id = ? WHERE target_discord_user_id = ?', S, id);
            await anon('merge_records',
                'UPDATE merge_records SET admin_discord_user_id = ? WHERE admin_discord_user_id = ?', S, id);
            await anon('merge_records',
                'UPDATE merge_records SET reversal_admin_id = NULL WHERE reversal_admin_id = ?', id);

            // --- ANONYMIZE abuse-prevention actor columns (KEEP the ban subject rows) ---
            // A banned user must not evade the ban by deleting + recreating, so the
            // subject rows (discord_user_id = X) are retained under legitimate
            // interest; only the actor columns are de-identified.
            await anon('user_bans',
                'UPDATE user_bans SET banned_by = ? WHERE banned_by = ?', S, id);
            await anon('user_bans',
                'UPDATE user_bans SET lifted_by = NULL WHERE lifted_by = ?', id);

            // --- ANONYMIZE moderation records + the deleted-score tombstone actor ---
            await anon('score_reports',
                'UPDATE score_reports SET reporter_discord_id = ? WHERE reporter_discord_id = ?', S, id);
            await anon('score_reports',
                'UPDATE score_reports SET resolved_by = NULL WHERE resolved_by = ?', id);
            // KEEP the suppression rows (a delete resurrects the score on next sync);
            // only null the actor.
            await anon('deleted_score_suppressions',
                'UPDATE deleted_score_suppressions SET deleted_by_user_id = NULL WHERE deleted_by_user_id = ?', id);

            // --- DELETE-OUTRIGHT identity / session ---
            await del('user_profiles', 'DELETE FROM user_profiles WHERE discord_user_id = ?', id);
            await del('user_mappings', 'DELETE FROM user_mappings WHERE discord_user_id = ?', id);
            await del('user_preferences', 'DELETE FROM user_preferences WHERE discord_user_id = ?', id);
            // Refresh tokens — MUST go so the account cannot re-authenticate.
            await del('sessions', 'DELETE FROM sessions WHERE discord_user_id = ?', id);
            // Browser push endpoints (S15) — device-identifying, must not outlive the account.
            await del('push_subscriptions', 'DELETE FROM push_subscriptions WHERE discord_user_id = ?', id);

            // --- DELETE-OUTRIGHT social ---
            await del('friendships',
                'DELETE FROM friendships WHERE user_id = ? OR friend_user_id = ?', id, id);
            await del('game_comments', 'DELETE FROM game_comments WHERE user_id = ?', id);
            await del('game_ratings', 'DELETE FROM game_ratings WHERE user_id = ?', id);
            await del('global_game_comments', 'DELETE FROM global_game_comments WHERE discord_user_id = ?', id);
            await del('global_game_ratings', 'DELETE FROM global_game_ratings WHERE discord_user_id = ?', id);
            // Frees the per-room first-claim display_name.
            await del('room_members', 'DELETE FROM room_members WHERE user_id = ?', id);

            // --- DELETE-OUTRIGHT privilege / ledger / feed ---
            // Capture the rooms this user administers BEFORE removing the rows so we
            // can flag any left with zero admins (non-blocking warning).
            const adminRooms = await db.all(
                'SELECT game_room_id FROM game_room_admins WHERE discord_user_id = ?', id);
            await del('game_room_admins', 'DELETE FROM game_room_admins WHERE discord_user_id = ?', id);
            for (const row of adminRooms) {
                const roomId = row.game_room_id as string;
                const remaining = await db.get(
                    'SELECT COUNT(*) AS c FROM game_room_admins WHERE game_room_id = ?', roomId);
                if ((remaining?.c ?? 0) === 0) roomsLeftAdminless.push(roomId);
            }
            // Guarded by STEP 0 — never the last super-admin.
            await del('super_admins', 'DELETE FROM super_admins WHERE discord_user_id = ?', id);
            // player_key = COALESCE(submitted_by_user_id, 'iscored:'||LOWER(handle)),
            // so a Discord user's fired-milestone rows are keyed on their discord id.
            await del('player_milestones_fired', 'DELETE FROM player_milestones_fired WHERE player_key = ?', id);
            await del('lobby_feed_events',
                'DELETE FROM lobby_feed_events WHERE player_id = ? OR target_user_id = ?', id, id);

            // --- BEST-EFFORT room_events JSON scrub (no dedicated user column) ---
            // The discord id is a unique ~18-digit token, so a false substring match
            // is negligible; this is a one-time scan.
            await del('room_events',
                "DELETE FROM room_events WHERE event_data LIKE '%' || ? || '%'", id);

            // --- BUST cached rankings (they embed player name + avatar) ---
            // Only when something actually changed: a true no-op re-run has no cached
            // identity to flush, keeping the operation idempotent. All three caches
            // self-recompute lazily on next read.
            if (rowsAnonymized + rowsDeleted > 0) {
                const c1 = await db.run('DELETE FROM leaderboard_cache');
                const c2 = await db.run('DELETE FROM global_leaderboard_cache');
                const c3 = await db.run('DELETE FROM ranking_groups_cache');
                cachesBusted = (c1.changes || 0) + (c2.changes || 0) + (c3.changes || 0);
            }

            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }

        // POST-COMMIT — unlink proof-photo files best-effort. A failure here leaves
        // an unreferenced orphan on disk (acceptable) and never affects the DB.
        const photosDeleted = deleteScorePhotoFiles(photoUrls);

        if (roomsLeftAdminless.length > 0) {
            logWarn(
                `Account deletion (${opts.actor}) for ${id} left ${roomsLeftAdminless.length} room(s) with zero admins: ${roomsLeftAdminless.join(', ')}`,
            );
        }

        logInfo(
            `Account ${id} anonymized (actor=${opts.actor}${opts.actorDiscordId ? `, by=${opts.actorDiscordId}` : ''}): ` +
            `${rowsAnonymized} anonymized, ${rowsDeleted} deleted, ${photosDeleted} photo(s) removed, ${cachesBusted} cache row(s) flushed`,
        );

        return {
            discordUserId: id,
            tablesAffected: Array.from(tablesAffected),
            rowsDeleted,
            rowsAnonymized,
            photosDeleted,
            cachesBusted,
            roomsLeftAdminless,
        };
    }
}
