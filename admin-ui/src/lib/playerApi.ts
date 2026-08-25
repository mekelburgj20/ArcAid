import { ApiError } from './api';

/**
 * HTTP client for PLAYER-authenticated calls (v2.137.1).
 *
 * ## Why this exists — a real incident
 *
 * `lib/api.ts` is the ADMIN client. It sends `arcaid_token` and, on a 401 it
 * cannot refresh, it navigates:
 *
 * ```
 * const slug = getSlugFromPath();               // only matches /:slug/admin/*
 * window.location.href = slug ? `/${slug}/login` : '/superadmin';
 * ```
 *
 * A logged-in PLAYER holds `arcaid_player_token`, which that client does not
 * know about — so every player-context call through it went out with no
 * `Authorization` header, 401'd, matched no admin slug, and threw the player at
 * the **super-admin login page**. From the player's side that reads as an
 * endless loop: log in with Discord, land back on the scoreboard, press the
 * button, get bounced to a login screen meant for site operators.
 *
 * That is exactly what happened to a live user (@Buke, 2026-08-25) after three
 * player-facing surfaces were wired to `api.*` by mistake. The public pages had
 * always used raw `fetch` with the viewer's token; nothing enforced it.
 *
 * ## The rules this client keeps
 *
 * 1. **Send the player's token**, not the admin one.
 * 2. **NEVER navigate on a failure.** A player-facing 401 means "you are not
 *    signed in for this action" — the surface shows a login affordance in
 *    place. Redirecting a player to an operator login is never the answer.
 * 3. Throw `ApiError` so callers keep the server's structured body.
 *
 * Use this for anything a signed-in PLAYER does. Use `api.*` only inside admin
 * surfaces (`/:slug/admin/*`, `/admin/*`, `/superadmin`).
 */

export interface PlayerRequestOptions {
    /** The viewer's token from `useViewerAuth()`. Null = send the call unauthenticated. */
    token: string | null;
    signal?: AbortSignal;
}

async function playerRequest<T>(
    path: string,
    { token, signal }: PlayerRequestOptions,
    init?: RequestInit,
): Promise<T> {
    const headers: Record<string, string> = {
        ...(init?.headers as Record<string, string> | undefined),
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (init?.body && typeof init.body === 'string') headers['Content-Type'] = 'application/json';

    const res = await fetch(`/api${path}`, { ...init, headers, signal });

    if (!res.ok) {
        const body = await res.json().catch(() => ({ error: 'Request failed' }));
        // Deliberately no redirect — see rule 2 above.
        throw new ApiError(body.error || `HTTP ${res.status}`, res.status, body);
    }
    // 204 and other empty successes must not blow up on json().
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
}

export const playerApi = {
    get: <T>(path: string, opts: PlayerRequestOptions) => playerRequest<T>(path, opts),
    post: <T>(path: string, body: unknown, opts: PlayerRequestOptions) =>
        playerRequest<T>(path, opts, { method: 'POST', body: JSON.stringify(body) }),
    delete: <T>(path: string, opts: PlayerRequestOptions) =>
        playerRequest<T>(path, opts, { method: 'DELETE' }),
};
