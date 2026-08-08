/**
 * Tournament-mode ↔ catalogue-type matching (v2.87.0).
 *
 * `tournaments.mode` (Zod: `'pinball' | 'videogame'`, see
 * `src/types/index.ts`) and `global_games.type` (`'pinball' | 'video_game' |
 * 'arcade'`, see `src/utils/scoreProvenance.ts`'s `raCatalogueType`) are two
 * different vocabularies that were being compared with a raw `===`/`!==` at
 * every eligibility site. `'videogame'` never equals `'video_game'` or
 * `'arcade'` as a string, so every videogame-mode tournament matched ZERO
 * catalogue games — pick, autopick, and autocomplete all silently came back
 * empty.
 *
 * This is the one place that vocabulary is bridged. Every call site that
 * needs to know "does this catalogue game's type satisfy this tournament's
 * mode" must route through `catalogueTypeMatchesTournamentMode` — never a
 * raw compare — so the mapping can't drift out from under any one site.
 */

/**
 * Catalogue `global_games.type` values accepted by a given tournament mode.
 * `videogame` is deliberately broad (video_game ∪ arcade); every other mode
 * — including any future/unrecognized mode string — keeps exact-match
 * behavior via the fallback below.
 */
const TOURNAMENT_MODE_CATALOGUE_TYPES: Record<string, readonly string[]> = {
    videogame: ['video_game', 'arcade'],
    pinball: ['pinball'],
};

/**
 * The set of catalogue `type` values that satisfy `tournamentMode`.
 * Unrecognized modes fall back to exact-match (a single-element set
 * containing the mode itself), matching pre-existing behavior for anything
 * not explicitly mapped.
 */
export function catalogueTypesForTournamentMode(
    tournamentMode: string | null | undefined,
): readonly string[] {
    if (!tournamentMode) return [];
    return TOURNAMENT_MODE_CATALOGUE_TYPES[tournamentMode] ?? [tournamentMode];
}

/**
 * Does `catalogueType` (a `global_games.type` / catalogue-row `mode` value)
 * satisfy `tournamentMode` (a `tournaments.mode` value)?
 *
 * A falsy `tournamentMode` matches everything (no mode filter applied) —
 * mirrors the pre-existing "no mode filter" behavior at call sites that
 * guarded on `tournament.mode` being set before filtering.
 */
export function catalogueTypeMatchesTournamentMode(
    catalogueType: string | null | undefined,
    tournamentMode: string | null | undefined,
): boolean {
    if (!tournamentMode) return true;
    if (!catalogueType) return false;
    return catalogueTypesForTournamentMode(tournamentMode).includes(catalogueType);
}
