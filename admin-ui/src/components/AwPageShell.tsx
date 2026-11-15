import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AW_BADGE_SRC, AW_BADGE_SRCSET, useAwTheme } from '../lib/awTheme';

/**
 * W105 (v2.251.0) - the frame of the standalone Arcaid Witness pages
 * (`/witness/install`, `/pair`, `/pair/:code`) in the designer's kit: the kit
 * background (`.aw-screen`), the header (badge + "ARCAID WITNESS" + the page's
 * sub line), the content column and the footer. Content goes on `.aw-panel`s.
 *
 * `sb-theme-scope aw-island` on the column: whatever site theme the visitor
 * wears, the site components inside (buttons, inputs, sign-in) render on the
 * dark defaults with their colour tokens pointed at the kit (`aw-web.css`).
 */
export default function AwPageShell({ sub, footer, children }: {
    /** The header's sub line, upper case like the kit's, e.g. "INSTALL GUIDE". */
    sub: string;
    /** The footer's right-hand item. */
    footer?: ReactNode;
    children: ReactNode;
}) {
    useAwTheme();
    return (
        <div className="aw-screen">
            <div className="aw-layout aw-web sb-theme-scope aw-island">
                <header className="aw-header">
                    <img className="aw-header__logo" src={AW_BADGE_SRC} srcSet={AW_BADGE_SRCSET} alt="Arcaid Witness" />
                    <div className="aw-brand">
                        ARCAID WITNESS
                        <span className="aw-brand__sub">{sub}</span>
                    </div>
                </header>
                <main className="aw-web__main">{children}</main>
                <footer className="aw-footer">
                    <Link to="/">ARCAID.APP</Link>
                    {footer}
                </footer>
            </div>
        </div>
    );
}
