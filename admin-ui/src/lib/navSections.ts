/**
 * Room nav active-state mapping (PublicLayout's top bar).
 *
 * Lives in `lib/` rather than beside the layout so PublicLayout.tsx stays a
 * components-only module (react-refresh) and so the mapping is trivially
 * unit-testable.
 */

/**
 * The nav sections a room-scoped path can belong to. `null` = no room section
 * owns this path (e.g. the non-scoped `/scoreboard` "Global" tab, whose nav
 * unmounts anyway, or an unrecognised route).
 */
export type NavSection = 'lobby' | 'scores' | 'picks' | 'stats' | 'players';

/**
 * Which nav icon should be lit for a given pathname.
 *
 * NavLink's default matching only lights a tab when the URL is the item's own
 * path or a descendant of it, and five of our pages are URL *siblings* of their
 * section head (`/:slug/history` is not under `/:slug/stats`, `/:slug/games/x`
 * is not under `/:slug`, …). Those pages could therefore never light anything,
 * which is the reported "Stats loses its highlight on Stats → History" bug.
 * Keeping the whole mapping in one pure function makes it testable and keeps
 * the render site free of per-item inline predicates.
 *
 * `/:slug/tournaments/:id` doesn't exist yet — a follow-up pass adds it under
 * the Stats section, and the predicate is written for it now so the nav is
 * correct the moment the route lands.
 */
export function navSectionForPath(pathname: string, slug: string | undefined): NavSection | null {
    if (!slug) return null;
    // Trailing slashes are equivalent to their bare form ('/x/history/' === '/x/history').
    const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
    const root = `/${slug}`;
    if (path !== root && !path.startsWith(`${root}/`)) return null;

    const rest = path.slice(root.length); // '' for the room root, else '/segment…'
    if (rest === '') return 'scores';
    if (rest.startsWith('/games/')) return 'scores';
    if (rest === '/lobby') return 'lobby';
    if (rest === '/picks' || rest === '/mystery-award') return 'picks';
    if (rest === '/stats' || rest === '/history' || rest === '/compare') return 'stats';
    if (rest === '/tournaments' || rest.startsWith('/tournaments/')) return 'stats';
    if (rest === '/members') return 'players';
    if (rest.startsWith('/players/')) return 'players';
    return null;
}
