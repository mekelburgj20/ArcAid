/**
 * W48 (v2.180.0) — `balls=` on `GET /api/witness/score`: the launcher's own
 * per-ball points for one game, raw, in ball order, as the cabinet (1.0.6+)
 * read them (`balls=2149140,2778720`). Stored on the score's evidence row for a
 * later per-ball format (best ball); nothing reads it for a board or a rank.
 *
 * When the score came from the launcher's own final total, `score - sum(balls)`
 * is what the table scored after the last recorded ball: the unrecorded final
 * ball on a table whose launcher never records it (America's Most Haunted), or
 * the end-of-game bonus on one that does.
 *
 * Like every other evidence param: malformed means DROPPED (null), never a 400
 * — the score is the record, this is about it.
 */
export const MAX_BALL_ENTRIES = 64;

export function parseBallPoints(raw: unknown): number[] | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1200) return null;
    const parts = raw.split(',');
    if (parts.length > MAX_BALL_ENTRIES) return null;
    const out: number[] = [];
    for (const p of parts) {
        if (!/^\d{1,16}$/.test(p)) return null;
        const n = Number(p);
        if (!Number.isSafeInteger(n)) return null;
        out.push(n);
    }
    return out;
}
