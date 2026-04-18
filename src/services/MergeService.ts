import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { logError, logInfo } from '../utils/logger.js';
import type { MergeRecord } from '../types/index.js';

/**
 * Anonymous-identity merge service (Sprint 11, plan §15 and tmp/sprint-02-merge-model.md).
 *
 * Operates exclusively on rows where `submitted_by_user_id IS NULL AND
 * merged_from_anonymous_identity_id IS NULL` (rows the user hasn't already
 * claimed and an earlier merge hasn't touched). Scope is room-scoped via
 * `anonymous_identities.room_id`; cross-room merges are out-of-scope.
 *
 * Separate from the legacy sync-alias rename at `src/api/routes/rooms.ts:2075`.
 * The two paths share zero rows (sync-alias rename does not read the Sprint 1
 * context columns; identity merge requires them to be `IS NULL`).
 */

export type RowRef = {
    submissions: string[];
    community_scores: number[];
    score_history: number[];
    global_scores: string[];
};

export type FrozenGroup = {
    tournamentId: string;
    tournamentName: string;
    completedAt: string;
    rowCount: number;
};

export type MergePreview = {
    anonymousIdentityId: number;
    anonymousNickname: string;
    targetDiscordUserId: string;
    willMove: RowRef;
    frozenStay: FrozenGroup[];
    totalMovingRows: number;
    totalFrozenRows: number;
    frozenTournamentIdsAtMerge: string[];
    previewHash: string;
};

export type ReversalPreview = {
    mergeId: number;
    mergedAt: string;
    targetDiscordUserId: string;
    anonymousIdentityId: number;
    willReturn: RowRef;
    willStay: FrozenGroup[];
    totalReturningRows: number;
    totalStayingRows: number;
};

export type MergeInput = {
    roomId: string;
    anonymousIdentityId: number;
    targetDiscordUserId: string;
    adminDiscordUserId: string;
    reason?: string;
    previewHash: string;
};

export type ReverseInput = {
    mergeId: number;
    reversalAdminId: string;
    reason?: string;
};

type ScoreSnapshot = {
    submissions: string[];
    community_scores: number[];
    score_history: number[];
    global_scores: string[];
    frozen_tournament_ids_at_merge: string[];
};

function emptyRowRef(): RowRef {
    return { submissions: [], community_scores: [], score_history: [], global_scores: [] };
}

