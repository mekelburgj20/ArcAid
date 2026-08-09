/**
 * Stale-PWA update nudge — pure compare/dismiss logic (2026-08 field report).
 *
 * Installed PWAs can keep running a stale bundle for a while: the service
 * worker is cache-first for static assets, and only index.html/sw.js are
 * no-cache, so a reload picks up a new build but nothing tells the user to
 * reload. This module holds the baseline-at-boot comparison used to decide
 * when to show a "new version available" nudge, kept separate from the
 * fetch/timer plumbing (see `hooks/useUpdateNudge.ts`) so it's testable
 * without touching fake timers or React rendering.
 *
 * Design: the FIRST successful `/api/version` fetch this session sets
 * `baseline`; every fetch after that (on visibilitychange + a slow poll)
 * updates `latest`. The nudge shows once `latest` diverges from `baseline`
 * and the player hasn't already dismissed that exact version. Because
 * baseline and latest are set to the SAME value on the first fetch, the
 * nudge can never fire on first load — no separate "is this the first
 * load" flag needed.
 */

export const UPDATE_NUDGE_DISMISS_KEY = 'arcaid_update_nudge_dismissed_version';

/** Slow backstop poll — visibilitychange covers the common "left a tab open" case. */
export const UPDATE_NUDGE_POLL_INTERVAL_MS = 15 * 60 * 1000;

export interface UpdateNudgeState {
  /** Version seen on the first successful fetch this session. Null until then. */
  baseline: string | null;
  /** Version seen on the most recent successful fetch. Null until the first one lands. */
  latest: string | null;
}

export const initialUpdateNudgeState: UpdateNudgeState = { baseline: null, latest: null };

/**
 * Folds a freshly-fetched version string into state. `baseline` is captured
 * once and never overwritten; `latest` always tracks the most recent fetch.
 */
export function applyFetchedVersion(state: UpdateNudgeState, version: string): UpdateNudgeState {
  return {
    baseline: state.baseline ?? version,
    latest: version,
  };
}

/**
 * True when the nudge banner should render. Silent (false) until a baseline
 * exists, false while latest === baseline (nothing changed, or first load),
 * false once the player has dismissed this exact latest version.
 */
export function shouldShowUpdateNudge(state: UpdateNudgeState, dismissedVersion: string | null): boolean {
  if (!state.baseline || !state.latest) return false;
  if (state.latest === state.baseline) return false;
  if (dismissedVersion === state.latest) return false;
  return true;
}
