import { useEffect, useState } from 'react';

/**
 * ≥1024px (Tailwind `lg`) is the desktop editing layout; anything narrower gets
 * the phone/tablet sheet. Only ONE of the two is ever mounted — the panels own
 * file inputs addressed by element id, so a hidden second copy would shadow
 * them. Defaults to wide when `matchMedia` is unavailable (jsdom), mirroring
 * the guard idiom in ScoreboardSurface/ThemeProvider.
 *
 * v2.124.0 (C3): lifted out of `pages/Leaderboard.tsx` — `CardStyleEditorSheet`
 * needs the same split, and two copies of a breakpoint is how the rail and the
 * sheet would eventually disagree about where "mobile" starts.
 */
export function useIsWideViewport(): boolean {
  const [wide, setWide] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(min-width: 1024px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const handler = () => setWide(mq.matches);
    handler();
    if (mq.addEventListener) mq.addEventListener('change', handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', handler);
      else mq.removeListener(handler);
    };
  }, []);
  return wide;
}

export default useIsWideViewport;
