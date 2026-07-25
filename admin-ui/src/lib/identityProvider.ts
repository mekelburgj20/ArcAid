/**
 * FE mirror of BE `src/utils/identityProvider.ts` (v2.36.0, identity linking).
 * Only the one predicate the FE actually needs call sites for is mirrored
 * here — see the BE file for the full two-IdP-model doctrine.
 */
export function isGoogleUserId(id: string | null | undefined): boolean {
    return !!id && id.startsWith('google:');
}
