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
// TODO(light-asset): point at '/arcaid-logo-wide-light-v1.png' once it exists.
const LIGHT_SRC = DARK_SRC;

export default function BrandWordmark({ className = 'h-16 w-auto' }: { className?: string }) {
    const { globalPageTheme } = useTheme();
    return (
        <img
            src={globalPageTheme === 'light' ? LIGHT_SRC : DARK_SRC}
            alt="Arcaid"
            className={className}
        />
    );
}
