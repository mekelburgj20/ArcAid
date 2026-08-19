/**
 * Per-game background framing (v2.115.0).
 *
 * An admin can zoom into a game's card background and drag it around; the
 * result is three numbers stored on the overlay row rather than a re-cropped
 * image, so re-framing costs one UPDATE and the original art is never touched.
 *
 * All three are nullable and NULL means "not framed" — the cards render that
 * as the 100 / 50 / 50 default, which is byte-identical to the pre-v2.115
 * `backgroundSize: cover; background-position: center` look.
 */
export interface BgFraming {
    bgZoom?: number | null;
    bgPosX?: number | null;
    bgPosY?: number | null;
}

export const clampOrNull = (n: number | null | undefined, min: number, max: number): number | null =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null;

/**
 * Defence in depth behind the Zod bounds. An omitted framing object CLEARS the
 * columns rather than leaving the previous framing attached to newly chosen
 * art — an admin who just picked a different background expects it unframed,
 * not zoomed to whatever the last one needed.
 */
export function normalizeFraming(framing?: BgFraming): { bgZoom: number | null; bgPosX: number | null; bgPosY: number | null } {
    return {
        bgZoom: clampOrNull(framing?.bgZoom, 100, 300),
        bgPosX: clampOrNull(framing?.bgPosX, 0, 100),
        bgPosY: clampOrNull(framing?.bgPosY, 0, 100),
    };
}
