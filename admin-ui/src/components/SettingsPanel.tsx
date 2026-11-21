import type { ReactNode, Ref } from 'react';

/**
 * G20 - the two building blocks of a settings page that wears the Arcaid
 * Witness look (Account Settings is the first).
 *
 * `SettingsGroup` is a set of related panels under one title, in ONE colour:
 * the title, the group's chip in the jump list, and the label, border and top
 * light bar of every panel inside all take it (`--aw-group`,
 * public/aw-theme/aw-web.css). Panels sit two to a row from `lg`, and the two
 * in a row are the same height.
 *
 * `SettingsPanel` is one card: a kit panel (`.aw-panel`) under a kit label
 * (`.aw-label`). `wide` makes it span the row.
 *
 * The PAGE supplies the look: its root carries `sb-theme-scope aw-island` and
 * loads the kit with `useAwTheme` (lib/awTheme.ts). On a page that does
 * neither these render as plain unstyled content, so they are not general
 * cards.
 */

/** The group colours. The kit's own, plus violet (its pink and cyan mixed); red is for the group that can do harm. */
export type SettingsGroupTone = 'cyan' | 'pink' | 'violet' | 'ice' | 'red';

export function SettingsGroup({ id, tone, title, sub, children }: {
    /** Also the target of the group's jump chip. */
    id: string;
    tone: SettingsGroupTone;
    title: string;
    /** One plain line under the title: what is in this group. */
    sub: string;
    children: ReactNode;
}) {
    return (
        // `aw-group--cyan` has no rule of its own: cyan is the default.
        <section id={id} aria-labelledby={`${id}-title`} className={`aw-group aw-group--${tone} scroll-mt-6`}>
            <header>
                <h2 id={`${id}-title`} className="aw-group__title">{title}</h2>
                <p className="aw-group__sub">{sub}</p>
            </header>
            <div className="grid gap-5 lg:grid-cols-2">{children}</div>
        </section>
    );
}

/**
 * `min-w-0` because panels sit in a grid: without it one long unbroken value
 * (a device id, a table name) widens the whole column.
 */
export default function SettingsPanel({ title, id, testId, panelRef, wide = false, className = '', children }: {
    title: ReactNode;
    id?: string;
    testId?: string;
    panelRef?: Ref<HTMLElement>;
    /** Span both columns of the group. */
    wide?: boolean;
    className?: string;
    children: ReactNode;
}) {
    return (
        <section
            id={id}
            ref={panelRef}
            data-testid={testId}
            className={`aw-panel min-w-0 scroll-mt-4${wide ? ' lg:col-span-2' : ''} ${className}`.trim()}
        >
            <h3 className="aw-label flex items-center gap-2">{title}</h3>
            {children}
        </section>
    );
}
