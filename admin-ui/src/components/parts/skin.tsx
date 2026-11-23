import { createContext, useContext } from 'react';

/**
 * G21 - the two skins the shared parts (this folder) are drawn in.
 *
 * - `'arcaid'`: the fixed dark Arcaid look of the personal and global pages
 *   (Account Settings first). The parts emit the Witness kit's own classes
 *   (`.aw-panel`, `.aw-label`, `.aw-group`, `.aw-jump`; `public/aw-theme/`),
 *   which `ArcaidPage` loads. Provided by `ArcaidPage` only.
 * - `'theme'` (the default): room and admin pages, which keep the site's 16
 *   themes. Same parts, same boxes, drawn with the theme tokens by the
 *   `part-*` classes in `src/index.css` ("Shared parts on themed pages").
 *
 * Kept component-free (context, hook and types only) for react-refresh.
 */
export type PartSkin = 'arcaid' | 'theme';

/** The group colours. The kit's own, plus violet (its pink and cyan mixed); red is for the group that can do harm. */
export type PartTone = 'cyan' | 'pink' | 'violet' | 'ice' | 'red';

export const PartSkinContext = createContext<PartSkin>('theme');

export function usePartSkin(): PartSkin {
    return useContext(PartSkinContext);
}
