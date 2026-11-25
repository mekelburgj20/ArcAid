/**
 * W126 (ADR 0043) — `tournaments.practice_games`, the practice allowance of a
 * limited-attempts tournament, as stored and as every reader takes it:
 *
 *   null     players cannot pause their attempts (the default)
 *   0        they can, and practice games are unlimited
 *   1..999   they can, for that many practice games per player per table,
 *            counted over the table's whole run
 *
 * Anything else (a negative, a fraction, text, a blank) is null — never a
 * silent "unlimited". The one parser of the column outside SQL; the rule's own
 * read is inside `AttemptService.insertAtomic`, which tests the same three
 * cases (`IS NOT NULL`, `= 0`, `practice < cap`).
 */
export function normalizePracticeGames(value: unknown): number | null {
    if (value == null || value === '') return null;
    const n = typeof value === 'string' ? Number(value) : value;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 999 ? n : null;
}
