import type { ReactNode, Ref } from 'react';
import { usePartSkin, type PartTone } from './skin';

/**
 * G21 - the two building blocks of a page of grouped panels, taken from the
 * G20 Account Settings page (they were `SettingsGroup` / `SettingsPanel`).
 *
 * `PanelGroup` is a set of related panels under one title, in ONE colour:
 * the title, the group's chip in the jump list, and the label, border and top
 * light bar of every panel inside all take it (`--aw-group` in
 * public/aw-theme/aw-web.css on the Arcaid skin, `--part-tone` in
 * src/index.css on the theme skin). Panels sit two to a row from `lg`, and the
 * two in a row are the same height.
 *
 * `Panel` is one card under a label. `wide` makes it span the row.
 *
 * The skin comes from the page (`skin.tsx`). Inside `ArcaidPage` these are the
 * kit's panel and label (`.aw-panel`, `.aw-label`), which the page loads and
 * whose root carries `sb-theme-scope aw-island`. Everywhere else they are the
 * `part-*` classes, the same boxes drawn in the site theme's tokens.
 */

export function PanelGroup({ id, tone, title, sub, children }: {
    /** Also the target of the group's jump chip. */
    id: string;
    tone: PartTone;
    title: string;
    /** One plain line under the title: what is in this group. */
    sub?: string;
    children: ReactNode;
}) {
    const skin = usePartSkin();
    if (skin === 'arcaid') {
        return (
            // `aw-group--cyan` has no rule of its own: cyan is the default.
            <section id={id} aria-labelledby={`${id}-title`} className={`aw-group aw-group--${tone} scroll-mt-6`}>
                <header>
                    <h2 id={`${id}-title`} className="aw-group__title">{title}</h2>
                    {sub && <p className="aw-group__sub">{sub}</p>}
                </header>
                <div className="grid gap-5 lg:grid-cols-2">{children}</div>
            </section>
        );
    }
    return (
        // `part-tone--cyan` has no rule of its own: cyan is the default.
        <section id={id} aria-labelledby={`${id}-title`} className={`part-group part-tone--${tone} scroll-mt-6`}>
            <header>
                <h2 id={`${id}-title`} className="part-group__title">{title}</h2>
                {sub && <p className="part-group__sub">{sub}</p>}
            </header>
            <div className="grid gap-5 lg:grid-cols-2">{children}</div>
        </section>
    );
}

/**
 * `min-w-0` because panels sit in a grid: without it one long unbroken value
 * (a device id, a table name) widens the whole column.
 */
export default function Panel({ title, id, testId, panelRef, wide = false, className = '', children }: {
    title: ReactNode;
    id?: string;
    testId?: string;
    panelRef?: Ref<HTMLElement>;
    /** Span both columns of the group. */
    wide?: boolean;
    className?: string;
    children: ReactNode;
}) {
    const arcaid = usePartSkin() === 'arcaid';
    return (
        <section
            id={id}
            ref={panelRef}
            data-testid={testId}
            className={`${arcaid ? 'aw-panel' : 'part-panel'} min-w-0 scroll-mt-4${wide ? ' lg:col-span-2' : ''} ${className}`.trim()}
        >
            <h3 className={`${arcaid ? 'aw-label' : 'part-label'} flex items-center gap-2`}>{title}</h3>
            {children}
        </section>
    );
}
