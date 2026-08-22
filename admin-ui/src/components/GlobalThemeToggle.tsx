import { Moon, Sun } from 'lucide-react';
import { useTheme, THEME_POLARITY } from './ThemeProvider';

/**
 * The compact light/dark switch, in every page header (v2.130.0).
 *
 * Originally (v2.50.0, A1) this recorded a global-pages-only visitor choice.
 * It now drives the single site-wide Appearance preference — same look, same
 * position, wider reach: it is mounted on the landing page, the global
 * scoreboard, the public room nav, and both admin shells, so "every page" has
 * the switch. The 3-way Dark/Light/Auto form of the same preference is
 * `AppearanceControl` (Account settings + the display-settings sheet).
 *
 * From `auto` a click commits to the OPPOSITE of whatever is on screen right
 * now — the polarity of the theme actually applied, not of the OS — because
 * that is what a viewer means when they hit the sun on a dark page.
 */
export default function GlobalThemeToggle({ className }: { className?: string }) {
    const { appearance, setAppearance, theme } = useTheme();
    const currentPolarity = appearance === 'auto' ? THEME_POLARITY[theme] : appearance;
    const isLight = currentPolarity === 'light';
    const next = isLight ? 'dark' : 'light';

    return (
        <button
            type="button"
            onClick={() => setAppearance(next)}
            aria-label={`Switch to ${next} mode`}
            title={`Switch to ${next} mode`}
            className={`inline-flex items-center justify-center w-8 h-8 rounded border border-border text-muted hover:text-neon-cyan hover:border-neon-cyan/60 transition-colors ${className ?? ''}`}
        >
            {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
    );
}
