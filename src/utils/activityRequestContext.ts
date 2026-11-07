import { AsyncLocalStorage } from 'async_hooks';

/**
 * G14 (ADR 0037) - per-request context for an admin write.
 *
 * `activityAdminLog` opens it for admin-looking requests. Any activity row
 * recorded while the request runs marks it `wrote`, and the middleware then
 * skips its generic "Admin changed ..." row: the handler already wrote a
 * richer one (a merge, a void, a forced rotation), so no action is logged
 * twice. `actor()` lets those rows name the admin who acted.
 */
export interface ActivityRequestStore {
    wrote: boolean;
    actor: () => { userId: string | null; name: string | null; role: string | null } | null;
}

export const activityRequestContext = new AsyncLocalStorage<ActivityRequestStore>();
