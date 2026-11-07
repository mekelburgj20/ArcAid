import type { Request, Response, NextFunction } from 'express';
import { ActivityLogService } from '../services/ActivityLogService.js';
import { activityRequestContext, type ActivityRequestStore } from '../utils/activityRequestContext.js';

/**
 * G14 (ADR 0037 §4) - every successful admin WRITE is an `admin` row in the
 * activity log: room-scoped under `/api/rooms/:roomId/*`, room-less
 * (super-admin only) under `/api/admin/*`.
 *
 * A room write counts as an admin write only when BOTH hold:
 *   1. the request passed the room-admin check (`requireRoomAccess` sets
 *      `res.locals.roomAdminChecked`), and
 *   2. its path is on `ROOM_ADMIN_WRITE_PATTERNS` below.
 * So a player's score submission is never an admin row, and neither is a
 * room admin's own score submission (not on the list).
 *
 * When the handler already recorded a row of its own during the request
 * (a merge, an attempt void, a forced rotation - see `activityRequestContext`),
 * this generic row is skipped, so one action is never logged twice.
 *
 * Unlike the dead `auditMiddleware`, this reads `req.user` when the RESPONSE
 * is written, not when the request arrives, so it works mounted before the
 * routers' own auth. Stores no IP, no body values (only the body's keys),
 * and never a token. Never fails the request.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VERB: Record<string, string> = { POST: 'ran', PUT: 'changed', PATCH: 'changed', DELETE: 'deleted' };
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{20,})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Room-admin write routes, as the path AFTER `/api/rooms/<roomId>/`. Every
 * entry is a route behind `requireRoomAccess`; adding a room-admin write route
 * outside these prefixes means adding its pattern here.
 */
export const ROOM_ADMIN_WRITE_PATTERNS: RegExp[] = [
    /^admin(\/|$)/,
    /^settings$/,
    /^tournaments(\/|$)/,
    /^events\/[^/]+\/(participants|rounds)(\/|$)/,
    /^games(\/|$)/,
    /^game_library(\/|$)/,
    /^ranking-groups(\/|$)/,
    /^lobby\/(feed|announcements|shelf|shelf-reorder|config)(\/|$)/,
    /^scores\/import-csv/,
    /^score-history\/[^/]+\/(verify|unverify)$/,
    /^admins(\/|$)/,
    /^scheduler(\/|$)/,
    /^iscored\/validate$/,
];

/** The path after `/api/rooms/<id>/`, or null when the URL is not a room route. */
export function roomRelativePath(originalUrl: string): string | null {
    const path = (originalUrl.split('?')[0] || '').replace(/\/+$/, '');
    const m = /^\/api\/rooms\/[^/]+\/(.+)$/.exec(path);
    return m ? m[1]! : null;
}

export function isRoomAdminWrite(originalUrl: string): boolean {
    const rel = roomRelativePath(originalUrl);
    return rel != null && ROOM_ADMIN_WRITE_PATTERNS.some(p => p.test(rel));
}

/** `/api/rooms/<id>/admin/tournaments/<id>/x` -> `tournaments/:id/x`. */
export function adminPathLabel(originalUrl: string): string {
    const path = originalUrl.split('?')[0] || '';
    const parts = path.split('/').filter(Boolean);
    const adminAt = parts.indexOf('admin');
    const roomsAt = parts.indexOf('rooms');
    const tail = adminAt >= 0 ? parts.slice(adminAt + 1)
        : roomsAt >= 0 ? parts.slice(roomsAt + 2)
        : parts;
    return tail.map(p => (ID_SEGMENT.test(decodeURIComponent(p)) ? ':id' : decodeURIComponent(p))).join('/') || 'admin';
}

function idAfter(originalUrl: string, segment: string): string | null {
    const parts = (originalUrl.split('?')[0] || '').split('/');
    const i = parts.indexOf(segment);
    const v = i >= 0 ? parts[i + 1] : undefined;
    return v && UUID.test(v) ? v : null;
}

export function activityAdminLog(req: Request, res: Response, next: NextFunction): void {
    if (!WRITE_METHODS.has(req.method)) { next(); return; }
    const roomId = typeof req.params?.roomId === 'string' ? req.params.roomId : null;
    const url = req.originalUrl || req.url;
    // Room routes: only allowlisted admin paths. `/api/admin/*` is super-admin only by its router.
    if (roomId && !isRoomAdminWrite(url)) { next(); return; }

    const store: ActivityRequestStore = {
        wrote: false,
        actor: () => {
            const u = req.user;
            if (!u || (u.role !== 'super_admin' && u.role !== 'room_admin')) return null;
            return { userId: u.discordId ?? null, name: u.discordId ? null : (u.username ?? 'admin'), role: u.role };
        },
    };
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
        try {
            const user = req.user;
            const status = res.statusCode;
            const passedAdminCheck = roomId ? res.locals.roomAdminChecked === true : true;
            if (!store.wrote && user && passedAdminCheck && status >= 200 && status < 300
                && (user.role === 'super_admin' || user.role === 'room_admin')) {
                const label = adminPathLabel(url);
                const bodyKeys = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                    ? Object.keys(req.body).slice(0, 30) : [];
                void ActivityLogService.record({
                    roomId,
                    category: 'admin',
                    eventType: 'admin_action',
                    actorUserId: user.discordId ?? null,
                    tournamentId: idAfter(url, 'tournaments'),
                    gameId: idAfter(url, 'games') ?? idAfter(url, 'game-states'),
                    summary: `Admin ${VERB[req.method] ?? req.method} ${label}`,
                    details: {
                        method: req.method, path: label, fields: bodyKeys,
                        actorName: user.discordId ? null : (user.username ?? 'admin'),
                        role: user.role,
                    },
                });
            }
        } catch { /* never fail the response */ }
        return originalJson(body);
    } as typeof res.json;
    activityRequestContext.run(store, () => next());
}
