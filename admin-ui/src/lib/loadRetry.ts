/**
 * A page load that tries again by itself (G31, v2.265.4).
 *
 * Owner report 2026-11-23: a room page came up with no logo, no title and
 * "Waiting for active games" because every request after the room lookup had
 * been refused (429). Each load did `if (res.ok) setX(...)` inside
 * `catch { ignore }`, so a refused or failed request was indistinguishable from
 * a room with nothing in it, and nothing tried again until a manual refresh.
 *
 * Two things were missing, and this module is both:
 *
 *   1. **Telling "failed for now" from "the answer is nothing".** A thrown
 *      fetch (no connection, a deploy restart mid-request), a 429 and a 5xx are
 *      all "ask again shortly" (`isTransientStatus`). A 401, 403 or 404 is an
 *      answer; asking again gets the same one.
 *   2. **Asking again.** `RetryingLoader` re-runs a failed load on a rising
 *      delay (`RETRY_STEPS_MS`), or after exactly as long as the server said
 *      (`Retry-After`, which the rate limiter sends with a 429), and reports
 *      one of three phases so the page can say which state it is in.
 *
 * It is NOT the live-update mechanism: sockets and `useLiveRefresh` still
 * decide when a healthy page reloads. They call the same `load()`; a call
 * while a retry is pending simply replaces it.
 */

/** A status that means "try again shortly", not "the answer is no". */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Rising waits between tries without a server hint; the last one repeats. */
export const RETRY_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

/** Never wait longer than this on the server's say-so (the limiter's window is 60 s). */
export const RETRY_AFTER_CAP_MS = 60_000;

type HeaderSource = { headers?: { get(name: string): string | null } | null };

/**
 * How long the server asked us to wait, in ms, or null when it did not say.
 * `Retry-After` is seconds or an HTTP date; `RateLimit-Reset` (the limiter's
 * standard header) is seconds until the window resets.
 */
export function retryAfterMs(res: HeaderSource | null | undefined, now: number = Date.now()): number | null {
  const headers = res?.headers;
  if (!headers || typeof headers.get !== 'function') return null;
  for (const name of ['Retry-After', 'RateLimit-Reset']) {
    const raw = headers.get(name);
    if (raw == null || raw.trim() === '') continue;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    if (name === 'Retry-After') {
      const at = Date.parse(raw);
      if (Number.isFinite(at)) return Math.max(0, at - now);
    }
  }
  return null;
}

/**
 * The wait before try number `attempt + 1` (attempt 0 = the first retry).
 * With a server hint: that long (capped), plus up to a second so a room full
 * of phones does not all return on the same tick. Without: the step for this
 * attempt, spread 15% either way.
 */
export function retryDelayMs(
  attempt: number,
  res?: HeaderSource | null,
  random: () => number = Math.random,
): number {
  return retryDelayForHint(attempt, retryAfterMs(res), random);
}

/** `retryDelayMs` for a caller that already holds the server's hint (or null). */
export function retryDelayForHint(
  attempt: number,
  asked: number | null,
  random: () => number = Math.random,
): number {
  if (asked != null) return Math.min(asked, RETRY_AFTER_CAP_MS) + Math.round(random() * 1000);
  const step = RETRY_STEPS_MS[Math.min(Math.max(attempt, 0), RETRY_STEPS_MS.length - 1)];
  return Math.round(step * (0.85 + random() * 0.3));
}

/**
 * - `loading`: no answer yet.
 * - `retrying`: no answer yet AND the last try failed; another is scheduled.
 * - `ready`: an answer arrived (data, or a definite refusal). A later failed
 *   reload keeps `ready` (the page keeps what it has) and retries quietly.
 */
export type LoadPhase = 'loading' | 'retrying' | 'ready';

export interface RetryingLoaderHooks {
  /** The request. A rejection counts as a transient failure. */
  request: () => Promise<Response>;
  /** Called with an ok response; if it throws (a broken body), that is a transient failure too. */
  onOk: (res: Response) => void | Promise<void>;
  onPhase: (phase: LoadPhase) => void;
}

export class RetryingLoader {
  private hooks: RetryingLoaderHooks | null;
  /** Bumped by every `load()`; only the newest call may schedule a retry or set the phase. */
  private seq = 0;
  /** The newest call whose ok answer was applied, so a slow old answer never overwrites a newer one. */
  private applied = 0;
  /** Bumped by `reset()`; an answer from before a reset is for another subject and is dropped. */
  private generation = 0;
  private attempt = 0;
  private answered = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(hooks?: RetryingLoaderHooks) {
    this.hooks = hooks ?? null;
  }

  /**
   * Swap the callbacks (the React binding does this after every render, so
   * they always see the latest props). A try already in flight reports to
   * whatever is set when its answer lands.
   */
  setHooks(hooks: RetryingLoaderHooks): void {
    this.hooks = hooks;
  }

  /** Ask now. Replaces a pending retry. Does nothing until there are callbacks. */
  load = (): void => {
    if (!this.hooks) return;
    this.clearTimer();
    const seq = ++this.seq;
    const generation = this.generation;
    const current = () => generation === this.generation;

    const failed = (res: Response | null) => {
      if (!current() || seq !== this.seq) return;
      if (!this.answered) this.hooks?.onPhase('retrying');
      this.timer = setTimeout(this.load, retryDelayMs(this.attempt++, res));
    };
    const settled = () => {
      if (!current() || seq !== this.seq) return;
      this.answered = true;
      this.attempt = 0;
      this.hooks?.onPhase('ready');
    };

    let pending: Promise<Response>;
    try {
      pending = this.hooks.request();
    } catch {
      failed(null);
      return;
    }
    pending.then(
      async res => {
        if (!current()) return;
        if (res.ok) {
          if (seq < this.applied) return;
          this.applied = seq;
          try {
            await this.hooks?.onOk(res);
          } catch {
            failed(null);
            return;
          }
          settled();
        } else if (isTransientStatus(res.status)) {
          failed(res);
        } else {
          settled();
        }
      },
      () => failed(null),
    );
  };

  /** A new subject (another room): forget the answer, drop what is in flight. */
  reset = (): void => {
    this.clearTimer();
    this.generation++;
    this.attempt = 0;
    this.answered = false;
  };

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
