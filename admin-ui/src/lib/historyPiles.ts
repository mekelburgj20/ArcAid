/**
 * v2.236.0 (B23) — "past games" piles on the room scoreboard.
 *
 * A rotation tournament whose `cleanup_rule` retains finished games leaves
 * every one of them on the board as a full-size locked card, and they push the
 * live tables off-screen (owner, 2026-11-09, RTX Daily Grind: one live card,
 * four locked ones). The public board folds each tournament's COMPLETED cards
 * into ONE pile drawn behind that tournament's live card, newest on top.
 *
 * This module is the grouping rule and nothing else — pure, so the pile can be
 * tested without rendering a card. The rules:
 *
 *   - Only a COMPLETED card that belongs to a tournament joins a pile. Pinned
 *     boards (no tournament) and live cards never do.
 *   - The pile sits on the tournament's LAST live card in board order (a
 *     multi-slot tournament keeps its other live cards where they were).
 *   - A tournament with no live card (between rotations) piles under its
 *     newest finished card; a lone finished card stays a plain card.
 *   - History is ordered newest first by `endedAt` when every card has one,
 *     otherwise in the order the server sent (which is also newest first,
 *     unless an admin's manual card order moved them).
 *   - The pile takes the board position of its top card; folded cards leave
 *     their own positions.
 */

export interface PileableCard {
  gameId: string;
  gameStatus: string;
  tournamentId?: string | null;
  isPinned?: boolean;
  endedAt?: string | null;
}

export type BoardUnit<T> =
  | { kind: 'card'; lb: T }
  | { kind: 'pile'; tournamentId: string; top: T; history: T[] };

const isHistory = (c: PileableCard) =>
  c.gameStatus === 'COMPLETED' && !!c.tournamentId && !c.isPinned;

/** Newest first. ISO-8601 strings compare correctly as text. */
function byRecency<T extends PileableCard>(cards: T[]): T[] {
  if (!cards.every(c => !!c.endedAt)) return cards;
  return [...cards].sort((a, b) => (b.endedAt! < a.endedAt! ? -1 : b.endedAt! > a.endedAt! ? 1 : 0));
}

export function buildHistoryPiles<T extends PileableCard>(cards: T[]): BoardUnit<T>[] {
  const historyByTournament = new Map<string, T[]>();
  for (const c of cards) {
    if (!isHistory(c)) continue;
    const list = historyByTournament.get(c.tournamentId!) ?? [];
    list.push(c);
    historyByTournament.set(c.tournamentId!, list);
  }
  if (historyByTournament.size === 0) return cards.map(lb => ({ kind: 'card' as const, lb }));

  // Which card each pile sits on, and what lies under it.
  const piles = new Map<string, { top: T; history: T[] }>();
  for (const [tid, raw] of historyByTournament) {
    const ordered = byRecency(raw);
    let top: T | undefined;
    for (const c of cards) {
      if (c.tournamentId === tid && !c.isPinned && c.gameStatus !== 'COMPLETED') top = c;
    }
    if (top) {
      piles.set(tid, { top, history: ordered });
    } else if (ordered.length > 1) {
      piles.set(tid, { top: ordered[0]!, history: ordered.slice(1) });
    }
  }

  const units: BoardUnit<T>[] = [];
  for (const c of cards) {
    const tid = c.tournamentId;
    const pile = tid && !c.isPinned ? piles.get(tid) : undefined;
    if (!pile) { units.push({ kind: 'card', lb: c }); continue; }
    if (pile.top === c) { units.push({ kind: 'pile', tournamentId: tid!, top: c, history: pile.history }); continue; }
    if (isHistory(c)) continue; // folded into the pile
    units.push({ kind: 'card', lb: c }); // another live card of a multi-slot tournament
  }
  return units;
}
