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
  is_public?: boolean;
  pick_award_enabled?: boolean;
  /** v2.35.0 — drives the "sign in with Discord for DMs/picks" login nudge. */
  discord_enabled?: boolean;
  /** v2.39.0 (approval rooms) — 'open' (default) | 'approval'. */
  join_policy?: 'open' | 'approval';
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
    .then(r => {
      if (!r.ok) throw new Error(`Room not found: ${slug}`);
      return r.json() as Promise<Portal>;
    })
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

/** Drop the cached portal for a slug — used after a join-request/approval so
 * a caller can force a fresh resolve instead of waiting for a full reload. */
export function invalidatePortal(slug: string): void {
  cache.delete(slug.toLowerCase());
}
