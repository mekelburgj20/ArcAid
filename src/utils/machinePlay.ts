/**
 * The ONE definition of "a game a machine recorded" (B31, plan section 0.2).
 *
 * Only `score_history.source = 'vpx'` rows are games: each is one game reported
 * by Arcaid Witness (a cabinet or Castcade on a desktop), filed per GAME by the
 * ingest. `'atgames'` is NOT a play source (AtGames keeps each player's BEST
 * only, so one row is about one best, not one game); `tournament`, `community`
 * (typed) and `sync` (iScored, unknown provenance) are typed or synced scores.
 *
 * The run recaps and the planned global rankings both read this list. No other
 * file may list play sources: import from here.
 */

export const MACHINE_PLAY_SOURCES: readonly string[] = ['vpx'];

/** True when a `score_history.source` value is a game a machine recorded. */
export function isMachinePlay(source: string | null | undefined): boolean {
    return !!source && MACHINE_PLAY_SOURCES.includes(source);
}

/** SQL predicate over `<alias>.source`, built from the constant. */
export function machinePlaySql(alias = 'sh'): string {
    return `${alias}.source IN (${MACHINE_PLAY_SOURCES.map(s => `'${s.replace(/'/g, "''")}'`).join(', ')})`;
}
