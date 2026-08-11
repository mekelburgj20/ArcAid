/**
 * v2.100.0 (linked-identity role-sync fix) — shared by both OAuth callbacks'
 * normal-login AND linked-login branches (GoogleCallback.tsx, DiscordCallback.tsx).
 *
 * Field report: a user whose Discord account is a room admin logged in via
 * their LINKED Google account and got no "Room admin" affordances, even
 * though logging in via Discord directly worked. Two causes:
 *   1. The `linked === true` early-return branches in both callbacks stored
 *      the fresh token only as the player token — they never seeded the
 *      admin-token slot (`arcaid_token`) at all, unlike the plain-login
 *      branch a few lines below.
 *   2. Where seeding DID happen (the plain-login branch), the guard was
 *      `!localStorage.getItem('arcaid_token')` — a ONE-SHOT check. Once any
 *      token (even a long-expired one from a previous session) occupied the
 *      slot, it was never re-evaluated, silently blocking every future
 *      admin-affordance render until the user manually cleared storage.
 *
 * `maybeSeedAdminSlot` fixes both: it's called from every login branch that
 * mints a token (normal login on either provider, and the linked-login
 * completion on either provider), and it re-seeds whenever the existing slot
 * is empty OR its token is expired/undecodable — never overwriting a live,
 * unexpired admin token, since that may belong to a higher-privilege session
 * already active in this browser.
 */
import { setToken } from './api';

/** Decode a JWT payload without verifying its signature — FE routing/display
 * only (mirrors the idiom used in GameDetail.tsx / the OAuth callbacks).
 * Exported so PublicLayout can decode the player token with the same logic
 * used to guard the admin-slot seed, rather than a fourth copy of this idiom. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** True when `token` is missing, undecodable, has no numeric `exp` claim, or
 * that `exp` has already passed. Anything "not clearly still live" counts as
 * expired here — the caller only skips seeding for a token it can positively
 * confirm is still good. Exported for PublicLayout's admin-slot liveness check. */
export function isExpiredOrInvalid(token: string | null): boolean {
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== 'number') return true;
  return exp * 1000 <= Date.now();
}

/**
 * Seeds the admin-token slot (`arcaid_token` + `arcaid_admin_refresh_token`)
 * from a freshly-issued token when its role qualifies (`room_admin` or
 * `super_admin`) AND the existing slot is empty or expired. No-op for a
 * `player` role, and no-op when a live unexpired admin token already
 * occupies the slot (never downgrade an active higher-privilege session).
 */
export function maybeSeedAdminSlot(token: string, role: string | undefined, refreshToken?: string): void {
  if (role !== 'room_admin' && role !== 'super_admin') return;
  const existing = localStorage.getItem('arcaid_token');
  if (!isExpiredOrInvalid(existing)) return;
  setToken(token);
  if (refreshToken) localStorage.setItem('arcaid_admin_refresh_token', refreshToken);
}
