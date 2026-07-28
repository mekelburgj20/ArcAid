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
// ZERO WIDTH NO-BREAK SPACE / BOM (U+FEFF), plus (m9 hardening) SOFT HYPHEN
// (U+00AD) and WORD JOINER (U+2060) — both invisible-in-rendering characters
// usable for the same insertion trick. Built from explicit code points via
// String.fromCharCode rather than embedding the literal invisible characters
// in source (which would be unreadable/unreviewable).
const ZERO_WIDTH_CODE_POINTS = [0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff];
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

// Common l33t-speak substitutions. '6'/'9' → 'g' (m9 hardening: "ni66er" shape).
// Deliberately NOT adding doubled-letter collapsing here or anywhere else —
// that would multiply M1a's false-positive surface (see collapseSeparators).
const LEET_MAP: Record<string, string> = {
    '0': 'o',
    '1': 'i',
    '3': 'e',
    '4': 'a',
    '5': 's',
    '6': 'g',
    '7': 't',
    '9': 'g',
    '$': 's',
    '@': 'a',
    '8': 'b',
    '!': 'i',
};

// Homoglyph confusables (v2.47.0, S22 follow-ups Workstream 3) — cross-script
// lookalikes that read as a Latin letter in lowercase UI text. Scope is
// DELIBERATELY narrow: only characters that are visually indistinguishable
// from their Latin twin at normal UI sizes. Doubled-letter and `*`/`+`
// separator evasion are accepted-open gaps (out of scope — do not extend this
// map to cover them). When in doubt a character is left OUT: a missed
// confusable is a smaller cost than a false positive on a legitimate
// Greek/Cyrillic name. Applied after NFKD-strip + lowercase (in
// `normalizeForBlocklist`), same single-char-fold pattern as `LEET_MAP`.
const CONFUSABLES_MAP: Record<string, string> = {
    // Cyrillic lookalikes.
    'а': 'a', // а CYRILLIC SMALL LETTER A
    'е': 'e', // е CYRILLIC SMALL LETTER IE
    'о': 'o', // о CYRILLIC SMALL LETTER O
    'р': 'p', // р CYRILLIC SMALL LETTER ER
    'с': 'c', // с CYRILLIC SMALL LETTER ES
    'х': 'x', // х CYRILLIC SMALL LETTER HA
    'у': 'y', // у CYRILLIC SMALL LETTER U
    'к': 'k', // к CYRILLIC SMALL LETTER KA
    'і': 'i', // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
    'ѕ': 's', // ѕ CYRILLIC SMALL LETTER DZE
    'ԁ': 'd', // ԁ CYRILLIC SMALL LETTER KOMI DE
    'һ': 'h', // һ CYRILLIC SMALL LETTER SHHA
    'ѵ': 'v', // ѵ CYRILLIC SMALL LETTER IZHITSA
    'ѡ': 'w', // ѡ CYRILLIC SMALL LETTER OMEGA
    'ј': 'j', // ј CYRILLIC SMALL LETTER JE
    'ԛ': 'q', // ԛ CYRILLIC SMALL LETTER QA
    'ⲟ': 'o', // ⲟ COPTIC SMALL LETTER O (visually identical to о/o)
    // Greek lookalikes.
    'α': 'a', // α GREEK SMALL LETTER ALPHA
    'ο': 'o', // ο GREEK SMALL LETTER OMICRON
    'ν': 'v', // ν GREEK SMALL LETTER NU
    'ε': 'e', // ε GREEK SMALL LETTER EPSILON
    'ι': 'i', // ι GREEK SMALL LETTER IOTA
    'κ': 'k', // κ GREEK SMALL LETTER KAPPA
    'ρ': 'p', // ρ GREEK SMALL LETTER RHO
    'τ': 't', // τ GREEK SMALL LETTER TAU
    'υ': 'u', // υ GREEK SMALL LETTER UPSILON
    'χ': 'x', // χ GREEK SMALL LETTER CHI
};

function confusablesFold(input: string): string {
    let out = '';
    for (const ch of input) out += CONFUSABLES_MAP[ch] ?? ch;
    return out;
}

const SEPARATOR_RE = /[\s._-]+/g;
// Same character class as SEPARATOR_RE but with a capturing group, so
// String.split keeps the separator runs as elements — collapseSeparators
// needs to inspect the alphanumeric run length on both sides of each run.
const SEPARATOR_RE_CAPTURE = /([\s._-]+)/g;

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
 * diacritics) → strip zero-width characters → lowercase → fold homoglyph
 * confusables (cross-script lookalikes) → l33t-fold.
 * Does NOT collapse separators — see `containsBlockedTerm`, which checks
 * both this view and a separator-collapsed view.
 */
export function normalizeForBlocklist(input: string): string {
    const stripped = stripDiacritics(input).replace(ZERO_WIDTH_RE, '');
    return leetFold(confusablesFold(stripped.toLowerCase()));
}

/**
 * Removes a separator run ONLY when the alphanumeric runs on BOTH sides are
 * each exactly 1 character — the real letter-spacing attack shape
 * ("n.i.g.g.e.r", "n_i_g_g_e_r", "n i g g e r"). A separator between two
 * ordinary (2+ char) words is a real word boundary and is kept.
 *
 * Without this guard, blindly stripping every separator collapses word
 * boundaries across an entire name/phrase, producing false positives across
 * ordinary two-word names — e.g. "Bingo Okada" → "bingookada" (contains
 * "gook"), "Wet Backspin" → "wetbackspin" (contains "wetback"), "Ski Kelly"
 * would similarly collide with any 3-letter+ term straddling the boundary.
 * Verified empirically against a battery of real-name false positives
 * (M1a fix, S22 Phase 1 adversarial review).
 */
function collapseSeparators(input: string): string {
    // Capturing split keeps the separator runs as their own array elements,
    // alternating: text, sep, text, sep, ..., text.
    const parts = input.split(SEPARATOR_RE_CAPTURE);
    let result = parts[0] ?? '';
    for (let i = 1; i < parts.length; i += 2) {
        const sep = parts[i] ?? '';
        const before = parts[i - 1] ?? '';
        const after = parts[i + 1] ?? '';
        if (before.length === 1 && after.length === 1) {
            // Both adjacent runs are single characters — the letter-spacing
            // attack shape. Strip the separator so the letters read as one word.
        } else {
            result += sep;
        }
        result += after;
    }
    return result;
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

/**
 * m2 fix (S22 Phase 1 adversarial review) — for provider-supplied fields
 * (OAuth display name at Discord/Google login) that must NEVER block the
 * login itself: returns `value` unchanged when it passes the blocklist, or
 * `null` when it's blocked. Callers persist the returned value as the public
 * `username` fallback column — a blocked provider name is stored as NULL so
 * public renders fall back to the raw id instead of laundering the slur,
 * while the login/session itself proceeds unaffected.
 */
export function sanitizeProviderUsername(value: string | null | undefined): string | null {
    if (!value) return null;
    return containsBlockedTerm(value) ? null : value;
}
