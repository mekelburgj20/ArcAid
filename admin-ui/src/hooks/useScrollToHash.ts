import { useEffect, useRef } from 'react';

/**
 * A14.2 - React Router does not scroll to a URL hash on navigation, and the
 * element a hash names (e.g. `#ratings` on the game pages) often mounts only
 * after a fetch resolves. Call this with `ready` true once that element is in
 * the DOM; it scrolls to `window.location.hash` once per mount.
 */
export function useScrollToHash(ready: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    const hash = typeof window !== 'undefined' ? window.location.hash : '';
    if (!hash || hash.length < 2) return;
    let id = hash.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // malformed escape: keep the raw id
    }
    const el = document.getElementById(id);
    if (!el) return;
    done.current = true;
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [ready]);
}
