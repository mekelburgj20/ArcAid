/**
 * v2.37.0 — Brave-aware push-subscribe error messaging.
 *
 * `pushManager.subscribe()` can reject with an AbortError ("Registration
 * failed - push service error") even after `Notification.permission` is
 * already 'granted'. This happens on Brave when its "Use Google services for
 * push messaging" privacy setting is off (Brave's own push relay silently
 * fails). We can't reliably feature-detect Brave (`navigator.brave` is an
 * unreliable, deliberately-obscured API) so we show the hint for the whole
 * failure class — harmless for non-Brave users hitting the same class, since
 * it's an *additional* line, not a replacement of the underlying error.
 */
export function isPushServiceAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /push service/i.test(message);
}

const BRAVE_HINT =
  'If you use Brave: enable "Use Google services for push messaging" in brave://settings/privacy, relaunch, and try again.';

/**
 * Builds the user-facing push-subscribe error message. Appends the Brave hint
 * only when the failure looks like the push-service-abort class AND
 * notification permission was already granted (permission-denied/prompt
 * cases are handled separately, before subscribe() is ever called).
 */
export function buildPushErrorMessage(error: unknown, permission: NotificationPermission): string {
  const message = error instanceof Error ? error.message : 'Something went wrong enabling push.';
  if (permission === 'granted' && isPushServiceAbortError(error)) {
    return `${message} ${BRAVE_HINT}`;
  }
  return message;
}
