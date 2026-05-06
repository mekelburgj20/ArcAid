/**
 * Game name normalization for dedup matching across catalogue sources.
 * Produces a match key for flagging — never for auto-merging.
 * Two entries with the same normalized key get flagged for admin review.
 */

/** Edition suffixes to strip (case-insensitive) */
const EDITION_SUFFIXES = /\b(LE|Premium|Pro|Remake|SE|CE|VPW|MOD|Limited Edition|Special Edition|Collectors Edition)\b/gi;

/** Manufacturer/year parentheticals: "(Williams, 1997)", "(Bally 1990)", "(Stern, 2023)" */
const MANUFACTURER_YEAR = /\s*\([^)]*(?:\d{4})[^)]*\)/g;

/** Generic parentheticals with known manufacturer patterns */
const MANUFACTURER_ONLY = /\s*\((?:Williams|Bally|Stern|Gottlieb|Data East|Sega|Midway|Premier|Capcom|Jersey Jack|Chicago Gaming|Spooky|American Pinball|Dutch Pinball|Heighway|Multimorphic)[^)]*\)/gi;

/** Leading articles */
const LEADING_ARTICLE = /^(the|a|an)\s+/i;

/** Punctuation except hyphens */
const PUNCTUATION = /[^\w\s-]/g;

/** Multiple whitespace */
const MULTI_SPACE = /\s+/g;

/**
 * Hyphen surrounded by whitespace — almost always a separator (e.g.
 * "Ace Ventura - Pet Detective" vs "Ace Ventura Pet Detective"). Replaced
 * with a single space before the rest of the pipeline. Hyphens between
 * letters ("Spider-Man", "X-Men") have no surrounding whitespace and are
 * untouched.
 */
const SEPARATOR_HYPHEN = /\s+-\s+/g;

/**
 * Normalizes a game name for dedup matching.
 *
 * Algorithm:
 *   1. Lowercase
 *   2. Strip manufacturer/year parentheticals: "Attack From Mars (Williams, 1997)" → "attack from mars"
 *   3. Strip edition suffixes: "LE", "Premium", "Pro", "Remake", "SE", "CE", "VPW", "MOD"
 *   4. Strip punctuation except hyphens: "Dr. Dude" → "dr dude"
 *   5. Collapse whitespace
 *   6. Strip leading "the"/"a"/"an"
 *   7. Trim
 */
export function normalizeGameName(name: string): string {
    if (!name) return '';

    let result = name.toLowerCase();

    // Strip manufacturer/year parentheticals
    result = result.replace(MANUFACTURER_YEAR, '');
    result = result.replace(MANUFACTURER_ONLY, '');

    // Strip edition suffixes
    result = result.replace(EDITION_SUFFIXES, '');

    // Collapse whitespace-surrounded hyphens to a single space (separator
    // case). Run before PUNCTUATION so the hyphen is gone before the
    // hyphen-preserving punctuation regex sees it.
    result = result.replace(SEPARATOR_HYPHEN, ' ');

    // Strip punctuation except hyphens
    result = result.replace(PUNCTUATION, '');

    // Collapse whitespace
    result = result.replace(MULTI_SPACE, ' ').trim();

    // Strip leading articles
    result = result.replace(LEADING_ARTICLE, '');

    return result.trim();
}