function hashPreview(identityId: number, targetUserId: string, rows: RowRef, frozen: string[]): string {
    const payload = JSON.stringify({
        identityId,
        targetUserId,
        submissions: [...rows.submissions].sort(),
        community_scores: [...rows.community_scores].sort((a, b) => a - b),
        score_history: [...rows.score_history].sort((a, b) => a - b),
        global_scores: [...rows.global_scores].sort(),
        frozen: [...frozen].sort(),
    });
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function invalidateCaches(): Promise<void> {
    try {
        const { LeaderboardService } = await import('./LeaderboardService.js');
        LeaderboardService.invalidateAll();
    } catch (err) {
        logError('MergeService: LeaderboardService.invalidateAll failed', err);
    }
    try {
        const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
        GlobalLeaderboardService.invalidateAll();
    } catch (err) {
        logError('MergeService: GlobalLeaderboardService.invalidateAll failed', err);
    }
}

export class MergeService {
    /**
     * Runs the scope filter and returns the set of rows that would move, plus
     * the frozen-tournament groups that would NOT move. No writes.
     */
    static async previewMerge(
        roomId: string,
        anonymousIdentityId: number,
        targetDiscordUserId: string,
    ): Promise<MergePreview> {
        const db = await getDatabase();

        const identity = await db.get(
            `SELECT id, server_nickname, room_id, status FROM anonymous_identities WHERE id = ?`,
            anonymousIdentityId,
        );
        if (!identity) throw new Error('anonymous identity not found');
        if (identity.room_id && identity.room_id !== roomId) throw new Error('anonymous identity not in room');
        if (identity.status !== 'active') throw new Error(`anonymous identity is ${identity.status}, not mergeable`);

        const nick = identity.server_nickname as string;
        const willMove = emptyRowRef();
        const frozenByTournament = new Map<string, { name: string; completedAt: string; count: number }>();

        // For each score table, find rows matching the anon nickname in this room that aren't already attributed.
        // Community scores are room-scoped via game_room_id.
        const csRows = await db.all(
            `SELECT id, submitted_during_tournament_id
             FROM community_scores
             WHERE game_room_id = ?
               AND submitted_by_user_id IS NULL
               AND merged_from_anonymous_identity_id IS NULL
               AND LOWER(submitted_by_anonymous_name) = LOWER(?)`,
            roomId,
            nick,
        );
        // Submissions: room context via submitted_from_room_id (Sprint 1) with a games→tournaments fallback for older rows.
        const subRows = await db.all(
            `SELECT s.id, s.submitted_during_tournament_id, s.game_id
             FROM submissions s
             LEFT JOIN games g ON g.id = s.game_id
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE s.submitted_by_user_id IS NULL
               AND s.merged_from_anonymous_identity_id IS NULL
               AND LOWER(s.submitted_by_anonymous_name) = LOWER(?)
               AND (s.submitted_from_room_id = ? OR t.game_room_id = ?)`,
            nick,
            roomId,
            roomId,
        );
        const shRows = await db.all(
            `SELECT id, submitted_during_tournament_id
             FROM score_history
             WHERE submitted_from_room_id = ?
               AND submitted_by_user_id IS NULL
               AND merged_from_anonymous_identity_id IS NULL
               AND LOWER(submitted_by_anonymous_name) = LOWER(?)`,
            roomId,
            nick,
        );
        const gsRows = await db.all(
            `SELECT id, submitted_during_tournament_id
             FROM global_scores
             WHERE submitted_from_room_id = ?
               AND submitted_by_user_id IS NULL
               AND merged_from_anonymous_identity_id IS NULL
               AND LOWER(submitted_by_anonymous_name) = LOWER(?)
               AND deleted_at IS NULL`,
            roomId,
            nick,
        );

        // Resolve which referenced tournaments are currently frozen (completed).
        const allTournamentIds = new Set<string>();
        for (const r of [...csRows, ...subRows, ...shRows, ...gsRows]) {
            if (r.submitted_during_tournament_id) allTournamentIds.add(r.submitted_during_tournament_id);
        }
        const frozenIds = new Set<string>();
        const tournamentMeta = new Map<string, { name: string; completedAt: string }>();
        if (allTournamentIds.size > 0) {
            const placeholders = [...allTournamentIds].map(() => '?').join(',');
            const tRows = await db.all(
                `SELECT id, name, end_date, start_date, is_active FROM tournaments WHERE id IN (${placeholders})`,
                ...[...allTournamentIds],
            );
            for (const t of tRows) {
                const completed = !t.is_active && !!t.end_date;
                if (completed) {
                    frozenIds.add(t.id);
                    tournamentMeta.set(t.id, { name: t.name, completedAt: t.end_date });
                }
            }
        }

        const route = <T extends { id: unknown; submitted_during_tournament_id: string | null }>(
            rows: T[],
            bucket: 'submissions' | 'community_scores' | 'score_history' | 'global_scores',
        ) => {
            for (const r of rows) {
                if (r.submitted_during_tournament_id && frozenIds.has(r.submitted_during_tournament_id)) {
                    const t = tournamentMeta.get(r.submitted_during_tournament_id)!;
                    const grp = frozenByTournament.get(r.submitted_during_tournament_id) ?? {
                        name: t.name,
                        completedAt: t.completedAt,
                        count: 0,
                    };
                    grp.count += 1;
                    frozenByTournament.set(r.submitted_during_tournament_id, grp);
                } else {
                    if (bucket === 'submissions') willMove.submissions.push(r.id as string);
                    else if (bucket === 'community_scores') willMove.community_scores.push(r.id as number);
                    else if (bucket === 'score_history') willMove.score_history.push(r.id as number);
                    else willMove.global_scores.push(r.id as string);
                }
            }
        };
        route(subRows, 'submissions');
        route(csRows, 'community_scores');
        route(shRows, 'score_history');
        route(gsRows, 'global_scores');

        const frozenStay: FrozenGroup[] = [...frozenByTournament.entries()].map(([tournamentId, meta]) => ({
            tournamentId,
            tournamentName: meta.name,
            completedAt: meta.completedAt,
            rowCount: meta.count,
        }));
        const totalMovingRows =
            willMove.submissions.length +
            willMove.community_scores.length +
            willMove.score_history.length +
            willMove.global_scores.length;
        const totalFrozenRows = frozenStay.reduce((a, g) => a + g.rowCount, 0);
        const frozenTournamentIdsAtMerge = [...frozenIds];
        const previewHash = hashPreview(anonymousIdentityId, targetDiscordUserId, willMove, frozenTournamentIdsAtMerge);

        return {
            anonymousIdentityId,
            anonymousNickname: nick,
            targetDiscordUserId,
            willMove,
            frozenStay,
            totalMovingRows,
            totalFrozenRows,
            frozenTournamentIdsAtMerge,
            previewHash,
        };
    }

    /**
     * Confirms a merge. Re-runs the preview inside a transaction; if the
     * preview hash would differ, raises `MERGE_CONFLICT` (callers should
     * surface 409 + refreshed preview to the admin). Writes `merge_records`,
     * updates the 4 score tables, flips `anonymous_identities.status`, and
     * invalidates leaderboard caches.
     */
    static async recordMerge(input: MergeInput): Promise<{ mergeId: number; movedRows: number }> {
        const db = await getDatabase();
        const fresh = await this.previewMerge(input.roomId, input.anonymousIdentityId, input.targetDiscordUserId);
        if (fresh.previewHash !== input.previewHash) {
            const err = new Error('MERGE_CONFLICT: preview drifted since the admin reviewed it');
            (err as Error & { code?: string; fresh?: MergePreview }).code = 'MERGE_CONFLICT';
            (err as Error & { fresh?: MergePreview }).fresh = fresh;
            throw err;
        }

        const snapshot: ScoreSnapshot = {
            submissions: fresh.willMove.submissions,
            community_scores: fresh.willMove.community_scores,
            score_history: fresh.willMove.score_history,
            global_scores: fresh.willMove.global_scores,
            frozen_tournament_ids_at_merge: fresh.frozenTournamentIdsAtMerge,
        };

        await db.run('BEGIN');
        try {
            const result = await db.run(
                `INSERT INTO merge_records (anonymous_identity_id, target_discord_user_id, admin_discord_user_id, score_ids_snapshot, reason)
                 VALUES (?, ?, ?, ?, ?)`,
                input.anonymousIdentityId,
                input.targetDiscordUserId,
                input.adminDiscordUserId,
                JSON.stringify(snapshot),
                input.reason ?? null,
            );
            const mergeId = result.lastID as number;

            // Bulk UPDATEs. SQLite doesn't accept array bindings in IN (...) so we build placeholders.
            const apply = async (
                table: 'submissions' | 'community_scores' | 'score_history' | 'global_scores',
                ids: (string | number)[],
            ) => {
                if (ids.length === 0) return;
                const placeholders = ids.map(() => '?').join(',');
                await db.run(
                    `UPDATE ${table}
                     SET submitted_by_user_id = ?, merged_from_anonymous_identity_id = ?
                     WHERE id IN (${placeholders})
                       AND submitted_by_user_id IS NULL
                       AND merged_from_anonymous_identity_id IS NULL`,
                    input.targetDiscordUserId,
                    mergeId,
                    ...ids,
                );
            };
            await apply('submissions', snapshot.submissions);
            await apply('community_scores', snapshot.community_scores);
            await apply('score_history', snapshot.score_history);
            await apply('global_scores', snapshot.global_scores);

            await db.run(
                `UPDATE anonymous_identities SET status = 'merged' WHERE id = ?`,
                input.anonymousIdentityId,
            );
            await db.run('COMMIT');

            await invalidateCaches();
            logInfo(`MergeService.recordMerge: merge ${mergeId} — ${fresh.totalMovingRows} rows → ${input.targetDiscordUserId}`);
            return { mergeId, movedRows: fresh.totalMovingRows };
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    }

    /**
     * Builds the reversal preview. Walks the snapshot and applies the
     * freeze check against the current tournaments table: rows whose
     * tournament was frozen at merge time, or has completed since, stay.
     */
    static async previewReversal(mergeId: number): Promise<ReversalPreview> {
        const db = await getDatabase();
        const row = await this.getMergeRecord(mergeId);
        if (!row) throw new Error('merge record not found');
        if (row.reversedAt) throw new Error('merge already reversed');

        const snapshot: ScoreSnapshot = JSON.parse(row.scoreIdsSnapshot || '{}');
        const frozenAtMerge = new Set<string>(snapshot.frozen_tournament_ids_at_merge || []);

        // Fresh-check any referenced tournaments in the snapshot for "completed now".
        const snapshotTournamentIds = new Set<string>();
        const lookup = async (
            table: 'submissions' | 'community_scores' | 'score_history' | 'global_scores',
            ids: (string | number)[],
        ): Promise<Array<{ id: string | number; submitted_during_tournament_id: string | null }>> => {
            if (ids.length === 0) return [];
            const placeholders = ids.map(() => '?').join(',');
            return (await db.all(
                `SELECT id, submitted_during_tournament_id FROM ${table} WHERE id IN (${placeholders})`,
                ...ids,
            )) as Array<{ id: string | number; submitted_during_tournament_id: string | null }>;
        };
        const subRows = await lookup('submissions', snapshot.submissions || []);
        const csRows = await lookup('community_scores', snapshot.community_scores || []);
        const shRows = await lookup('score_history', snapshot.score_history || []);
        const gsRows = await lookup('global_scores', snapshot.global_scores || []);
        for (const r of [...subRows, ...csRows, ...shRows, ...gsRows]) {
            if (r.submitted_during_tournament_id) snapshotTournamentIds.add(r.submitted_during_tournament_id);
        }

        const frozenNow = new Set<string>();
        const tournamentMeta = new Map<string, { name: string; completedAt: string }>();
        if (snapshotTournamentIds.size > 0) {
            const placeholders = [...snapshotTournamentIds].map(() => '?').join(',');
            const tRows = await db.all(
                `SELECT id, name, end_date, is_active FROM tournaments WHERE id IN (${placeholders})`,
                ...[...snapshotTournamentIds],
            );
            for (const t of tRows) {
                if (!t.is_active && t.end_date) {
                    frozenNow.add(t.id);
                    tournamentMeta.set(t.id, { name: t.name, completedAt: t.end_date });
                }
            }
        }

        const willReturn = emptyRowRef();
        const frozenGroups = new Map<string, { name: string; completedAt: string; count: number }>();
        const classify = <T extends { id: unknown; submitted_during_tournament_id: string | null }>(
            rows: T[],
            bucket: 'submissions' | 'community_scores' | 'score_history' | 'global_scores',
        ) => {
            for (const r of rows) {
                const tid = r.submitted_during_tournament_id || '';
                const frozen = tid && (frozenAtMerge.has(tid) || frozenNow.has(tid));
                if (frozen) {
                    const meta = tournamentMeta.get(tid);
                    if (!meta) continue;
                    const grp = frozenGroups.get(tid) ?? { name: meta.name, completedAt: meta.completedAt, count: 0 };
                    grp.count += 1;
                    frozenGroups.set(tid, grp);
                } else {
                    if (bucket === 'submissions') willReturn.submissions.push(r.id as string);
                    else if (bucket === 'community_scores') willReturn.community_scores.push(r.id as number);
                    else if (bucket === 'score_history') willReturn.score_history.push(r.id as number);
                    else willReturn.global_scores.push(r.id as string);
                }
            }
        };
        classify(subRows, 'submissions');
        classify(csRows, 'community_scores');
        classify(shRows, 'score_history');
        classify(gsRows, 'global_scores');

        const willStay: FrozenGroup[] = [...frozenGroups.entries()].map(([tournamentId, meta]) => ({
            tournamentId,
            tournamentName: meta.name,
            completedAt: meta.completedAt,
            rowCount: meta.count,
        }));
        const totalReturningRows =
            willReturn.submissions.length +
            willReturn.community_scores.length +
            willReturn.score_history.length +
            willReturn.global_scores.length;
        const totalStayingRows = willStay.reduce((a, g) => a + g.rowCount, 0);

        return {
            mergeId: row.id,
            mergedAt: row.createdAt,
            targetDiscordUserId: row.targetDiscordUserId,
            anonymousIdentityId: row.anonymousIdentityId,
            willReturn,
            willStay,
            totalReturningRows,
            totalStayingRows,
        };
    }

    static async reverseMerge(input: ReverseInput): Promise<{ reversed: true; returned: number; staying: number }> {
        const db = await getDatabase();
        const preview = await this.previewReversal(input.mergeId);

        await db.run('BEGIN');
        try {
            const undo = async (
                table: 'submissions' | 'community_scores' | 'score_history' | 'global_scores',
                ids: (string | number)[],
            ) => {
                if (ids.length === 0) return;
                const placeholders = ids.map(() => '?').join(',');
                await db.run(
                    `UPDATE ${table}
                     SET submitted_by_user_id = NULL, merged_from_anonymous_identity_id = NULL
                     WHERE id IN (${placeholders})
                       AND merged_from_anonymous_identity_id = ?`,
                    ...ids,
                    input.mergeId,
                );
            };
            await undo('submissions', preview.willReturn.submissions);
            await undo('community_scores', preview.willReturn.community_scores);
            await undo('score_history', preview.willReturn.score_history);
            await undo('global_scores', preview.willReturn.global_scores);

            await db.run(
                `UPDATE merge_records
                 SET reversed_at = datetime('now'), reversal_admin_id = ?, reason = COALESCE(reason, ?)
                 WHERE id = ?`,
                input.reversalAdminId,
                input.reason ?? null,
                input.mergeId,
            );
            // Flip identity back to active only if no other live merge still attributes rows to it.
            const liveCount = await db.get(
                `SELECT COUNT(*) AS c FROM merge_records
                 WHERE anonymous_identity_id = (SELECT anonymous_identity_id FROM merge_records WHERE id = ?)
                   AND reversed_at IS NULL
                   AND id != ?`,
                input.mergeId,
                input.mergeId,
            );
            if (!liveCount || liveCount.c === 0) {
                await db.run(
                    `UPDATE anonymous_identities
                     SET status = 'active'
                     WHERE id = (SELECT anonymous_identity_id FROM merge_records WHERE id = ?)`,
                    input.mergeId,
                );
            }
            await db.run('COMMIT');

            await invalidateCaches();
            logInfo(`MergeService.reverseMerge: merge ${input.mergeId} reversed — ${preview.totalReturningRows} rows returned, ${preview.totalStayingRows} stayed (frozen)`);
            return { reversed: true, returned: preview.totalReturningRows, staying: preview.totalStayingRows };
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    }

    /** Room-scoped: only records whose anonymous identity belongs to this room. */
    static async listMergeHistory(roomId: string, limit = 50): Promise<MergeRecord[]> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT mr.*
             FROM merge_records mr
             JOIN anonymous_identities ai ON ai.id = mr.anonymous_identity_id
             WHERE ai.room_id = ?
             ORDER BY mr.created_at DESC
             LIMIT ?`,
            roomId,
            limit,
        );
        return rows.map(rowToMergeRecord);
    }

    static async getMergeRecord(mergeId: number): Promise<MergeRecord | null> {
        const db = await getDatabase();
        const row = await db.get(`SELECT * FROM merge_records WHERE id = ?`, mergeId);
        return row ? rowToMergeRecord(row) : null;
    }
}

function rowToMergeRecord(row: Record<string, unknown>): MergeRecord {
    return {
        id: row.id as number,
        anonymousIdentityId: row.anonymous_identity_id as number,
        targetDiscordUserId: row.target_discord_user_id as string,
        adminDiscordUserId: row.admin_discord_user_id as string,
        createdAt: row.created_at as string,
        reversedAt: (row.reversed_at as string | null) ?? null,
        reversalAdminId: (row.reversal_admin_id as string | null) ?? null,
        scoreIdsSnapshot: (row.score_ids_snapshot as string) ?? '{}',
        reason: (row.reason as string | null) ?? null,
    };
}
