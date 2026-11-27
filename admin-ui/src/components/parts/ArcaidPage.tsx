import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAwTheme } from '../../lib/awTheme';
import { PartSkinContext } from './skin';
import PageTitle, { PageNavLinks } from './PageTitle';
import JumpList, { type JumpItem } from './JumpList';

/** `embedded`: the carpet (a fixed `::before`) stays inside the box, and nothing asks for a full screen. */
const EMBEDDED_ROOT: CSSProperties = { minHeight: 0, transform: 'translateZ(0)', overflow: 'hidden' };
const EMBEDDED_LAYOUT: CSSProperties = { minHeight: 0 };
const SAFE_AREA_TOP: CSSProperties = { paddingTop: 'max(1.5rem, env(safe-area-inset-top))' };

/**
 * G21 - the page shell of the fixed dark Arcaid look (the personal and global
 * pages; Account Settings first, G20). Loads the Witness kit while mounted
 * (`useAwTheme`) and puts every part inside on the Arcaid skin (`skin.tsx`).
 *
 * `bare` is the signed-out state: no header, footer or main, the children
 * centred on the same background. `embedded` is the shell shown inside a box
 * on another page (a preview): it fills the box, not the screen, and its main
 * wrapper is not a second `<main>` landmark. `header` (G35c, the landing
 * page) is a page's own header row in place of the title row.
 */
export default function ArcaidPage({
    title, header, width = 'wide', jump, actions, footer, overlays, bare = false, embedded = false, children,
}: {
    /** Shown under ARCAID in the header. */
    title: string;
    /** The page's own header in place of the ARCAID title row (`title` and `actions` are then unused). */
    header?: ReactNode;
    /** 'wide' = 1600 px like the results pages (`aw-web--wide`); 'column' = the kit's 52rem column. */
    width?: 'wide' | 'column';
    /** A jump list beside the children (the children are then `PanelGroup`s). */
    jump?: JumpItem[];
    /** The header's right side; default Back + Home. */
    actions?: ReactNode;
    /** The footer's content; default the ARCAID.APP home link. */
    footer?: ReactNode;
    /** Dialogs: rendered after the layout, still inside the root, so they keep the island's tokens. */
    overlays?: ReactNode;
    bare?: boolean;
    embedded?: boolean;
    children: ReactNode;
}) {
    useAwTheme();
    const rootStyle = embedded ? EMBEDDED_ROOT : undefined;
    const fullScreen = embedded ? '' : ' min-h-screen';

    if (bare) {
        return (
            <PartSkinContext.Provider value="arcaid">
                <div
                    className={`aw-screen aw-screen--arcaid sb-theme-scope aw-island${fullScreen} bg-deep text-primary flex items-center justify-center`}
                    style={rootStyle}
                >
                    {/* Above the carpet: `.aw-screen--arcaid::before` is a fixed z-index 0 layer. */}
                    <div className="relative z-[1]">{children}</div>
                    {overlays}
                </div>
            </PartSkinContext.Provider>
        );
    }

    const Main = embedded ? 'div' : 'main';
    return (
        <PartSkinContext.Provider value="arcaid">
            {/* G20 - a Witness-look page, like `components/AwPageShell.tsx`
                but wide: `sb-theme-scope aw-island` on the root puts every site
                component inside (dialogs too) on the dark defaults with its
                colour tokens pointed at the kit, whatever site theme the visitor
                wears. `bg-deep text-primary` are what shows for the moment before
                the kit stylesheets arrive. With `jump`, the page is GROUPS, each
                in its own colour, with a jump list beside them on a wide screen
                (`aw-web--wide`, capped at 1600 px like the results pages). The
                background is the arcade carpet, not the Witness picture
                (`aw-screen--arcaid`). */}
            <div
                className={`aw-screen aw-screen--arcaid sb-theme-scope aw-island${fullScreen} bg-deep text-primary`}
                style={rootStyle}
            >
                <div
                    className={`aw-layout aw-web${width === 'wide' ? ' aw-web--wide' : ''} px-4 sm:px-6`}
                    style={embedded ? EMBEDDED_LAYOUT : SAFE_AREA_TOP}
                >
                    {header ?? <PageTitle title={title} actions={actions === undefined ? <PageNavLinks /> : actions} />}

                    {jump ? (
                        <Main className="aw-settings">
                            <JumpList items={jump} />
                            <div className="aw-settings__groups">{children}</div>
                        </Main>
                    ) : (
                        <Main className="aw-web__main">{children}</Main>
                    )}

                    <footer className="aw-footer">
                        {footer === undefined ? <Link to="/">ARCAID.APP</Link> : footer}
                    </footer>
                </div>
                {overlays}
            </div>
        </PartSkinContext.Provider>
    );
}
