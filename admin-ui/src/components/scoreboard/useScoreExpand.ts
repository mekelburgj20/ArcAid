import { useCallback, useEffect, useState } from 'react';
import { fetchScoreCounts } from './scoreCountsBatcher';

export interface ScoreHistoryEntry {
  id: number;
  score: number;
  source: string;
  photo_url: string | null;
  created_at: string;
}

/**
 * Hook for expanding score rows to show player score history.
 * Fetches score counts on mount, then loads history on toggle.
 */
export function useScoreExpand(roomId: string | undefined, gameId: string, gameName: string, rankingsLength: number) {
  const [scoreCounts, setScoreCounts] = useState<Record<string, number>>({});
  const [expandedPlayer, setExpandedPlayer] = useState<string | null>(null);
  const [playerHistory, setPlayerHistory] = useState<ScoreHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => {
    if (!roomId || !gameId || rankingsLength === 0) return;
    fetchScoreCounts(roomId, gameId).then(setScoreCounts);
  }, [roomId, gameId, rankingsLength]);

  const togglePlayer = useCallback((username: string) => {
    if (expandedPlayer === username) {
      setExpandedPlayer(null);
      setPlayerHistory([]);
      return;
    }
    if (!roomId) return;
    setExpandedPlayer(username);
    setHistoryLoading(true);
    fetch(`/api/rooms/${roomId}/score-history/${encodeURIComponent(gameName)}/player/${encodeURIComponent(username)}`)
      .then(r => r.ok ? r.json() : [])
      .then(setPlayerHistory)
      .catch(() => setPlayerHistory([]))
      .finally(() => setHistoryLoading(false));
  }, [roomId, gameName, expandedPlayer]);

  const hasMultiple = (username: string) => (scoreCounts[username.toLowerCase()] || 0) > 1;

  return { scoreCounts, expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple };
}
