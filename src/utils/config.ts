/**
 * Formal mapping of tournament types to their iScored tag "key".
 * This allows us to identify games by tag even if the name suffix is missing.
 */
export const TOURNAMENT_TAG_KEYS: Record<string, string> = {
    'DG': 'DG',
    'WG-VPXS': 'WG-VPXS',
    'WG-VR': 'WG-VR',
    'MG': 'MG'
};

export const MANAGED_TAGS = Object.values(TOURNAMENT_TAG_KEYS);
