/**
 * Shared portal (slug → room) resolution cache (S18).
 *
 * `/api/portal?slug=<slug>` is the canonical slug→room lookup used across
 * every public page. Pre-S18, 9+ call sites each fetched it independently
 * (and 6 more pages fetched the FULL `/api/rooms` list just to resolve a
 * slug). This module gives every caller ONE shared in-flight/settled promise
 * per slug so concurrent mounts (e.g. PublicLayout + a child page both
 * resolving the same slug on first paint) share a single network request.
 *
 * Failures are NOT cached — the map entry is deleted before the rejection
 * propagates, so a transient failure doesn't permanently poison the slug.
 */

import { isTransientStatus, retryAfterMs, retryDelayForHint } from './loadRetry';

export interface Portal {
  id: string;
  roomId: string;
  slug: string;
  name: string;
  description?: string | null;
  logo_url?: string | null;
  ui_theme?: string | null;
  admin_theme?: string | null;
  /** Not always present in the live response — public/showcase theme override. */
  public_theme?: string | null;
  /** G29 (v2.264.0): the room's carpet floor switch; the server sends 'on' when unset. */
  ui_floor?: 'on' | 'off';
  is_public?: boolean;
  pick_award_enabled?: boolean;
  /** v2.35.0 — drives the "sign in with Discord for DMs/picks" login nudge. */
  discord_enabled?: boolean;
  /** v2.39.0 (approval rooms) — 'open' (default) | 'approval'. */
  join_policy?: 'open' | 'approval' | 'discord_role';
  /** v2.39.0 — this viewer's relationship to the room. 'none'/'pending' only
   * matter when join_policy is 'approval' — open rooms render normally
   * regardless of this value. */
  viewer_status?: 'admin' | 'member' | 'pending' | 'none';
  /** S22 Phase 2 (v2.44.0) — when true, every other field except name/slug is
   * absent: the server intentionally ships a minimal shape for a suspended
   * room (no settings/config/scores). Callers must check this BEFORE relying
   * on `roomId`/`id` being present. */
  suspended?: boolean;
}

/**
 * The lookup failed FOR NOW (no connection, a refused request, a restart), as
 * opposed to "there is no such room" (G31, v2.265.4). Before this every
 * failure was the same plain Error and the room page said "Room not found"
 * for a dropped connection.
 */
export class PortalUnavailableError extends Error {
  /** How long the server asked us to wait, when it said. */
  readonly retryAfterMs: number | null;
  constructor(slug: string, retryAfter: number | null) {
    super(`Room lookup unavailable: ${slug}`);
    this.name = 'PortalUnavailableError';
    this.retryAfterMs = retryAfter;
  }
}

const cache = new Map<string, Promise<Portal>>();

export function getPortal(slug: string): Promise<Portal> {
  const key = slug.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  // v2.39.0 — attach the player token (when present) so the server can
  // resolve viewer_status (member/admin/pending) instead of always seeing a
  // guest. Read directly from localStorage rather than via a hook: this
  // module is a plain fetch-cache, not a React consumer.
  const playerToken = localStorage.getItem('arcaid_player_token');
  const headers: Record<string, string> = playerToken ? { Authorization: `Bearer ${playerToken}` } : {};

  const promise = fetch(`/api/portal?slug=${encodeURIComponent(slug)}`, { headers })
    .then(
      r => {
        if (r.ok) return r.json() as Promise<Portal>;
        if (isTransientStatus(r.status)) throw new PortalUnavailableError(slug, retryAfterMs(r));
        throw new Error(`Room not found: ${slug}`);
      },
      // The request never got an answer at all.
      () => { throw new PortalUnavailableError(slug, null); },
    )
    // Normalize the id/roomId duplication ONCE here — the live handler ships
    // both fields, but callers should only ever need `roomId`.
    .then(p => ({ ...p, roomId: p.roomId ?? p.id }))
    .catch(err => {
      // Don't cache failures — a retry (e.g. after the network recovers)
      // should get a fresh attempt, not a poisoned rejected promise forever.
      cache.delete(key);
      throw err;
    });

  cache.set(key, promise);
  return promise;
}

/**
 * `getPortal` that waits out a failure-for-now (G31): it keeps asking, on the
 * shared rising delay, until the room answers. It resolves with the portal and
 * rejects only on a definite answer ("no such room"). `onWaiting` fires each
 * time a try fails for now, so the caller can say it is still trying.
 *
 * Abort `signal` when the caller goes away; the promise then never settles,
 * which is what an effect that has been cleaned up wants.
 */
export function getPortalPatiently(
  slug: string,
  opts: { signal?: AbortSignal; onWaiting?: () => void } = {},
): Promise<Portal> {
  const { signal, onWaiting } = opts;
  return new Promise<Portal>((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      if (signal?.aborted) return;
      getPortal(slug).then(resolve, err => {
        if (!(err instanceof PortalUnavailableError)) { reject(err); return; }
        if (signal?.aborted) return;
        onWaiting?.();
        const timer = setTimeout(tryOnce, retryDelayForHint(attempt++, err.retryAfterMs));
        signal?.addEventListener('abort', () => clearTimeout(timer), { once: true });
      });
    };
    tryOnce();
  });
}

/** Drop the cached portal for a slug — used after a join-request/approval so
 * a caller can force a fresh resolve instead of waiting for a full reload. */
export function invalidatePortal(slug: string): void {
  cache.delete(slug.toLowerCase());
}
