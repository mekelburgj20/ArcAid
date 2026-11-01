/**
 * W81 — how many attempts a player has LEFT on one table of a
 * Limited-attempts tournament (ADR 0029). ONE rule on every surface (the
 * admin Attempts section, the public game page, the runner's Witness page and
 * the cabinet's attempts line agree): left = max(0, limit − the player's
 * NON-VOID attempts on that table). A void gives one back; a player with an
 * over-the-limit row is at or past the limit and has none left. A player who
 * never started the table is absent — absent means every attempt is left.
 */

export function attemptsLeft(limit: number, used: number, overLimit = false): number {
    if (overLimit) return 0;
    return Math.max(0, limit - used);
}

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
    const byPlayer = new Map<string, { label: string; used: number; over: boolean }>();
    for (const r of rows) {
        const p = byPlayer.get(r.userId) ?? { label: r.playerLabel, used: 0, over: false };
        if (r.status !== 'void') p.used += 1;
        if (r.status === 'over_limit') p.over = true;
        byPlayer.set(r.userId, p);
    }
    return [...byPlayer.entries()]
        .map(([userId, p]) => ({ userId, label: p.label, used: p.used, left: attemptsLeft(limit, p.used, p.over) }))
        .sort((a, b) => a.left - b.left || a.label.localeCompare(b.label));
}
