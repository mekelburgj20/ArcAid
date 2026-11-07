import type { Request, Response, NextFunction } from 'express';
import { ActivityLogService } from '../services/ActivityLogService.js';

/**
 * G14 (ADR 0037 §4) - every successful admin WRITE is an `admin` row in the
 * activity log: room-scoped under `/api/rooms/:roomId/admin/*`, room-less
 * (super-admin only) under `/api/admin/*`.
 *
 * Unlike the dead `auditMiddleware`, this reads `req.user` when the RESPONSE
 * is written, not when the request arrives, so it works mounted before the
 * routers' own `requireAuth`. Stores no IP, no body values (only the body's
 * keys), and never a token. Never fails the request.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VERB: Record<string, string> = { POST: 'ran', PUT: 'changed', PATCH: 'changed', DELETE: 'deleted' };
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[A-Za-z0-9_-]{20,})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `/api/rooms/<id>/admin/tournaments/<id>/x` -> `tournaments/:id/x`. */
export function adminPathLabel(originalUrl: string): string {
    const path = originalUrl.split('?')[0] || '';
    const parts = path.split('/').filter(Boolean);
    const adminAt = parts.indexOf('admin');
    const tail = adminAt >= 0 ? parts.slice(adminAt + 1) : parts;
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
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
        try {
            const user = req.user;
            const status = res.statusCode;
            if (user && status >= 200 && status < 300
                && (user.role === 'super_admin' || user.role === 'room_admin')) {
                const label = adminPathLabel(req.originalUrl || req.url);
                const bodyKeys = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
                    ? Object.keys(req.body).slice(0, 30) : [];
                void ActivityLogService.record({
                    roomId,
                    category: 'admin',
                    eventType: 'admin_action',
                    actorUserId: user.discordId ?? null,
                    tournamentId: idAfter(req.originalUrl || '', 'tournaments'),
                    gameId: idAfter(req.originalUrl || '', 'games'),
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
    next();
}
