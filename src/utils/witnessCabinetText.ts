/**
 * W105 (v2.249.0, ADR 0040 addendum) - the ONE sanitizer for free text the
 * server sends a cabinet (room, tournament and table names on
 * `/witness/tile`; the paired account through `cabinetAccountLabel`, which
 * narrows its input first and then comes here).
 *
 * The cabinet reads every answer with a naive `"key":"value"` extractor, so a
 * value may hold only printable ASCII (0x20-0x7E) other than `"` and `\`.
 * Anything else (quotes, backslashes, control characters, every non-ASCII
 * character, emoji) is DROPPED, runs of spaces collapse to one, the ends are
 * trimmed and the result is cut at `max` characters (cut, no ellipsis; a
 * space left at the cut is trimmed too). Null when nothing is left: the
 * caller omits the field, it never sends an empty one.
 */
export function cabinetText(value: unknown, max: number): string | null {
    if (typeof value !== 'string') return null;
    const v = value
        .replace(/[^\x20-\x7E]|["\\]/g, '')
        .replace(/ {2,}/g, ' ')
        .trim()
        .slice(0, Math.max(0, Math.floor(max)))
        .trimEnd();
    return v || null;
}
