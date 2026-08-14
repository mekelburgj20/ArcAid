import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchScoreCounts } from './scoreCountsBatcher';

export interface ScoreHistoryEntry {
  id: number;
  score: number;
  source: string;
  photo_url: string | null;
  created_at: string;
  /**
   * v2.108.0 — fields `GET /:roomId/score-history/:gameName/player/:username`
   * has ALWAYS returned; this local type just dropped them on the floor.
   * `submitted_by_user_id` is the raw ownership column the per-row delete gate
   * reads (never `discord_user_id`, which is a resolved display identity).
   */
  submitted_by_user_id?: string | null;
  iscored_username?: string;
  display_name?: string | null;
  tournament_id?: string | null;
  tournament_name?: string | null;
  tournament_active?: number;
  verified_by?: string | null;
  verified_at?: string | null;
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

  // Unmount guard for BOTH async paths below. The score-counts batcher runs a
  // module-level 50ms timer no component owns, so its promise can resolve
  // after this component (or the whole jsdom test env) is gone — an unguarded
  // setState there is the "window is not defined" CI flake
  // (LeaderboardAdminControls, 2× 2026-08). Same idiom as Leaderboard.tsx's
  // roomTheme effect; a ref rather than a per-effect flag because
  // togglePlayer's fetch chain needs the guard too and it's an event handler.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  useEffect(() => {
    if (!roomId || !gameId || rankingsLength === 0) return;
    fetchScoreCounts(roomId, gameId).then(counts => {
      if (!unmountedRef.current) setScoreCounts(counts);
    });
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
      .then(h => { if (!unmountedRef.current) setPlayerHistory(h); })
      .catch(() => { if (!unmountedRef.current) setPlayerHistory([]); })
      .finally(() => { if (!unmountedRef.current) setHistoryLoading(false); });
  }, [roomId, gameName, expandedPlayer]);

  const hasMultiple = (username: string) => (scoreCounts[username.toLowerCase()] || 0) > 1;

  /**
   * v2.108.0 — optimistic removal after a per-row delete, so the nested list
   * inside GameQuickView drops the row immediately instead of waiting for a
   * refetch. Purely local; the owning page still refetches authoritatively.
   */
  const removeHistoryEntry = useCallback((historyId: number) => {
    setPlayerHistory(prev => prev.filter(h => h.id !== historyId));
  }, []);

  return { scoreCounts, expandedPlayer, playerHistory, historyLoading, togglePlayer, hasMultiple, removeHistoryEntry };
}
