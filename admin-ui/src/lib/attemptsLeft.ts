/**
 * W81 — how many attempts a player has LEFT on one table of a
 * Limited-attempts tournament (ADR 0029). ONE rule on every surface (the
 * admin Attempts section, the public game page, the runner's Witness page and
 * the cabinet's attempts line agree): left = max(0, limit − the player's
 * USED attempts on that table). Used = `counted`, `scored` and `unreported`
 * rows (the server's `USED_STATUS_SQL`); a void gives one back; an
 * over-the-limit row used no slot and counts nothing (W85 — counting it printed
 * "15 of 5" and forced 0 left even after a void had freed a slot). A player
 * who never started the table is absent — absent means every attempt is left.
 */

export function attemptsLeft(limit: number, used: number): number {
    return Math.max(0, limit - used);
}

/** The row statuses that used a slot — the FE twin of the server's `USED_STATUS_SQL`. */
const USED_STATUSES: ReadonlySet<string> = new Set(['counted', 'scored', 'unreported']);

/** One player's standing on one table, as a summary line reads it. */
export type AttemptSummary = { userId: string; label: string; used: number; left: number };

/** The fields of an admin attempt row the summary reads. */
export type AttemptSummaryInput = { userId: string; playerLabel: string; status: string };

/**
 * One table's rows → one entry per player, fewest left first, then by name.
 * Counted from the rows themselves (the rows are the truth: the admin list
 * rewrites a voided row in place before it is re-read, so a server-sent
 * `used` can be a step behind). A player whose only rows are void is listed
 * with all of them left.
 */
export function summarizeAttempts(rows: AttemptSummaryInput[], limit: number): AttemptSummary[] {
    const byPlayer = new Map<string, { label: string; used: number }>();
    for (const r of rows) {
        const p = byPlayer.get(r.userId) ?? { label: r.playerLabel, used: 0 };
        if (USED_STATUSES.has(r.status)) p.used += 1;
        byPlayer.set(r.userId, p);
    }
    return [...byPlayer.entries()]
        .map(([userId, p]) => ({ userId, label: p.label, used: p.used, left: attemptsLeft(limit, p.used) }))
        .sort((a, b) => a.left - b.left || a.label.localeCompare(b.label));
}
