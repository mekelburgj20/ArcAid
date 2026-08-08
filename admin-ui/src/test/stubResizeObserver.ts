/**
 * Installs a no-op `ResizeObserver` for tests that render the scoreboard.
 *
 * jsdom implements none, and the surface has two always-on layout effects that
 * construct one unconditionally: `ScoreboardSurface` measures the header so the
 * background image can start below it, and `HorizontalScrollNav` tracks whether
 * the card rail can still scroll. Without a stub, merely RENDERING the
 * scoreboard throws an uncaught ReferenceError from inside an effect.
 *
 * A no-op is the right shape here: jsdom reports every box as 0x0, so a real
 * implementation would have nothing to report anyway, and both components
 * already handle "never measured".
 *
 * Deliberately NOT in `setupTests.ts`. Some components branch on
 * `typeof ResizeObserver === 'undefined'` and take a different measuring path
 * when it is absent — `PinnedCarousel` does, and its tests exercise exactly
 * that fallback. Installing this globally would silently reroute them.
 */
export function stubResizeObserver(): void {
  if (typeof globalThis.ResizeObserver !== 'undefined') return;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
