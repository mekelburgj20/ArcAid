import { useRef } from 'react';
import { SlidersHorizontal } from 'lucide-react';

/**
 * G34c - "Display" for a signed-out visitor, beside the light/dark switch.
 * Signed-in viewers open the same panel from their user menu, so pages render
 * this only when nobody is signed in. Same size, shape and focus as
 * `GlobalThemeToggle`; it opens the panel with the `open-scoreboard-prefs`
 * event after taking focus, so the panel has somewhere to hand focus back.
 */
export default function DisplaySettingsButton({ className }: { className?: string }) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
        <button
            ref={ref}
            type="button"
            onClick={() => {
                ref.current?.focus();
                window.dispatchEvent(new Event('open-scoreboard-prefs'));
            }}
            aria-label="Display settings"
            title="Display settings"
            className={`inline-flex items-center justify-center w-8 h-8 rounded border border-border text-muted hover:text-neon-cyan hover:border-neon-cyan/60 transition-colors ${className ?? ''}`}
        >
            <SlidersHorizontal className="w-4 h-4" />
        </button>
    );
}
