import { useCallback, useMemo, useState } from 'react';
import { useToast } from '../components/Toast';
import type { CardAttemptStartValue } from '../components/scoreboard/cardAttemptStartContext';
import {
  ATTEMPT_STARTS_CHANGED_EVENT, fetchRoomAttemptStarts, pressAttemptStart, type RoomAttemptStart,
} from '../lib/attemptStarts';

/**
 * W56 (ADR 0033 §4) — the public Scoreboard's ONE room-level read of the
 * viewer's "Start attempts" list, and the press. Returns the value for
 * `CardAttemptStartContext` (null = no control on any card: a guest, or no
 * limited-attempts table open) and `reload`, which the page calls alongside
 * its board loads so a rotation or round change is picked up. The same list
 * feeds the press strip (start-required tables only) and, W82, each card's
 * "N attempts left" badge (every listed table).
 *
 * After a press the list is re-read (the card flips to "Attempts started")
 * and `ATTEMPT_STARTS_CHANGED_EVENT` tells the "Your scores go to" strip.
 */
export function useRoomAttemptStarts(roomId: string | null | undefined, playerToken: string | null | undefined): {
  value: CardAttemptStartValue | null;
  reload: () => Promise<void>;
} {
  const { toast } = useToast();
  const [games, setGames] = useState<RoomAttemptStart[]>([]);
  const [pendingGameId, setPendingGameId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!roomId || !playerToken) { setGames([]); return; }
    setGames(await fetchRoomAttemptStarts(roomId, playerToken));
  }, [roomId, playerToken]);

  const start = useCallback(async (item: RoomAttemptStart) => {
    if (!roomId || !playerToken) return;
    setPendingGameId(item.gameId);
    try {
      const result = await pressAttemptStart(roomId, item, playerToken);
      if (!result.ok) { toast(result.error, 'error'); return; }
      toast(`Attempts started on ${item.gameName} — your plays there count from now`, 'success');
      await reload();
      window.dispatchEvent(new Event(ATTEMPT_STARTS_CHANGED_EVENT));
    } finally {
      setPendingGameId(null);
    }
  }, [roomId, playerToken, reload, toast]);

  const value = useMemo<CardAttemptStartValue | null>(() => (
    !playerToken || games.length === 0 ? null : {
      byGameId: Object.fromEntries(games.map(g => [g.gameId, g])),
      pendingGameId,
      start: (item) => { void start(item); },
    }
  ), [playerToken, games, pendingGameId, start]);

  return { value, reload };
}
