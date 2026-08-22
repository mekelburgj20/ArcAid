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
 * The tooltip companion to `formatScore`. Only abbreviated (≥1T) renders lose
 * information, so only those get a `title`; everything else already shows the
 * exact digits and a redundant tooltip is noise. Returns `undefined` so it can
 * be spread straight into a `title=` prop.
 */
export function scoreTitle(n: number | null | undefined): string | undefined {
    if (n == null) return undefined;
    return n >= 1_000_000_000_000 ? n.toLocaleString() : undefined;
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

/**
 * The backend serves many timestamps straight from SQLite
 * `DEFAULT (datetime('now'))` columns as `"YYYY-MM-DD HH:MM:SS"` — that value
 * IS UTC, but carries no `T` or `Z`, so the native `Date` constructor (and
 * every browser) parses it as LOCAL time. For a viewer west of UTC that lands
 * the instant in the future; every relative-time formatter built on
 * `Date.now() - parsed` then goes negative and reads "just now" no matter how
 * old the row actually is.
 *
 * Other timestamps the app ships ARE already proper ISO
 * (`2026-08-22T05:33:10.123Z`) — e.g. WebSocket payloads, anything built with
 * `new Date().toISOString()`. Those already carry a zone designator, so the
 * native parser is correct for them and is left alone.
 *
 * This is the ONE place that tells the two apart: a bare
 * `YYYY-MM-DD HH:MM[:SS[.sss]]` string (space or `T` separator, no zone) is
 * treated as UTC; anything else (including a string with `Z` or a `±HH:MM`
 * offset, or an already-malformed value) is handed to `new Date(value)`
 * as-is.
 */
export function parseServerDate(value: string | null | undefined): Date | null {
    if (value == null || value === '') return null;
    const bareUtcPattern = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
    const parsed = bareUtcPattern.test(value)
        ? new Date(`${value.replace(' ', 'T')}Z`)
        : new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The single canonical "N ago" relative-time formatter. Parses through
 * `parseServerDate` so bare SQLite timestamps and proper ISO strings both
 * land on the correct instant — see that function's doc comment for why the
 * distinction matters.
 *
 * `now` is injectable for tests; defaults to the real clock.
 */
export function relativeTimeFrom(value: string | null | undefined, now: number = Date.now()): string {
    const parsed = parseServerDate(value);
    if (!parsed) return '';
    const diffMs = now - parsed.getTime();
    // Small negative diffs are clock skew, not the future — still "just now".
    if (diffMs < 60_000) return 'just now';
    const minutes = Math.floor(diffMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const nowDate = new Date(now);
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
    if (parsed.getFullYear() !== nowDate.getFullYear()) opts.year = 'numeric';
    return parsed.toLocaleDateString(undefined, opts);
}
