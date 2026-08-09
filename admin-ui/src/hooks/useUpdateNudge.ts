import { useCallback, useEffect, useState } from 'react';
import {
  applyFetchedVersion,
  initialUpdateNudgeState,
  shouldShowUpdateNudge,
  UPDATE_NUDGE_DISMISS_KEY,
  UPDATE_NUDGE_POLL_INTERVAL_MS,
  type UpdateNudgeState,
} from '../lib/updateNudge';

/**
 * Boots a `/api/version` baseline once, re-checks on `visibilitychange` and a
 * 15-minute backstop, and reports whether the stale-PWA "new version
 * available" nudge should show. Compare/dismiss math lives in
 * `lib/updateNudge.ts` (pure, unit-tested there); this hook is just the
 * fetch/timer/localStorage plumbing around it.
 *
 * Silent on any fetch failure (offline, server hiccup) — never nags on error.
 */
export function useUpdateNudge() {
  const [state, setState] = useState<UpdateNudgeState>(initialUpdateNudgeState);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem(UPDATE_NUDGE_DISMISS_KEY);
    } catch {
      return null;
    }
  });

  const checkVersion = useCallback(async () => {
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const data = await res.json();
      if (data && typeof data.version === 'string' && data.version) {
        setState(prev => applyFetchedVersion(prev, data.version));
      }
    } catch {
      // Offline / network failure — silent, try again on the next trigger.
    }
  }, []);

  useEffect(() => {
    checkVersion();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkVersion();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const interval = setInterval(checkVersion, UPDATE_NUDGE_POLL_INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
  }, [checkVersion]);

  const dismiss = useCallback(() => {
    if (!state.latest) return;
    setDismissedVersion(state.latest);
    try {
      localStorage.setItem(UPDATE_NUDGE_DISMISS_KEY, state.latest);
    } catch {
      // localStorage unavailable (private mode etc) — dismissal stays in-memory for this session.
    }
  }, [state.latest]);

  const refresh = useCallback(() => {
    window.location.reload();
  }, []);

  return {
    show: shouldShowUpdateNudge(state, dismissedVersion),
    dismiss,
    refresh,
  };
}
