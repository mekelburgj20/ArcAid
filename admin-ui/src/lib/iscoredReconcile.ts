// Words for the Reconcile iScored dialog. Reconcile DELETES boards from a
// room's iScored account, and iScored has no undo, so the dialog names every
// game it is about to delete instead of only counting them (probros_gaming,
// 2026-10-27: a room converting from iScored would have seen its five live
// boards offered for deletion as "unmanaged").

export interface NamedIScoredGame {
  id: string;
  name: string;
}

/** A game's display name, falling back to its iScored id when it has none. */
export function iscoredGameLabel(g: NamedIScoredGame): string {
  return g.name?.trim() ? g.name.trim() : `(iScored game ${g.id})`;
}

/** "A", "A and B", "A, B and C" — every name, never cut short. */
export function joinGameNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The sentence under the list: what pressing Delete will remove. */
export function deletionSentence(games: NamedIScoredGame[]): string {
  if (games.length === 0) return 'Nothing is ticked, so nothing will be deleted.';
  const names = joinGameNames(games.map(iscoredGameLabel));
  return `${names} will be deleted from iScored, with every score on ${games.length === 1 ? 'it' : 'them'}.`;
}
