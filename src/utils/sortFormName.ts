/**
 * W114 — a table name written in library SORT FORM, turned back to the front.
 *
 * Legends Unchained's launcher names a table the way a library shelves it,
 * with the leading article moved behind a comma: "Spider-Man, JP's (Original
 * 2018)", "Avengers, JP's The (Original 2019)", "Champion Pub, The (Bally
 * 1998)". The catalogue (VPS names) and most rooms write "JP's Spider-Man",
 * "JP's The Avengers", "The Champion Pub". `normalizeGameName` keeps word
 * order, so "spider-man jps" never meets "jps spider-man" and a cabinet play
 * of a table the catalogue holds was refused as "not in the Arcaid catalogue"
 * (2026-11-18).
 *
 * This returns the FRONT form ("JP's Spider-Man (Original 2018)") so the
 * witness ingest can try it beside the name as sent, or null when the name is
 * not in sort form. The trailing parenthetical (the launcher's maker and year)
 * comes AFTER the moved article, so it is set aside and put back. Only a tail
 * that is nothing but an article counts: "X Files, The Hannibal Mod" and
 * "Space Cadet, JP's - Galaxy Edition" are left alone.
 *
 * Deliberately NOT part of `normalizeGameName`, which the catalogue's dedup
 * also uses: this is a matching aid for the witness ingest only.
 */

/** "<name>, <article>": The / A / An / JP's / JPs, and "JP's The". */
const SORT_FORM_TAIL = /^(.*\S)\s*,\s*(the|an?|jp['’]?s(?:\s+the)?)\s*$/i;

/** One or more parentheticals at the very end ("(Original 2018)", "(Pro) (Stern 2012)"). */
const TRAILING_PARENS = /(?:\s*\([^()]*\))+\s*$/;

export function frontFormOf(name: string | null | undefined): string | null {
    const trimmed = (name ?? '').trim();
    if (!trimmed) return null;
    const parens = TRAILING_PARENS.exec(trimmed);
    const head = parens ? trimmed.slice(0, parens.index) : trimmed;
    const sorted = SORT_FORM_TAIL.exec(head);
    if (!sorted) return null;
    const tail = parens ? ` ${parens[0].trim()}` : '';
    return `${sorted[2]} ${sorted[1]}${tail}`;
}
