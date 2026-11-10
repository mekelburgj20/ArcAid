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
