import { useTheme } from './ThemeProvider';

/**
 * The Arcaid wordmark, polarity-aware (v2.50.0, A1).
 *
 * `/arcaid-logo-wide-v2.png` carries a neon glow authored against a near-black
 * stage. Once A1 made global pages light-capable it washes out to a faint pink
 * outline on `.theme-light` — so the asset has to swap with polarity, not just
 * sit on whatever background it lands on.
 *
 * PENDING ASSET: `LIGHT_SRC` currently points at the dark file, so light mode
 * still shows the washed-out mark. Dropping the light artwork in is a one-line
 * change here.
 *
 * Asset spec for the light variant:
 *   - Filename `/arcaid-logo-wide-light-v1.png` in `admin-ui/public/`
 *     (NEVER overwrite an existing public asset in place — new filename every
 *     time; see the cache-bust gotcha in CLAUDE.md)
 *   - Same aspect ratio + pixel dimensions as `arcaid-logo-wide-v2.png` so the
 *     `h-16 w-auto` sizing at both call sites is unchanged
 *   - Transparent background, artwork legible on `--color-surface` under
 *     `.theme-light` (oklch(100% 0 0) — effectively white)
 *   - Drop the outer glow (it reads as haze on light) and darken the wordmark
 *     itself; keep the magenta triangle, which already has enough contrast
 */

const DARK_SRC = '/arcaid-logo-wide-v2.png';
/**
 * v2.55.0 — the light asset landed ("Delta x House Chrome, purple backdrop
 * plate"). Its plate is part of the artwork, so it sits on any light surface;
 * it was designed against #E8EAF0, which is exactly what `.theme-light`'s
 * `--color-deep` now is.
 *
 * The 1x file (700x330, 202KB) is used deliberately over the package's
 * recommended 2x (1400x660, 586KB): at the ~187px display width below, 1x is
 * still ~3.7x density — ample for retina — and saves ~380KB on first paint.
 */
const LIGHT_SRC = '/arcaid-logo-light-v1.png';

/**
 * Default height is 88px, not the old 64px: the light artwork's spec sets a
 * 180px minimum display width (below it the delta stops reading, and the
 * package ships no wordmark-only fallback). Its 2.12 aspect ratio puts 64px
 * tall at only 136px wide — 44px under. 88px yields ~187px. The dark mark
 * (1.60 ratio) grows from a rather small 103px to 141px wide, which it wanted
 * anyway. The two ratios differ, so the marks share a height, not a width.
 */
export default function BrandWordmark({ className = 'h-[88px] w-auto' }: { className?: string }) {
    const { globalPageTheme } = useTheme();
    return (
        <img
            src={globalPageTheme === 'light' ? LIGHT_SRC : DARK_SRC}
            alt="Arcaid"
            className={className}
        />
    );
}
