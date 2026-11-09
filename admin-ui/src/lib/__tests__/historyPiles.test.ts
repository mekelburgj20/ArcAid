import { describe, it, expect } from 'vitest';
import { buildHistoryPiles, type PileableCard } from '../historyPiles';

/** v2.236.0 (B23) — the grouping rule behind the board's past-games piles. */

const live = (gameId: string, tournamentId: string | null): PileableCard =>
  ({ gameId, gameStatus: 'ACTIVE', tournamentId });
const done = (gameId: string, tournamentId: string, endedAt?: string): PileableCard =>
  ({ gameId, gameStatus: 'COMPLETED', tournamentId, endedAt: endedAt ?? null });

const shape = (cards: PileableCard[]) => buildHistoryPiles(cards).map(u =>
  u.kind === 'card' ? u.lb.gameId : `${u.top.gameId}[${u.history.map(h => h.gameId).join(',')}]`);

describe('buildHistoryPiles', () => {
  it('leaves a board without finished cards untouched', () => {
    expect(shape([live('a', 't1'), live('b', 't2')])).toEqual(['a', 'b']);
  });

  it('stacks a tournament\'s finished cards under its live card (the RTX Daily Grind board)', () => {
    const board = [
      live('monster', 'dg'),
      done('godzilla', 'dg', '2026-11-08T03:00:00.000Z'),
      done('darius', 'dg', '2026-11-07T03:00:00.000Z'),
      done('afm', 'dg', '2026-11-06T03:00:00.000Z'),
      done('elevator', 'dg', '2026-11-05T03:00:00.000Z'),
      live('bk2k', 'dg-vpx'),
    ];
    expect(shape(board)).toEqual(['monster[godzilla,darius,afm,elevator]', 'bk2k']);
  });

  it('orders the pile newest first by endedAt, whatever order the board sent', () => {
    const board = [
      done('old', 'dg', '2026-11-01T03:00:00.000Z'),
      live('now', 'dg'),
      done('newest', 'dg', '2026-11-08T03:00:00.000Z'),
      done('mid', 'dg', '2026-11-05T03:00:00.000Z'),
    ];
    expect(shape(board)).toEqual(['now[newest,mid,old]']);
  });

  it('keeps the server order when an end time is missing', () => {
    const board = [live('now', 'dg'), done('x', 'dg', '2026-11-01T00:00:00.000Z'), done('y', 'dg')];
    expect(shape(board)).toEqual(['now[x,y]']);
  });

  it('a multi-slot tournament keeps its other live cards; the pile sits on the last one', () => {
    const board = [live('w1', 'wg'), live('w2', 'wg'), done('w0', 'wg', '2026-11-01T00:00:00.000Z')];
    expect(shape(board)).toEqual(['w1', 'w2[w0]']);
  });

  it('with no live card the newest finished card is the top, and a lone one stays plain', () => {
    expect(shape([
      done('b', 'dg', '2026-11-02T00:00:00.000Z'),
      done('c', 'dg', '2026-11-03T00:00:00.000Z'),
      live('z', 'other'),
    ])).toEqual(['c[b]', 'z']);
    expect(shape([done('solo', 'dg', '2026-11-02T00:00:00.000Z')])).toEqual(['solo']);
  });

  it('never piles pinned boards or cards without a tournament', () => {
    const pinned: PileableCard = { gameId: 'pin', gameStatus: 'COMPLETED', tournamentId: null, isPinned: true };
    expect(shape([live('a', null), pinned])).toEqual(['a', 'pin']);
  });

  it('keeps tournaments apart', () => {
    const board = [
      live('dg-now', 'dg'), live('wg-now', 'wg'),
      done('dg-old', 'dg', '2026-11-01T00:00:00.000Z'), done('wg-old', 'wg', '2026-11-01T00:00:00.000Z'),
    ];
    expect(shape(board)).toEqual(['dg-now[dg-old]', 'wg-now[wg-old]']);
  });
});
