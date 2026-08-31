/**
 * Admin score CORRECTION — the ownership gate and the fetch call.
 *
 * Sibling of `lib/scoreDelete.ts`, deliberately kept apart because the two
 * answer different questions. Delete asks "should this score exist?" and is
 * available to the score's owner. Correct asks "is this the right number?" and
 * is ADMIN-ONLY: a player who can rewrite their own score has not been given a
 * correction tool, they have been given an edit-the-leaderboard tool.
 *
 * Backs `PATCH /api/rooms/:roomId/score-history/:historyId/score`. As with
 * `canDeleteRow`, the gate here mirrors the server's rule so the UI doesn't
 * offer a button that will 403 — it is NOT the enforcement point.
 */

import type { ViewerClaims } from './viewerClaims';
import { isRoomAdminFor } from './viewerClaims';
import { rowHistoryId, type DeletableRowLike } from './scoreDelete';

/**
 * Whether the viewer may correct `row` in `roomId`.
 *
 * No `source` filter, unlike `canDeleteRow`: the server accepts a correction
 * on any source, because a typo is a typo whatever wrote the row.
 */
export function canCorrectRow(
  row: DeletableRowLike,
  claims: ViewerClaims | null,
  roomId: string | undefined,
): boolean {
  if (!claims || !roomId) return false;
  if (rowHistoryId(row) == null) return false;
  return isRoomAdminFor(claims, roomId);
}

export interface CorrectScoreResult {
  score: number;
  previousScore: number;
  /**
   * Set when the correction went DOWN on a game mirrored to iScored: the old
   * value is now tombstoned so `ScoreSyncPoller` cannot re-import it. Worth
   * surfacing — it also suppresses any future score below that mark until an
   * admin clears it from Manage Scores → Suppressions.
   */
  suppressedAt: number | null;
}

/**
 * PATCH one score_history row's value. Resolves to a result or an error
 * message the caller can toast — never throws for an HTTP failure.
 */
export async function correctScoreHistory(
  roomId: string,
  historyId: number,
  score: number,
  playerToken: string | null,
): Promise<{ ok: true; result: CorrectScoreResult } | { ok: false; error: string }> {
  if (!playerToken) return { ok: false, error: 'You must be signed in to correct a score' };
  if (!Number.isSafeInteger(score) || score < 0) {
    return { ok: false, error: 'Enter a whole number of 0 or more' };
  }
  try {
    const res = await fetch(`/api/rooms/${roomId}/score-history/${historyId}/score`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ score }),
    });
    const body = await res.json().catch(() => ({} as { error?: string }));
    if (!res.ok) return { ok: false, error: body.error || 'Failed to correct score' };
    return {
      ok: true,
      result: {
        score: (body as CorrectScoreResult).score ?? score,
        previousScore: (body as CorrectScoreResult).previousScore ?? score,
        suppressedAt: (body as CorrectScoreResult).suppressedAt ?? null,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to correct score' };
  }
}
