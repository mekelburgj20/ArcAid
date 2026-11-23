import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Home } from 'lucide-react';
import { usePartSkin } from './skin';

/**
 * G21 - a page's title row.
 *
 * Arcaid skin: the G20 Account Settings header, the Arcaid logo with
 * "ARCAID" in the kit's chrome brand lettering and the page's name under it
 * in capitals (`.aw-header`, `.aw-brand`). `sub` is not shown there.
 *
 * Theme skin: the page's name in the display font with an optional plain line
 * under it (`.part-title` in src/index.css), inside the layout's own nav.
 *
 * `actions` sit at the right of the row (they wrap under it on a phone).
 */
export default function PageTitle({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) {
    const skin = usePartSkin();
    if (skin === 'arcaid') {
        return (
            <header className="aw-header flex-wrap">
                <img className="aw-header__logo" src="/arcaid-logo-v2.png" alt="" aria-hidden="true" />
                <h1 className="aw-brand m-0">
                    ARCAID
                    <span className="aw-brand__sub">{title.toUpperCase()}</span>
                </h1>
                {actions && <nav className="ml-auto flex items-center gap-5" aria-label="Page">{actions}</nav>}
            </header>
        );
    }
    return (
        <header className="part-title">
            <div className="min-w-0">
                <h1 className="part-title__h">{title}</h1>
                {sub && <p className="part-title__sub">{sub}</p>}
            </div>
            {actions && <div className="part-title__actions">{actions}</div>}
        </header>
    );
}

/** The two header links of a standalone page: Back (browser history) and Home. */
export function PageNavLinks() {
    return (
        <>
            <button
                onClick={() => window.history.back()}
                className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors cursor-pointer bg-transparent border-0 p-0"
            >
                <ArrowLeft size={16} />
                Back
            </button>
            <Link to="/" className="flex items-center gap-1.5 text-sm text-muted hover:text-neon-cyan transition-colors no-underline">
                <Home size={16} />
                Home
            </Link>
        </>
    );
}
