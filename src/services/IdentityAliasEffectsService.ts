import { getDatabase } from '../database/database.js';
import { logError, logInfo } from '../utils/logger.js';
import { trackBackground } from '../utils/backgroundTasks.js';

/**
 * The ONE place that knows what happens when an iScored alias becomes — or
 * stops being — linked to an Arcaid account (identity tidy-up, v2.127.0).
 *
 * WHY IT EXISTS. Before this, every `user_mappings` writer (self-claim,
 * auto-link, `/map-user`, the global-submit name claim, `submitscore`'s
 * auto-map, merge) did exactly one thing: insert the alias row. Three prod
 * symptoms followed from that, all on rtx_pinball, all diagnosed 2026-08-21:
 *
 *   1. `room_members` kept SYNTHETIC `iscored:<Name>` rows next to the real
 *      Discord-id row for the same human. They were written by
 *      `ScoreHistoryService.log` -> `RoomMembershipService.addMember` back when
 *      the sync poller still passed its synthetic id through; since v2.125.2
 *      `normalizeSubmitterUserId` returns null for `iscored:*`, so no NEW ones
 *      appear — the survivors are frozen artifacts with no `user_profiles` row,
 *      which is why the Members page rendered a generic avatar for them.
 *   2. Pre-link synced rows stay `submitted_by_user_id IS NULL,
 *      discord_user_id = 'iscored:<name>'` forever. `LeaderboardService`
 *      partitions by `COALESCE(submitted_by_user_id, 'iscored:'||LOWER(
 *      iscored_username))`, so a player who beat their own pre-link score after
 *      linking showed up TWICE on the same board.
 *   3. A user mapped by a bot command who never web-logged-in has no
 *      `user_profiles` row at all, so there is no avatar and no name anywhere.
 *
 * Linking the alias is the moment all three become fixable, and the fix has to
 * live in one place or the six writers will drift. That place is here.
 *
 * THE FREEZE GATE. Re-attribution deliberately skips rows that belong to a
 * COMPLETED tournament, mirroring `MergeService.previewMerge`: a finished
 * competition's result table does not get rewritten under the winners' feet.
 * `tournaments` has no `end_date` column — `is_active = 0` IS "completed"
 * there, and this predicate is the same rule expressed in SQL.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. `community_scores` and `global_scores`:
 * the sync poller never writes either (ADR 0016 P2 — synced scores never reach
 * the Global Scoreboard), so an `iscored:*` signature there is not a sync row
 * and re-keying it would be a guess.
 */

/** `sqlite`'s Database, structurally — avoids a hard type import in callers. */
type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
};

/**
 * Rows in a COMPLETED tournament are frozen. Expressed as `NOT IN (… is_active
 * = 0)` rather than `IN (… is_active = 1)` so a row pointing at a tournament
 * that no longer exists is treated as UNfrozen — which is exactly what
 * `MergeService.previewMerge` does (it only marks a tournament frozen when it
 * finds the row AND `!is_active`). `tournaments.id` is a NOT NULL primary key,
 * so the usual `NOT IN` NULL hazard cannot apply.
 */
const FREEZE_GATE = `(submitted_during_tournament_id IS NULL
        OR submitted_during_tournament_id NOT IN (SELECT id FROM tournaments WHERE is_active = 0))`;

/**
 * Leaderboard + global-leaderboard + ranking caches, after an identity
 * partition changes.
 *
 * `RankingService` is in the list and the other two are not enough: the ranking
 * cache self-invalidates on a watermark over counts and sums
 * (`eligible_games_count, score_count, score_sum, MAX(end_date),
 * MAX(start_date)` — ADR 0013), and re-attribution changes NONE of those. It
 * only changes who the rows belong to, so the watermark matches and the stale
 * partition would be served indefinitely.
 *
 * Exported because `MergeService` needs the identical set — it re-attributes
 * rows for the same reason.
 */
export async function invalidateIdentityCaches(): Promise<void> {
    try {
        const { LeaderboardService } = await import('./LeaderboardService.js');
        LeaderboardService.invalidateAll();
    } catch (err) {
        logError('invalidateIdentityCaches: LeaderboardService.invalidateAll failed', err);
    }
    try {
        const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
        GlobalLeaderboardService.invalidateAll();
    } catch (err) {
        logError('invalidateIdentityCaches: GlobalLeaderboardService.invalidateAll failed', err);
    }
    try {
        const { RankingService } = await import('./RankingService.js');
        await RankingService.invalidateAll();
    } catch (err) {
        logError('invalidateIdentityCaches: RankingService.invalidateAll failed', err);
    }
}

export type AliasLinkedResult = { membersFolded: number; rowsAttributed: number };
export type AliasUnlinkedResult = { rowsReanonymized: number };

