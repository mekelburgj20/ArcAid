/**
 * The content width of the results pages (v2.241.0, B26): History, the
 * tournament page and the player page. Owner 2026-11-10: on a desktop the old
 * `max-w-4xl` column left wide empty margins and squeezed the content. Wide
 * enough to hold two columns of run cards, capped so a row never stretches
 * across an ultrawide screen. The Stats page already runs full width with the
 * same side padding.
 */
export const RESULTS_PAGE = 'w-full max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10';
