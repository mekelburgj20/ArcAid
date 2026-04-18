import { useEffect, useState } from 'react';

type State = { loading: boolean; enabled: boolean };

const cache = new Map<string, boolean>();

/**
 * Reads the ENABLE_GAME_PICK_AWARD flag for a room via /api/portal?slug=...
 * Shared lightweight cache so nav/pages don't re-fetch on every render.
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
    fetch(`/api/portal?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
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
