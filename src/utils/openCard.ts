/**
 * W33 (owner ruling 2026-10-25) — the ONE answer to "is this card open?".
 *
 * A card is open when its game is `ACTIVE` and its tournament has not
 * FINISHED. Finished means an event whose clock has ended
 * (`event_finished_at` set). It does NOT mean `is_active = 0`: on a rotation
 * that is a PAUSE, which only stops the rotation — the live card keeps taking
 * typed and device scores (owner ruling 2026-10-25). A season that finishes
 * keeps `is_active = 1` by design so its retained cards keep rendering, and is
 * not covered here.
 *
 * The board, the witness ingest, the device designation and the web submit
 * resolver all read this, so a card can never look live on one surface and
 * refuse scores on another (the stray "JP's Pokemon Pinball" card on the
 * finished TWR Tournament #1, 2026-10-24/25).
 *
 * Every fragment is safe under a LEFT JOIN of `tournaments`: a pinned game has
 * no tournament, so its NULL `event_finished_at` reads as not finished.
 */

/** SQL: the tournament under alias `t` has finished. */
export function tournamentFinishedSql(t = 't'): string {
    return `(${t}.event_finished_at IS NOT NULL)`;
}

/** SQL: the game under alias `g` (tournament `t`) is an open card. */
export function openCardSql(g = 'g', t = 't'): string {
    return `(${g}.status = 'ACTIVE' AND ${t}.event_finished_at IS NULL)`;
}

/** The same rule over a row already in hand. */
export function isTournamentFinished(t: { event_finished_at?: string | null } | null | undefined): boolean {
    return !!t?.event_finished_at;
}
