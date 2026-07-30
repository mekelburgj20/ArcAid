/**
 * Catalogue image URL resolution — the single shared copy.
 *
 * `toCatalogueUrl` / `imageFor` were duplicated verbatim across
 * `GlobalScoreboard.tsx`, `GlobalScoresView.tsx` and `GlobalGameDetail.tsx`
 * (each with its own copy of the same comment noting the duplication). A2
 * extracts them here and repoints those three. Do not add a fourth copy —
 * import from this module instead.
 *
 * Two copies deliberately remain out of scope for this extraction because they
 * resolve a different shape: `GameInfoModal.tsx` and `LandingPage.tsx`.
 */

/** The subset of a catalogue row that image resolution actually reads. */
export interface CatalogueImageSource {
    local_image_path?: string | null;
    wheel_image_path?: string | null;
    image_url?: string | null;
}

/**
 * Map a stored catalogue image path onto a URL the browser can fetch.
 *
 * Absolute URLs pass through unchanged. The DB stores filesystem paths like
 * `data/catalogue-images/opdb/foo.jpg`; the server mounts that directory at
 * `/api/catalogue-images/`.
 */
export function toCatalogueUrl(path: string): string {
    if (/^https?:\/\//i.test(path)) return path;
    const m = path.match(/^\/?data\/catalogue-images\/(.+)$/);
    if (m) return `/api/catalogue-images/${m[1]}`;
    return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Preferred card art for a catalogue row: local file, then wheel art, then the
 * remote `image_url`. Returns null when the row has no art at all (callers
 * render a "No image" placeholder).
 */
export function catalogueImageFor(game: CatalogueImageSource): string | null {
    if (game.local_image_path) return toCatalogueUrl(game.local_image_path);
    if (game.wheel_image_path) return toCatalogueUrl(game.wheel_image_path);
    if (game.image_url) return game.image_url;
    return null;
}
