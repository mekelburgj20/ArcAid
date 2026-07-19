/**
 * S17 — the single score formatter (replaces 11 page/component-local copies).
 * Scores ≥1T abbreviate to "X.XT" (callers keep their own full-value
 * tooltips); below 1T renders locale-grouped exact digits. Null/undefined →
 * em-dash (previously only the Global pages guarded this; now universal).
 */
export function formatScore(n: number | null | undefined): string {
    if (n == null) return '—';
    if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
    return n.toLocaleString();
}

/**
 * Aggregate-stat compression (T/B/M tiers) — the LandingPage variant.
 * Deliberately distinct from formatScore: leaderboard scores below 1T render
 * exact digits, marketing aggregates compress.
 */
export function formatCompactNumber(n: number): string {
    if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
    if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    return n.toLocaleString();
}
