import { logInfo } from '../../utils/logger.js';

/**
 * Migration 159 — fold the synthetic `iscored:*` identities out of
 * `room_members`, then finish the re-attribution migration 157 started
 * (v2.127.0, identity tidy-up).
 *
 * THE THREE LEGACY SHAPES THIS CLEARS, all observed on rtx_pinball 2026-08-21:
 *
 *   1. A `room_members` row keyed `iscored:<Name>` sitting NEXT TO the real
 *      Discord-id row for the same human (ChalataLove, BrickShotBobes, Wyo,
 *      DennisB). Written by `ScoreHistoryService.log` ->
 *      `RoomMembershipService.addMember` back when the sync poller passed its
 *      synthetic id through. They have no `user_profiles` row, so the Members
 *      page rendered a generic avatar for a member who has a perfectly good
 *      one on their real row.
 *   2. The same synthetic row for a name NOBODY has linked. An unlinked board
 *      name is not a member: there is no account behind it, it can't view an
 *      approval room, and since v2.125.2 the poller no longer creates these at
 *      all. They are deleted outright.
 *   3. Sync rows left `submitted_by_user_id IS NULL, discord_user_id =
 *      'iscored:<name>'` after the name was mapped. Migration 157 NULLed 37
 *      synthetic `submitted_by_user_id` values but had nothing to put back, so
 *      `LeaderboardService`'s `COALESCE(submitted_by_user_id, 'iscored:'||...)`
 *      partition still splits those players in two on their own boards.
 *
 * `IdentityAliasEffectsService.onAliasLinked` keeps all three from recurring
 * for aliases linked from now on; this is the one-shot for the backlog. The
 * logic is deliberately identical to that service's — including the freeze gate
 * — but written out here because `database.ts` cannot import a service that
 * imports `database.ts`.
 *
 * Idempotent: every statement is a no-op on a database that has already run it.
 * No cache invalidation — `src/index.ts` clears the leaderboard caches at boot,
 * after migrations.
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    exec(sql: string): Promise<void>;
};

/**
 * Rows in a COMPLETED tournament are frozen — a finished competition's result
 * table is not rewritten under the winners' feet. Mirrors
 * `MergeService.previewMerge` (`tournaments` has no `end_date`; `is_active = 0`
 * IS "completed" there) and `IdentityAliasEffectsService`'s FREEZE_GATE,
 * including the `NOT IN (… is_active = 0)` form, which treats a row pointing at
 * a deleted tournament as UNfrozen exactly as previewMerge does.
 */
const FREEZE_GATE = `(submitted_during_tournament_id IS NULL
        OR submitted_during_tournament_id NOT IN (SELECT id FROM tournaments WHERE is_active = 0))`;

export async function foldSyntheticRoomMembers(db: Db): Promise<void> {
    // ── 1. Fold synthetic member rows whose name IS linked ──────────────────
    //
    // `SUBSTR(user_id, 9)` strips the `iscored:` prefix (8 chars). Matching is
    // case-insensitive on both sides, same as every other alias lookup.
    const linked = await db.all(
        `SELECT rm.user_id, rm.room_id, rm.joined_at, rm.display_name, um.discord_user_id AS real_user_id
           FROM room_members rm
           JOIN user_mappings um
             ON LOWER(um.iscored_username) = LOWER(SUBSTR(rm.user_id, 9))
          WHERE rm.user_id LIKE 'iscored:%'`,
    ) as Array<{
        user_id: string; room_id: string; joined_at: string | null;
        display_name: string | null; real_user_id: string;
    }>;

    let folded = 0;
    for (const row of linked) {
        const real = await db.get(
            `SELECT joined_at, display_name FROM room_members WHERE user_id = ? AND room_id = ?`,
            row.real_user_id, row.room_id,
        ) as { joined_at: string | null; display_name: string | null } | undefined;

        if (real) {
            // Delete FIRST: `idx_room_members_room_display_unique` is a partial
            // UNIQUE on (room_id, LOWER(display_name)), so carrying the name
            // over while the synthetic row still holds it would collide.
            await db.run(
                `DELETE FROM room_members WHERE user_id = ? AND room_id = ?`,
                row.user_id, row.room_id,
            );
            const joinedAt = earliest(real.joined_at, row.joined_at);
            const displayName = real.display_name ?? row.display_name ?? null;
            await db.run(
                `UPDATE room_members SET joined_at = ?, display_name = ? WHERE user_id = ? AND room_id = ?`,
                joinedAt, displayName, row.real_user_id, row.room_id,
            );
        } else {
            await db.run(
                `UPDATE room_members SET user_id = ? WHERE user_id = ? AND room_id = ?`,
                row.real_user_id, row.user_id, row.room_id,
            );
        }
        folded++;
    }

    // ── 2. Delete every synthetic row that is left (unlinked board names) ───
    const purged = await db.run(`DELETE FROM room_members WHERE user_id LIKE 'iscored:%'`);

    logInfo(
        `Migration 159: ${folded} synthetic room_members row(s) folded onto real accounts, ` +
        `${purged.changes ?? 0} unlinked synthetic row(s) deleted.`,
    );

    // ── 3. Backfill the re-attribution for every alias already mapped ───────
    //
    // Same predicates the service uses at link time.
    // `submitted_by_user_id IS NULL AND discord_user_id LIKE 'iscored:%'` is
    // the poller's own "nobody owns this row" signature.
    const sh = await db.run(
        `UPDATE score_history
            SET submitted_by_user_id = (
                    SELECT um.discord_user_id FROM user_mappings um
                     WHERE LOWER(um.iscored_username) = LOWER(score_history.iscored_username)),
                discord_user_id = (
                    SELECT um.discord_user_id FROM user_mappings um
                     WHERE LOWER(um.iscored_username) = LOWER(score_history.iscored_username)),
                submitted_by_anonymous_name = NULL
          WHERE source = 'sync'
            AND submitted_by_user_id IS NULL
            AND discord_user_id LIKE 'iscored:%'
            AND merged_from_anonymous_identity_id IS NULL
            AND ${FREEZE_GATE}
            AND EXISTS (
                SELECT 1 FROM user_mappings um
                 WHERE LOWER(um.iscored_username) = LOWER(score_history.iscored_username))`,
    );

    const sub = await db.run(
        `UPDATE submissions
            SET submitted_by_user_id = (
                    SELECT um.discord_user_id FROM user_mappings um
                     WHERE LOWER(um.iscored_username) = LOWER(submissions.iscored_username)),
                discord_user_id = (
                    SELECT um.discord_user_id FROM user_mappings um
                     WHERE LOWER(um.iscored_username) = LOWER(submissions.iscored_username)),
                submitted_by_anonymous_name = NULL
          WHERE submitted_by_user_id IS NULL
            AND discord_user_id LIKE 'iscored:%'
            AND merged_from_anonymous_identity_id IS NULL
            AND ${FREEZE_GATE}
            AND EXISTS (
                SELECT 1 FROM user_mappings um
                 WHERE LOWER(um.iscored_username) = LOWER(submissions.iscored_username))`,
    );

    logInfo(
        `Migration 159: re-attributed ${sh.changes ?? 0} score_history and ${sub.changes ?? 0} submissions ` +
        `row(s) to the accounts that hold their iScored alias.`,
    );
}

/** ISO/SQLite timestamps sort lexicographically, so MIN is a string compare. */
function earliest(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b;
}
