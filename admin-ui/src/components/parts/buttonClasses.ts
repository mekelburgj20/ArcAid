/**
 * The shared button's classes (G21), in their own file so a control that must
 * stay its own element (the `ShareButton` in a dialog's actions, G23c) can wear
 * exactly what `Button` and `ButtonLink` wear. `Button.tsx` documents the
 * variants and sizes.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';
export type ButtonSize = 'md' | 'sm' | 'xs';

const BASE = 'part-focus inline-flex items-center justify-center gap-1.5 rounded border font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const SIZES: Record<ButtonSize, string> = {
    md: 'px-4 py-1.5 text-sm',
    sm: 'px-3 py-1.5 text-xs',
    xs: 'px-2 py-1 text-xs',
};

const VARIANTS: Record<ButtonVariant, string> = {
    primary: 'border-lead/40 bg-lead/10 ink-lead hover:bg-lead/20',
    secondary: 'border-border bg-transparent text-muted hover:text-primary hover:border-muted',
    danger: 'border-neon-coral/40 bg-neon-coral/10 ink-danger hover:bg-neon-coral/20',
};

/** The classes of a `Button` of this variant and size (without the caller's own). */
export function buttonClasses(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
    return `${BASE} ${SIZES[size]} ${VARIANTS[variant]}`;
}
