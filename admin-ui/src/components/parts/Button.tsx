import { forwardRef, type ButtonHTMLAttributes } from 'react';

/**
 * G21 - the shared button, taken from the G20 Account Settings page.
 *
 * Drawn with site tokens only, so it needs no skin switch: on a themed page it
 * takes the theme's colours, and inside the Arcaid look (`ArcaidPage`) the
 * page's `aw-island` points the same tokens at the kit (cyan, ice, chrome, and
 * the kit's red for `neon-coral`).
 *
 * - `primary`: the one thing a panel is for (Save, Link, Pair), in the
 *   theme's lead colour (`--color-lead`; the kit's cyan on the Arcaid look).
 * - `secondary`: an outline for the quieter choice beside it (Clear, Cancel).
 * - `danger`: anything that removes or cannot be undone.
 *
 * `type="button"` unless the caller says otherwise, so a button dropped inside
 * a form never submits it by accident. No `transition-all` and no
 * `focus:outline-none`: the browser's own focus ring stays until the shared
 * ring exists.
 */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'danger';
    size?: 'md' | 'sm' | 'xs';
};

const BASE = 'inline-flex items-center justify-center gap-1.5 rounded border font-medium cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const SIZES: Record<NonNullable<ButtonProps['size']>, string> = {
    md: 'px-4 py-1.5 text-sm',
    sm: 'px-3 py-1.5 text-xs',
    xs: 'px-2 py-1 text-xs',
};

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
    primary: 'border-lead/40 bg-lead/10 ink-lead hover:bg-lead/20',
    secondary: 'border-border bg-transparent text-muted hover:text-primary hover:border-muted',
    danger: 'border-neon-coral/40 bg-neon-coral/10 ink-danger hover:bg-neon-coral/20',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = 'primary', size = 'md', type = 'button', className = '', ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={`${BASE} ${SIZES[size]} ${VARIANTS[variant]} ${className}`.trim()}
            {...rest}
        />
    );
});

export default Button;
