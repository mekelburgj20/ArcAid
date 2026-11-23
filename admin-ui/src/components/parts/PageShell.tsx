import type { ReactNode } from 'react';
import { PAGE_WIDTH } from '../../lib/pageLayout';
import JumpList, { type JumpItem } from './JumpList';

/**
 * G21 - the content frame of a THEMED page (room and admin pages, which keep
 * the site's 11 themes). It sits inside the existing layouts, which own the
 * nav and the `<main>`, so it is a plain wrapper: one of the two page widths
 * (`PAGE_WIDTH`, lib/pageLayout.ts) and, with `jump`, the jump list beside the
 * children (`.part-jumplayout` in src/index.css: a row of chips on a phone or
 * a laptop, a sticky column from 1280 px), the same layout `ArcaidPage` gives
 * the Arcaid look.
 */
export default function PageShell({ width = 'wide', jump, className, children }: {
    width?: 'wide' | 'column';
    /** A jump list beside the children (the children are then `PanelGroup`s). */
    jump?: JumpItem[];
    className?: string;
    children: ReactNode;
}) {
    return (
        <div className={className ? `${PAGE_WIDTH[width]} ${className}` : PAGE_WIDTH[width]}>
            {jump ? (
                <div className="part-jumplayout">
                    <JumpList items={jump} />
                    <div className="part-jumplayout__body">{children}</div>
                </div>
            ) : children}
        </div>
    );
}
