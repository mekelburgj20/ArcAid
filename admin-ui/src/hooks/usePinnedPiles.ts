import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchPinnedPiles, readLocalPinnedPiles, savePilePinned, writeLocalPinnedPiles } from '../lib/pinnedPiles';

export interface PinnedPilesState {
  isPinned: (tournamentId: string) => boolean;
  setPinned: (tournamentId: string, pinned: boolean) => void;
}

/**
 * v2.236.0 (B23) — the viewer's pinned-open "past games" piles.
 *
 * Starts from the localStorage mirror (no flash), then a signed-in player's
 * server list replaces it — the server is the truth, so a pile unpinned on
 * the phone does not come back from a stale laptop mirror. A guest's list
 * lives in localStorage only. Writes are optimistic; a failed save keeps the
 * local state, which the next server read corrects.
 */
export function usePinnedPiles(playerToken: string | null): PinnedPilesState {
  const [pinned, setPinnedList] = useState<string[]>(() => readLocalPinnedPiles());

  useEffect(() => {
    if (!playerToken) return;
    let cancelled = false;
    void fetchPinnedPiles(playerToken).then(ids => {
      if (!cancelled && ids) setPinnedList(ids);
    });
    return () => { cancelled = true; };
  }, [playerToken]);

  useEffect(() => { writeLocalPinnedPiles(pinned); }, [pinned]);

  const setPinned = useCallback((tournamentId: string, value: boolean) => {
    setPinnedList(prev => {
      const next = prev.filter(id => id !== tournamentId);
      if (value) next.push(tournamentId);
      return next;
    });
    if (playerToken) void savePilePinned(playerToken, tournamentId, value);
  }, [playerToken]);

  return useMemo(() => ({
    isPinned: (tournamentId: string) => pinned.includes(tournamentId),
    setPinned,
  }), [pinned, setPinned]);
}
