import { useEffect, useState } from 'react';
import { getPortal } from '../lib/portal';

type State = { loading: boolean; enabled: boolean };

const cache = new Map<string, boolean>();

/**
 * Reads the room-scoped pick-award flag via the shared portal cache (S18 — was
 * its own private fetch of /api/portal?slug=...). v2.56.0: the backing value is
 * "any tournament in this room has winner-picks on"; the room-level
 * ENABLE_GAME_PICK_AWARD setting it used to read no longer exists.
 *
 * Returns `{ loading, enabled }`. Treat `loading` as "unknown" — callers that
 * conditionally render a nav item should render nothing until loading resolves
 * to avoid flicker.
 */
export function usePickAwardEnabled(slug: string | undefined): State {
  const [state, setState] = useState<State>(() => {
    if (slug && cache.has(slug)) return { loading: false, enabled: cache.get(slug)! };
    return { loading: true, enabled: false };
  });

  useEffect(() => {
    if (!slug) { setState({ loading: false, enabled: false }); return; }
    if (cache.has(slug)) { setState({ loading: false, enabled: cache.get(slug)! }); return; }

    let cancelled = false;
    getPortal(slug)
      .then(data => {
        if (cancelled) return;
        const enabled = !!data?.pick_award_enabled;
        cache.set(slug, enabled);
        setState({ loading: false, enabled });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, enabled: false });
      });
    return () => { cancelled = true; };
  }, [slug]);

  return state;
}
