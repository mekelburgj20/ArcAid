/**
 * S22 Phase 1 content moderation — curated input blocklist (v2.43.0).
 *
 * Curation policy: UNAMBIGUOUS HATE SLURS ONLY (racial/ethnic/homophobic
 * terms with essentially zero false-positive risk as substrings of ordinary
 * words or names). Deliberately excludes:
 *   - general profanity (out of scope — reports handle creative/ambiguous
 *     abuse; this list is prevention-at-input, not moderation)
 *   - slurs that collide with common dictionary words or names (the
 *     "Scunthorpe problem" — e.g. terms that are substrings of unrelated
 *     everyday words), since a false-positive block on a legitimate name is
 *     worse than missing an edge case a human report will catch anyway
 *   - reclaimed or context-dependent terms
 *
 * This is a plain, reviewable array — extend it via PR as new unambiguous
 * cases are identified. Do not add general profanity or ambiguous terms.
 */
export const BLOCKED_TERMS: string[] = [
    'nigger',
    'nigga',
    'kike',
    'gook',
    'wetback',
    'beaner',
    'faggot',
    'raghead',
    'towelhead',
];
