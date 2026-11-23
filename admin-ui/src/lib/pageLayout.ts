/**
 * The content width of the results pages (v2.241.0, B26): History, the
 * tournament page and the player page. Owner 2026-11-10: on a desktop the old
 * `max-w-4xl` column left wide empty margins and squeezed the content. Wide
 * enough to hold two columns of run cards, capped so a row never stretches
 * across an ultrawide screen. The Stats page already runs full width with the
 * same side padding.
 */
export const RESULTS_PAGE = 'w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10';

/**
 * G21 - the only two outer widths a page may use (`components/parts/PageShell.tsx`).
 * `wide` is the results pages' 1600 px (most pages: lists, boards, grouped
 * settings); `column` is the 52rem reading column of the Witness kit
 * (`.aw-web`), for a page that is one short form or one block of text. A page
 * capped at `max-w-md` to `max-w-4xl` is what made the site "look mobile" on a
 * desktop (style guide plan, G22).
 */
export const PAGE_WIDTH = { wide: RESULTS_PAGE, column: 'w-full max-w-[52rem] mx-auto px-4 sm:px-6' } as const;
