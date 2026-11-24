import { useEffect } from 'react';

/**
 * W105 (v2.251.0) - the Arcaid Witness theme on the website.
 *
 * The designer's kit lives verbatim in `public/aw-theme/` (`aw-theme.css`, the
 * Arcaid extension `aw-theme-ext.css`, `fonts/`, `assets/`) with the site's own
 * small layer `aw-web.css` after it. It is NOT a site theme id (`lib/themeIds.ts`):
 * it is loaded only while a Witness page or Account Settings (the whole page
 * since G20) is mounted, through `useAwTheme`, and removed again when the last
 * one unmounts, so no other page ever carries it.
 *
 * Bump `AW_THEME_VERSION` whenever a file under `public/aw-theme/` changes: the
 * browser caches public statics for a day, and the query string is what makes a
 * changed stylesheet load at once (rename a changed font or image instead).
 */
export const AW_THEME_VERSION = '6';

export const AW_THEME_STYLESHEETS = [
    '/aw-theme/aw-theme.css',
    '/aw-theme/aw-theme-ext.css',
    '/aw-theme/aw-web.css',
] as const;

export const AW_BADGE_SRC = '/aw-theme/assets/logo/arcaid-witness-badge-256.png';
export const AW_BADGE_SRCSET = `${AW_BADGE_SRC} 1x, /aw-theme/assets/logo/arcaid-witness-badge-512.png 2x`;

const LINK_ATTR = 'data-aw-theme';
let users = 0;

function attach(): void {
    for (const href of AW_THEME_STYLESHEETS) {
        if (document.head.querySelector(`link[${LINK_ATTR}="${href}"]`)) continue;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${href}?v=${AW_THEME_VERSION}`;
        link.setAttribute(LINK_ATTR, href);
        document.head.appendChild(link);
    }
}

function detach(): void {
    document.head.querySelectorAll(`link[${LINK_ATTR}]`).forEach(l => l.remove());
}

/** Load the Witness theme while the calling component is mounted (reference-counted). */
export function useAwTheme(): void {
    useEffect(() => {
        users += 1;
        if (users === 1) attach();
        return () => {
            users -= 1;
            if (users === 0) detach();
        };
    }, []);
}

/** `useAwTheme` as an element, for a Witness section inside a page that is not itself a Witness page. */
export function AwThemeStyles(): null {
    useAwTheme();
    return null;
}
