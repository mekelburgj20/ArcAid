import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * G23 - list rows (owner's pick, 2026-11-25): the Arcaid menu's row family on a
 * page. A 40 px tile (an `<img>` or initials), the name (wraps, never cut off),
 * an optional caption in tracked caps in the tone, and an optional trailing node.
 * A row with `href` (a router `Link`) or `onClick` is one big target: the name's
 * `::after` covers the row, and the menu's hover highlight shows. `trailing`
 * sits above that cover, so a small secondary `Button` there stays clickable.
 * Min height 56 px. The tone is the panel's (cyan elsewhere).
 */
export function ListRows({ children, label, testId }: { children: ReactNode; label?: string; testId?: string }) {
    return <div className="part-rows" role="list" aria-label={label} data-testid={testId}>{children}</div>;
}

const CHEV = (
    <svg className="part-row__chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export function ListRow({ tile, name, caption, href, onClick, trailing, below, testId }: {
    tile: ReactNode;
    name: string;
    caption?: ReactNode;
    href?: string;
    onClick?: () => void;
    trailing?: ReactNode;
    /** Controls under the caption (chips, a badge); the whole area sits above the row's link cover. */
    below?: ReactNode;
    testId?: string;
}) {
    const interactive = Boolean(href || onClick);
    const nameEl = href
        ? <Link to={href} className="part-row__name">{name}</Link>
        : onClick
            ? <button type="button" className="part-row__name" onClick={onClick}>{name}</button>
            : <span className="part-row__name">{name}</span>;
    return (
        <div className={`part-row${interactive ? ' part-row--link' : ''}${trailing ? ' part-row--trail' : ''}`} role="listitem" data-testid={testId}>
            <span className="part-row__tile" aria-hidden="true">{tile}</span>
            <span className="part-row__text">
                {nameEl}
                {caption && <span className="part-row__cap">{caption}</span>}
                {below && <div className="part-row__below">{below}</div>}
            </span>
            {(trailing || interactive) && (
                <span className="part-row__end">
                    {trailing}
                    {interactive && CHEV}
                </span>
            )}
        </div>
    );
}
