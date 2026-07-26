import { BLOCKED_TERMS } from './blocklistTerms.js';

/**
 * S22 Phase 1 content moderation — normalization + blocklist check for
 * user-supplied names (room name/slug, tournament name, display name,
 * per-room claimed name). Prevention-only, server-side, at every write
 * chokepoint — see CLAUDE.md "Blocklist" section for the full wiring list.
 *
 * Deliberately NOT a reuse of `catalogueUtils.normalizeGameName` — that
 * helper is tuned for game-title matching (punctuation/whitespace folding
 * for dedup), not evasion-resistant abuse-string matching.
 */

// Zero-width / invisible characters sometimes used to break up a slur so a
// naive substring check misses it: ZERO WIDTH SPACE, ZERO WIDTH NON-JOINER,
// ZERO WIDTH JOINER, LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK (U+200B–U+200F),
// plus ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF). Built from explicit code
// points via String.fromCharCode rather than embedding the literal invisible
// characters in source (which would be unreadable/unreviewable).
const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0xfeff];
const ZERO_WIDTH_RE = new RegExp(
    '[' + ZERO_WIDTH_CODE_POINTS.map((c) => String.fromCharCode(c)).join('') + ']',
    'g',
);

// Combining diacritical marks (U+0300–U+036F) — what NFKD decomposition
// leaves behind after splitting an accented character into base + mark.
// Built as a range from explicit code points, same rationale as above.
const COMBINING_MARKS_RE = new RegExp(
    '[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']',
    'g',
);

// Common l33t-speak substitutions.
const LEET_MAP: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '7': 't',
    '$': 's',
    '@': 'a',
    '8': 'b',
    '!': 'i',
};

const SEPARATOR_RE = /[\s._-]+/g;

function stripDiacritics(input: string): string {
    // NFKD decomposes accented characters into base + combining marks;
    // stripping the combining-marks Unicode range removes the accents.
    return input.normalize('NFKD').replace(COMBINING_MARKS_RE, '');
}

function leetFold(input: string): string {
    let out = '';
    for (const ch of input) out += LEET_MAP[ch] ?? ch;
    return out;
}

/**
 * Normalizes a string for blocklist matching: NFKD-decompose (strips
 * diacritics) → strip zero-width characters → lowercase → l33t-fold.
 * Does NOT collapse separators — see `containsBlockedTerm`, which checks
 * both this view and a separator-collapsed view.
 */
export function normalizeForBlocklist(input: string): string {
    const stripped = stripDiacritics(input).replace(ZERO_WIDTH_RE, '');
    return leetFold(stripped.toLowerCase());
}

/** Removes spaces, dots, underscores, and hyphens — catches "n.i.g.g.e.r"-style insertion. */
function collapseSeparators(input: string): string {
    return input.replace(SEPARATOR_RE, '');
}

/**
 * True if `input` contains any blocked term as a substring of either the
 * raw-normalized view or the separator-collapsed view.
 */
export function containsBlockedTerm(input: string | null | undefined): boolean {
    if (!input) return false;
    const normalized = normalizeForBlocklist(input);
    if (!normalized) return false;
    const collapsed = collapseSeparators(normalized);
    return BLOCKED_TERMS.some((term) => {
        const normalizedTerm = normalizeForBlocklist(term);
        if (normalized.includes(normalizedTerm)) return true;
        return collapsed.includes(collapseSeparators(normalizedTerm));
    });
}

/** Identifies the chokepoint for logging/debugging — not surfaced to the client. */
export type BlocklistKind =
    | 'room_name'
    | 'room_slug'
    | 'tournament_name'
    | 'display_name'
    | 'room_member_name';

/**
 * Throws a coded `NAME_NOT_ALLOWED` error when `value` contains a blocked
 * term. The message deliberately does NOT echo the matched term (don't teach
 * evasion). Callers map this code to a 4xx response.
 */
export function assertNameAllowed(value: string | null | undefined, kind: BlocklistKind): void {
    if (containsBlockedTerm(value)) {
        const err = new Error("This name isn't allowed.") as Error & { code?: string; kind?: BlocklistKind };
        err.code = 'NAME_NOT_ALLOWED';
        err.kind = kind;
        throw err;
    }
}
