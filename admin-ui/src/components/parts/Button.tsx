import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { buttonClasses, type ButtonSize, type ButtonVariant } from './buttonClasses';

/**
 * G21 - the shared button, taken from the G20 Account Settings page.
 *
 * Drawn with site tokens only, so it needs no skin switch: on a themed page it
 * takes the theme's colours, and inside the Arcaid look (`ArcaidPage`) the
 * page's `aw-island` points the same tokens at the kit (cyan, ice, chrome, and
 * the kit's red for `neon-coral`).
 *
 * - `primary`: the one thing a panel is for (Save, Link, Pair), in the
 *   theme's lead colour (`--color-lead`; the kit's pink on the Arcaid look since v2.265.6,
 *   its cyan on the three Witness pages).
 * - `secondary`: an outline for the quieter choice beside it (Clear, Cancel).
 * - `danger`: anything that removes or cannot be undone.
 *
 * `type="button"` unless the caller says otherwise, so a button dropped inside
 * a form never submits it by accident. No `transition-all` and no
 * `focus:outline-none`: keyboard focus shows the global cyan ring (`index.css`
 * base layer), and `part-focus` adds the parts' faint halo.
 */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
    { variant = 'primary', size = 'md', type = 'button', className = '', ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={`${buttonClasses(variant, size)} ${className}`.trim()}
            {...rest}
        />
    );
});

/**
 * A router `Link` drawn exactly like a `Button` (G22): for a button that goes
 * to another page. Same variants and sizes; no underline.
 */
export function ButtonLink({ to, variant = 'primary', size = 'md', className = '', children, ...rest }: Omit<LinkProps, 'to'> & {
    to: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
}) {
    return (
        <Link to={to} className={`${buttonClasses(variant, size)} no-underline ${className}`.trim()} {...rest}>
            {children}
        </Link>
    );
}

export default Button;
