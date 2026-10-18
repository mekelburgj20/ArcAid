/**
 * Season format (docs/season-format-plan.md §3.1, §8.1, §13) — the pure half
 * of the tournament form's "Season" section: its state, its defaults, the
 * client-side mirror of the server's validation and its slice of the body.
 *
 * As of v2.162.0 (ADR 0026) a Season is ONLY the bound — N tables, a standings
 * group (Countdown on the Rankings page), pause and season end. How each table
 * is chosen is the Game Rotation section's job; the poll lives in
 * `lib/pollForm.ts`. A Season alone forces nothing.
 *
 * Kept out of `components/TournamentForm.tsx` so the form file keeps exporting
 * components (react-refresh) and so these stay unit-testable without a render.
 */

export interface SeasonFormState {
  /** Off = not a season (`season_table_count: null` on save). */
  enabled: boolean;
  tableCount: number;
}

export const defaultSeasonState: SeasonFormState = {
  enabled: false,
  tableCount: 12,
};

/**
 * Client-side mirror of `resolveSeason` in `src/services/TournamentService.ts`.
 * Empty when the season is off or valid. The server re-validates either way.
 */
export function getSeasonErrors(season: SeasonFormState): string[] {
  if (!season.enabled) return [];
  if (!Number.isInteger(season.tableCount) || season.tableCount < 1 || season.tableCount > 200) {
    return ['A season must have between 1 and 200 tables.'];
  }
  return [];
}

/** The season block of the tournament create/update body. */
export function seasonPayload(season: SeasonFormState): Record<string, unknown> {
  if (!season.enabled) return { season_table_count: null };
  return { season_table_count: season.tableCount };
}

/** Raw season column as `GET /:roomId/tournaments` ships it. */
export interface SeasonColumns {
  season_table_count?: number | null;
}

export function seasonStateFromRow(t: SeasonColumns): SeasonFormState {
  return {
    enabled: t.season_table_count != null,
    tableCount: t.season_table_count ?? defaultSeasonState.tableCount,
  };
}
