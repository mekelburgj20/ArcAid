import { Moon, Sun } from 'lucide-react';
import { useTheme } from './ThemeProvider';

/**
 * Light/dark switch for the global pages (v2.50.0, A1).
 *
 * Global pages used to render the admin-set `GLOBAL_PAGE_THEME`; they now
 * follow each visitor (explicit choice -> prefers-color-scheme -> dark). This
 * is the affordance that records the explicit choice. Shared between the
 * /scoreboard header and the landing-page header so both global surfaces get
 * the same control in the same place — left of the login/user area.
 *
 * Intentionally not rendered on room pages: those have their own full theme
 * picker in the scoreboard preferences sheet.
 */
export default function GlobalThemeToggle({ className }: { className?: string }) {
    const { globalPageTheme, setGlobalPageTheme } = useTheme();
    const isLight = globalPageTheme === 'light';
    const next = isLight ? 'dark' : 'light';

    return (
        <button
            type="button"
            onClick={() => setGlobalPageTheme(next)}
            aria-label={`Switch to ${next} mode`}
            title={`Switch to ${next} mode`}
            className={`inline-flex items-center justify-center w-8 h-8 rounded border border-border text-muted hover:text-neon-cyan hover:border-neon-cyan/60 transition-colors ${className ?? ''}`}
        >
            {isLight ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>
    );
}
