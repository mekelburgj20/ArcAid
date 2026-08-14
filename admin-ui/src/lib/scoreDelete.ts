/**
 * Per-row score deletion — the shared ownership gate and the fetch call,
 * v2.108.0 (F2).
 *
 * Backs `DELETE /api/rooms/:roomId/score-history/:historyId`, whose server-side
 * tiers are: super_admin → any row; room_admin → any row in a room they
 * administer; player → only rows where `submitted_by_user_id` matches their own
 * Discord id. `canDeleteRow` mirrors those tiers so the UI doesn't offer a
 * button that will 403 — it is NOT the enforcement point.
 */

import type { ViewerClaims } from './viewerClaims';
import { isRoomAdminFor } from './viewerClaims';

/** The subset of a ranked/history row this gate reads. */
export interface DeletableRowLike {
  /** `score_history.id`. Absent means the producer didn't ship one — not deletable. */
  history_id?: number | null;
  id?: number | null;
  /**
   * RAW `score_history.submitted_by_user_id`. NEVER `discord_user_id`: that one
   * is a resolved DISPLAY identity (an `iscored:*` synthetic resolves through
   * `user_mappings`), so an alias holder would inherit delete rights over rows
   * they never submitted.
   */
  submitted_by_user_id?: string | null;
  /** `tournament` | `sync` | `community` — all three are deletable as of v2.108.0. */
  source?: string | null;
}

/** The `score_history.id` this row deletes, or null when it ships none. */
export function rowHistoryId(row: DeletableRowLike): number | null {
  return row.history_id ?? row.id ?? null;
}

/**
 * True when `row` is the viewer's OWN submission. The only ownership test in
 * the app — raw column against the token's Discord id, both non-empty.
 */
export function isOwnScoreRow(row: DeletableRowLike, claims: ViewerClaims | null): boolean {
  if (!claims?.discordId) return false;
  return !!row.submitted_by_user_id && row.submitted_by_user_id === claims.discordId;
}

/**
 * Whether the viewer may delete `row` in `roomId`.
 *
 * v2.108.0: `source` is no longer a gate — the community cascade
 * (`ScoreHistoryService.deleteCommunityScoreTwin`) shipped, so
 * tournament/sync/community rows are all deletable. A row with an UNKNOWN
 * source is still refused: the server's allowlist would reject it anyway.
 */
export function canDeleteRow(
  row: DeletableRowLike,
  claims: ViewerClaims | null,
  roomId: string | undefined,
): boolean {
  if (!claims || !roomId) return false;
  if (rowHistoryId(row) == null) return false;
  const source = row.source;
  if (source != null && source !== 'tournament' && source !== 'sync' && source !== 'community') return false;
  if (isRoomAdminFor(claims, roomId)) return true;
  return isOwnScoreRow(row, claims);
}

/**
 * v2.108.0 (F3) — what a click on the viewer's OWN score row does on a
 * scoreboard card: open the game's quick popup, where the score can be
 * inspected and deleted.
 *
 * Threaded as ONE optional prop through every card family so that a card
 * without it behaves exactly as it did before. `viewerDiscordId` is the raw id
 * from the viewer's token claims; `open` is bound to the card's own game by
 * whichever page owns the `GameQuickView` instance.
 */
export interface OwnRowOpen {
  viewerDiscordId: string;
  open: () => void;
}

/**
 * Tooltip on an own row. The affordance is deliberately quiet — a chevron and
 * a pointer cursor — so this is what explains it on hover.
 */
export const OWN_ROW_HINT = 'Your score — open to manage';

/**
 * The click handler for `row`, or `undefined` when the row is not the
 * viewer's own (or the feature isn't wired). Ownership is the RAW
 * `submitted_by_user_id` — the same column the server's self-delete gate uses.
 */
export function ownRowOpener(row: DeletableRowLike, own?: OwnRowOpen | null): (() => void) | undefined {
  if (!own?.viewerDiscordId) return undefined;
  if (!row.submitted_by_user_id || row.submitted_by_user_id !== own.viewerDiscordId) return undefined;
  return own.open;
}

/**
 * DELETE one score_history row. Resolves to `{ ok: true }` or an error message
 * the caller can toast — never throws for an HTTP failure.
 */
export async function deleteScoreHistory(
  roomId: string,
  historyId: number,
  playerToken: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!playerToken) return { ok: false, error: 'You must be signed in to delete a score' };
  try {
    const res = await fetch(`/api/rooms/${roomId}/score-history/${historyId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${playerToken}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as { error?: string }));
      return { ok: false, error: body.error || 'Failed to delete score' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to delete score' };
  }
}
