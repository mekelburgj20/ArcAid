/**
 * Where a tournament's results live (v2.238.0, B24): `/:slug/tournaments/:id`
 * opens its past runs, newest first; `?run=<gameId>` opens that one run's
 * final standings. The ONE builder for every link there: the card chip, the
 * past-games pile, History rows and the Lobby result item. The server's copy
 * (Discord close posts) is `tournamentRunUrl` in `src/utils/publicLinks.ts`.
 */
export function tournamentResultsPath(slug: string, tournamentId: string, runGameId?: string | null): string {
  const base = `/${slug}/tournaments/${encodeURIComponent(tournamentId)}`;
  return runGameId ? `${base}?run=${encodeURIComponent(runGameId)}` : base;
}

/**
 * A run's "By the numbers" recap (B31): the run's results link plus `&recap=1`.
 * The server's copy (Discord recap text) is `tournamentRunRecapUrl` in
 * `src/utils/publicLinks.ts`: change both together.
 */
export function tournamentRecapPath(slug: string, tournamentId: string, gameId: string): string {
  return `${tournamentResultsPath(slug, tournamentId, gameId)}&recap=1`;
}
