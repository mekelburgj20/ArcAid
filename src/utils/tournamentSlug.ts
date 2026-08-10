/**
 * Human-readable tournament slug for the Picks page URL (`/:slug/picks?t=<this>`).
 *
 * Byte-for-byte the same transform as the FE's `tournamentSlug()` helper in
 * `admin-ui/src/pages/Picks.tsx` (lowercase, non-alnum runs collapsed to a
 * single underscore, leading/trailing underscores trimmed). Duplicated
 * rather than shared because the FE copy lives inside a separate ESM build —
 * but the two must produce identical output for the same tournament name, or
 * a server-composed onboarding link would 404 against the FE's own router
 * (see Picks.tsx's `isUuid` fallback, which only saves a raw-UUID bookmark,
 * not a mismatched slug).
 */
export function tournamentUrlSlug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
