import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Style-system revamp P1 — a same-origin `about:blank` iframe that renders its
 * children at a REAL viewport width.
 *
 * Why an iframe and not a narrow `<div>`: the scoreboard's mobile behaviour is
 * expressed almost entirely as `@media (max-width: 640px)` CSS (the block
 * inside `ScoreboardSurface`, plus the `.sb-row-name` / `.sb-row-score` rules
 * that moved to `index.css` in v2.104.1) and as `window.matchMedia` reads
 * (`useIsMobileViewport`, which drives the QR gate). Both key off the BROWSER
 * viewport, so shrinking a div to 390px changes nothing about them — a
 * div-based "phone preview" would render desktop pixels in a narrow box and
 * quietly lie. Inside an iframe the viewport genuinely IS 390px, so every
 * media query, every `matchMedia` listener, and every Tailwind `sm:`/`md:`
 * utility resolves the way it does on a real phone.
 *
 * The mechanics:
 * - Children are portalled into the iframe's `<body>`, so they stay part of
 *   the parent React tree (context, state, and handlers all work normally).
 * - Every `<style>` / `<link rel="stylesheet">` in the parent `<head>` is
 *   cloned into the iframe. A `MutationObserver` re-syncs on change so Vite's
 *   HMR style injection doesn't leave the preview unstyled mid-session.
 * - `<base href>` is set to the parent origin: an `about:blank` document
 *   resolves relative URLs against `about:blank`, which would break every
 *   relative `url(...)` in the copied CSS (fonts, background images).
 * - The `<html>` class list is mirrored so ThemeProvider's `.theme-*` class
 *   reaches the preview.
 */
interface DevicePreviewFrameProps {
  /** Viewport width the iframe should report, in CSS px. */
  width: number;
  /**
   * Scales the whole frame down to fit its container. Applied as a CSS
   * transform on the iframe, so the iframe's own reported viewport stays
   * `width` — scaling must not change which media queries match.
   */
  scale?: number;
  children: ReactNode;
}

export default function DevicePreviewFrame({ width, scale = 1, children }: DevicePreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [mountNode, setMountNode] = useState<HTMLElement | null>(null);
  const [contentHeight, setContentHeight] = useState(320);

  // Prepare the iframe document: base href, head styles, theme classes.
  // useLayoutEffect so the stylesheets are in place before the portalled
  // children paint — otherwise the preview flashes unstyled.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc) return;

    // about:blank resolves relative URLs against itself; point it at the app.
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.setAttribute('href', window.location.origin + '/');
      doc.head.appendChild(base);
    }

    doc.body.style.margin = '0';
    doc.body.style.background = 'transparent';

    const syncStyles = () => {
      // Drop the previous generation wholesale rather than diffing — a preview
      // repaint is cheap and diffing <style> nodes by content is not.
      doc.querySelectorAll('[data-arcaid-preview-style]').forEach(n => n.remove());
      document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => {
        const clone = node.cloneNode(true) as HTMLElement;
        clone.setAttribute('data-arcaid-preview-style', '');
        doc.head.appendChild(clone);
      });
      // ThemeProvider puts the active `.theme-*` class on <html>.
      doc.documentElement.className = document.documentElement.className;
    };

    syncStyles();

    const observer = new MutationObserver(syncStyles);
    observer.observe(document.head, { childList: true, subtree: true });
    const htmlObserver = new MutationObserver(() => {
      doc.documentElement.className = document.documentElement.className;
    });
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    setMountNode(doc.body);
    return () => {
      observer.disconnect();
      htmlObserver.disconnect();
    };
  }, []);

  // Grow the iframe to its content so the preview never has its own scrollbar
  // — the panel around it scrolls instead, matching the old preview's feel.
  useEffect(() => {
    const doc = frameRef.current?.contentDocument;
    if (!doc || !mountNode) return;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      setContentHeight(Math.max(240, doc.body.scrollHeight));
    });
    observer.observe(doc.body);
    return () => observer.disconnect();
  }, [mountNode]);

  return (
    <div style={{ height: contentHeight * scale, overflow: 'hidden' }}>
      <iframe
        ref={frameRef}
        title="Scoreboard preview"
        // `sandbox` is deliberately omitted: a sandboxed frame gets an opaque
        // origin, which would block `contentDocument` access entirely. The
        // frame renders only our own components — no third-party content.
        style={{
          width,
          height: contentHeight,
          border: 0,
          display: 'block',
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      />
      {mountNode && createPortal(children, mountNode)}
    </div>
  );
}
