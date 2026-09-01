import { useEffect, useRef } from 'react';
import { getSocket } from '../lib/websocket';

/**
 * Keeps a live-updating page honest when the WebSocket cannot.
 *
 * Owner report 2026-09-01: "the scoreboard doesn't auto refresh for mobile or
 * desktop. You have to manually refresh."
 *
 * The socket wiring was never the problem — `score:new` and
 * `leaderboard:updated` have always been emitted and listened for. What was
 * missing is everything around a socket that is not currently delivering:
 *
 *   1. **A reconnect refetched nothing.** Every page re-joined `room:<id>` on
 *      `connect` (room membership is per-connection and does not survive a
 *      drop) but never reloaded, so any score submitted DURING the gap was
 *      simply never seen. The page then sat there looking connected and
 *      healthy, showing stale numbers until the next live event happened to
 *      arrive. On a phone this is the normal case, not an edge case: the tab is
 *      frozen the moment you switch apps.
 *   2. **Coming back to a backgrounded tab did nothing.** A frozen page may not
 *      even notice the socket died, so `connect` never fires and there is
 *      nothing to hook. Visibility is the only reliable signal that a phone
 *      user is looking again.
 *   3. **A silently dead socket was forever.** A proxy idle-timeout or a
 *      network switch can leave a socket that believes it is open. Without a
 *      backstop the page never recovers on its own.
 *
 * So: refetch on RE-connect, refetch when the tab becomes visible, and poll
 * slowly as a floor. The poll is the least important of the three and is
 * deliberately slack — it exists to catch case 3, not to be the update
 * mechanism. It never runs while the document is hidden, so a backgrounded
 * phone tab and a closed laptop lid cost nothing.
 *
 * All three triggers share one throttle, so a reconnect that coincides with a
 * tab focus fires a single fetch.
 *
 * Deliberately NOT here: the socket event handlers themselves. Each page
 * listens for the events it cares about and decides what to reload; this hook
 * only answers "we may have missed something, reload whatever you reload".
 */

/** Backstop poll. Slack on purpose — the socket is the real mechanism. */
export const LIVE_REFRESH_INTERVAL_MS = 60_000;

/** Collapses triggers that land together (reconnect + focus is the common pair). */
export const LIVE_REFRESH_THROTTLE_MS = 5_000;

export function useLiveRefresh(
  refresh: () => void,
  opts: { enabled?: boolean; intervalMs?: number } = {},
) {
  const { enabled = true, intervalMs = LIVE_REFRESH_INTERVAL_MS } = opts;

  // Held in a ref so a caller passing an inline arrow (all of them) doesn't
  // tear down and rebuild the listeners on every render. Assigned in an effect
  // rather than during render — writing a ref mid-render is what
  // `react-hooks/refs` (rightly) objects to, and an effect with no dependency
  // array runs after every commit, which is exactly when the value changes.
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; });

  useEffect(() => {
    if (!enabled) return;
    let lastRun = 0;

    const run = () => {
      const now = Date.now();
      if (now - lastRun < LIVE_REFRESH_THROTTLE_MS) return;
      lastRun = now;
      refreshRef.current();
    };

    // Only a RE-connect is interesting. The first `connect` races the page's
    // own initial load and would just duplicate it.
    let sawDisconnect = false;
    const socket = getSocket();
    const onDisconnect = () => { sawDisconnect = true; };
    const onConnect = () => {
      if (!sawDisconnect) return;
      sawDisconnect = false;
      run();
    };
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);

    const onVisible = () => { if (!document.hidden) run(); };
    document.addEventListener('visibilitychange', onVisible);
    // iOS Safari restoring from the back/forward cache fires neither
    // `visibilitychange` nor a socket event — `pageshow` is the one signal
    // that always arrives.
    window.addEventListener('pageshow', onVisible);
    // Desktop: alt-tabbing back to an already-visible window fires `focus`
    // without a visibility change.
    window.addEventListener('focus', onVisible);

    const interval = window.setInterval(() => {
      if (!document.hidden) run();
    }, intervalMs);

    return () => {
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(interval);
    };
  }, [enabled, intervalMs]);
}