export class IdentityAliasEffectsService {
    /**
     * Call this from EVERY path that creates a `user_mappings` row, gated on
     * the insert actually inserting (`res.changes > 0` — they all carry
     * `ON CONFLICT DO NOTHING`, so a no-op insert must not re-run the effects).
     *
     * (a) and (b) are synchronous and transactional: pass `opts.db` when the
     * caller already holds an open transaction and they join it (the caller's
     * ROLLBACK then undoes them too); otherwise this opens its own. Their
     * errors propagate — a half-folded membership table is worse than a failed
     * claim.
     *
     * (c) profile hydration is a network call, so it is fire-and-forget OUTSIDE
     * any transaction and can never fail the caller.
     */
    static async onAliasLinked(
        userId: string,
        iscoredName: string,
        opts?: { db?: Db; skipHydration?: boolean },
    ): Promise<AliasLinkedResult> {
        const name = (iscoredName ?? '').trim();
        const result: AliasLinkedResult = { membersFolded: 0, rowsAttributed: 0 };
        if (!userId || !name) return result;

        const external = opts?.db;
        const db: Db = external ?? (await getDatabase()) as unknown as Db;
        const ownTxn = !external;

        if (ownTxn) await db.run('BEGIN');
        try {
            result.membersFolded = await foldSyntheticMembersFor(db, userId, name);
            result.rowsAttributed = await attributeUnownedSyncRows(db, userId, name);
            if (ownTxn) await db.run('COMMIT');
        } catch (err) {
            if (ownTxn) {
                try { await db.run('ROLLBACK'); } catch { /* the original error is the interesting one */ }
            }
            throw err;
        }

        if (result.rowsAttributed > 0) await invalidateIdentityCaches();

        if (result.membersFolded > 0 || result.rowsAttributed > 0) {
            logInfo(
                `IdentityAliasEffectsService.onAliasLinked: '${name}' -> ${userId} — ` +
                `${result.membersFolded} synthetic member row(s) folded, ${result.rowsAttributed} synced score row(s) attributed`,
            );
        }

        // (c) Outside the transaction, never awaited by the caller: a Discord
        // REST hop must not sit inside a SQLite write txn, and a profile that
        // fails to hydrate is a cosmetic loss, not a failed link.
        if (!opts?.skipHydration) {
            trackBackground((async () => {
                try {
                    const { UserProfileService } = await import('./UserProfileService.js');
                    await UserProfileService.hydrateFromDiscord(userId);
                } catch (err) {
                    logError('IdentityAliasEffectsService.onAliasLinked: profile hydration failed (non-fatal)', err);
                }
            })()).catch(() => {});
        }

        return result;
    }

    /**
     * The undo of (b), and ONLY of (b). Membership is deliberately untouched:
     * a person who releases an iScored alias is still a member of the rooms
     * they joined — that row is legitimately theirs, unlike the synthetic one
     * (a) removed.
     */
    static async onAliasUnlinked(
        userId: string,
        iscoredName: string,
        opts?: { db?: Db },
    ): Promise<AliasUnlinkedResult> {
        const name = (iscoredName ?? '').trim();
        if (!userId || !name) return { rowsReanonymized: 0 };

        const external = opts?.db;
        const db: Db = external ?? (await getDatabase()) as unknown as Db;
        const ownTxn = !external;

        let rowsReanonymized = 0;
        if (ownTxn) await db.run('BEGIN');
        try {
            // Column conventions mirror `MergeService.reverseMerge`'s
            // re-anonymize block: the anonymous name comes back from the row's
            // own `iscored_username` (preserving its stored casing) and the
            // per-row id reverts to the poller's synthetic signature.
            const sh = await db.run(
                `UPDATE score_history
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = iscored_username,
                        discord_user_id = 'iscored:' || iscored_username
                  WHERE source = 'sync'
                    AND LOWER(iscored_username) = LOWER(?)
                    AND submitted_by_user_id = ?
                    AND merged_from_anonymous_identity_id IS NULL`,
                name, userId,
            );
            // `submissions` has no `source` column, so alias + owner is the
            // whole scope available here (same limitation reverseMerge lives
            // with). A web row under the SAME alias by the SAME user is that
            // alias's row too, so returning it with the alias is correct.
            const sub = await db.run(
                `UPDATE submissions
                    SET submitted_by_user_id = NULL,
                        submitted_by_anonymous_name = iscored_username,
                        discord_user_id = 'iscored:' || iscored_username
                  WHERE LOWER(iscored_username) = LOWER(?)
                    AND submitted_by_user_id = ?
                    AND merged_from_anonymous_identity_id IS NULL`,
                name, userId,
            );
            rowsReanonymized = (sh.changes ?? 0) + (sub.changes ?? 0);
            if (ownTxn) await db.run('COMMIT');
        } catch (err) {
            if (ownTxn) {
                try { await db.run('ROLLBACK'); } catch { /* keep the original error */ }
            }
            throw err;
        }

        if (rowsReanonymized > 0) {
            await invalidateIdentityCaches();
            logInfo(
                `IdentityAliasEffectsService.onAliasUnlinked: '${name}' released by ${userId} — ` +
                `${rowsReanonymized} row(s) re-anonymized`,
            );
        }
        return { rowsReanonymized };
    }
}

