import { Moon, Sun, SunMoon } from 'lucide-react';
import { useTheme, type Appearance } from './ThemeProvider';

/**
 * The Dark / Light / Auto segmented control (v2.130.0).
 *
 * One preference, one component, several mounts — Account settings and the
 * public "display settings" sheet both render THIS, so there is exactly one
 * place the option set, labels and ordering are defined. The compact sun/moon
 * affordance in every page header is `GlobalThemeToggle`, which drives the
 * same `useTheme().setAppearance`.
 *
 * Ordering is Dark, Light, Auto rather than Auto-first: Auto is the default,
 * and putting the default last keeps the two things a viewer is actually
 * reaching for under their thumb.
 */
const OPTIONS: { value: Appearance; label: string; icon: typeof Sun }[] = [
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'auto', label: 'Auto', icon: SunMoon },
];

export default function AppearanceControl({ className }: { className?: string }) {
    const { appearance, setAppearance } = useTheme();

    return (
        <div
            role="radiogroup"
            aria-label="Appearance"
            data-testid="appearance-control"
            className={`inline-flex rounded-lg border border-border bg-raised p-0.5 gap-0.5 ${className ?? ''}`}
        >
            {OPTIONS.map(({ value, label, icon: Icon }) => {
                const selected = appearance === value;
                return (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        data-testid={`appearance-${value}`}
                        onClick={() => setAppearance(value)}
                        className={`inline-flex items-center justify-center gap-1.5 min-h-9 px-3 rounded-md text-sm font-medium transition-colors cursor-pointer border-0 ${
                            selected
                                ? 'bg-neon-cyan/15 text-neon-cyan'
                                : 'bg-transparent text-muted hover:text-primary'
                        }`}
                    >
                        <Icon size={15} aria-hidden="true" />
                        {label}
                    </button>
                );
            })}
        </div>
    );
}