/**
 * (a) Fold every `room_members` row keyed on this alias's synthetic id onto the
 * real account. Returns how many synthetic rows disappeared.
 *
 * Two branches per room:
 *   • the real account is ALREADY a member -> keep the real row, pull the
 *     EARLIER `joined_at` onto it (the synthetic row is the older evidence of
 *     when this person first showed up), adopt the synthetic row's per-room
 *     display name if the real row has none, then delete the synthetic row.
 *     Deletion happens FIRST because `idx_room_members_room_display_unique` is
 *     a partial UNIQUE on `(room_id, LOWER(display_name))` — writing the name
 *     onto the real row while the synthetic still holds it would collide.
 *   • the real account is NOT a member -> just re-key the row. `source` and
 *     `display_name` ride along; the membership is the same membership.
 */
async function foldSyntheticMembersFor(db: Db, userId: string, name: string): Promise<number> {
    const syntheticId = `iscored:${name}`;
    const rows = await db.all(
        `SELECT user_id, room_id, joined_at, display_name
           FROM room_members
          WHERE LOWER(user_id) = LOWER(?)`,
        syntheticId,
    ) as Array<{ user_id: string; room_id: string; joined_at: string | null; display_name: string | null }>;

    let folded = 0;
    for (const row of rows) {
        const real = await db.get(
            `SELECT joined_at, display_name FROM room_members WHERE user_id = ? AND room_id = ?`,
            userId, row.room_id,
        ) as { joined_at: string | null; display_name: string | null } | undefined;

        if (real) {
            await db.run(
                `DELETE FROM room_members WHERE user_id = ? AND room_id = ?`,
                row.user_id, row.room_id,
            );
            const joinedAt = earliest(real.joined_at, row.joined_at);
            const displayName = real.display_name ?? row.display_name ?? null;
            await db.run(
                `UPDATE room_members SET joined_at = ?, display_name = ? WHERE user_id = ? AND room_id = ?`,
                joinedAt, displayName, userId, row.room_id,
            );
        } else {
            await db.run(
                `UPDATE room_members SET user_id = ? WHERE user_id = ? AND room_id = ?`,
                userId, row.user_id, row.room_id,
            );
        }
        folded++;
    }
    return folded;
}

/** ISO/SQLite timestamps sort lexicographically, so MIN is a string compare. */
function earliest(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    return a <= b ? a : b;
}

/**
 * (b) Re-attribute the synced rows nobody owns to the account that now holds
 * the alias. ALL rooms — a `user_mappings` row is global, so scoping this to
 * one room would leave the same double-row bug standing on every other board
 * the name plays on.
 *
 * `submitted_by_user_id IS NULL AND discord_user_id LIKE 'iscored:%'` is the
 * poller's own "nobody owns this row" signature — the same pair
 * `IdentityAutoLinkService.autoLinkForUser` already treats as unowned.
 * `merged_from_anonymous_identity_id IS NULL` keeps merge-owned rows out (they
 * belong to a reversible merge record and must only move through MergeService).
 */
async function attributeUnownedSyncRows(db: Db, userId: string, name: string): Promise<number> {
    const sh = await db.run(
        `UPDATE score_history
            SET submitted_by_user_id = ?,
                discord_user_id = ?,
                submitted_by_anonymous_name = NULL
          WHERE source = 'sync'
            AND LOWER(iscored_username) = LOWER(?)
            AND submitted_by_user_id IS NULL
            AND discord_user_id LIKE 'iscored:%'
            AND merged_from_anonymous_identity_id IS NULL
            AND ${FREEZE_GATE}`,
        userId, userId, name,
    );
    const sub = await db.run(
        `UPDATE submissions
            SET submitted_by_user_id = ?,
                discord_user_id = ?,
                submitted_by_anonymous_name = NULL
          WHERE LOWER(iscored_username) = LOWER(?)
            AND submitted_by_user_id IS NULL
            AND discord_user_id LIKE 'iscored:%'
            AND merged_from_anonymous_identity_id IS NULL
            AND ${FREEZE_GATE}`,
        userId, userId, name,
    );
    return (sh.changes ?? 0) + (sub.changes ?? 0);
}
