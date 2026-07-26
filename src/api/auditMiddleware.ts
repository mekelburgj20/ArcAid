import { Request, Response, NextFunction } from 'express';
import { AuditService } from '../services/AuditService.js';

/**
 * Middleware that logs admin write operations (POST, PUT, DELETE) to the audit log.
 * Must be mounted after requireAuth (needs req.user) and correlationId middleware.
 */
export function auditLog(req: Request, res: Response, next: NextFunction): void {
    // Only audit write operations
    if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
        next();
        return;
    }

    // Only audit authenticated requests
    if (!req.user) {
        next();
        return;
    }

    // Capture the original json method to log after response
    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
        // Log audit entry asynchronously (don't block the response)
        const actor = req.user!.username || req.user!.discordId || req.user!.localAdminId || 'unknown';
        const statusCode = res.statusCode;

        // Only audit successful operations (2xx)
        if (statusCode >= 200 && statusCode < 300) {
            // Derive action from method + path
            const action = `${req.method} ${req.baseUrl}${req.path}`;
            // Derive target from route params
            const targetType = deriveTargetType(req.baseUrl + req.path);
            const targetId = deriveTargetId(req.params);

            AuditService.log({
                actor,
                action,
                target_type: targetType,
                target_id: targetId,
                details: JSON.stringify(sanitizeBody(req.body)),
                ip_address: (req.ip || req.socket?.remoteAddress || 'unknown') as string,
                correlation_id: req.correlationId || '',
            }).catch(() => {}); // Fire-and-forget
        }

        return originalJson(body);
    };

    next();
}

/** Derive a human-readable target type from the route path */
function deriveTargetType(path: string): string {
    // Match common resource patterns
    const patterns: [RegExp, string][] = [
        [/\/tournaments/, 'tournament'],
        [/\/join-requests/, 'join_request'],
        [/\/rooms/, 'room'],
        [/\/settings/, 'settings'],
        [/\/game_library/, 'game_library'],
        [/\/ranking-groups/, 'ranking_group'],
        [/\/admins/, 'admin'],
        [/\/super-admins/, 'super_admin'],
        [/\/backups/, 'backup'],
        [/\/merge-player/, 'player'],
        // m7 fix (S22 Phase 2 adversarial review) — PATCH
        // /admin/users/:userId/display-name previously fell through to
        // 'unknown' (no pattern matched `/users`), so the audit row for the
        // admin display-name override had no usable target_type.
        [/\/users/, 'user'],
        [/\/games/, 'game'],
        [/\/scheduler/, 'scheduler'],
        [/\/ratings/, 'rating'],
    ];
    for (const [regex, type] of patterns) {
        if (regex.test(path)) return type;
    }
    return 'unknown';
}

/** Derive target ID from route params */
function deriveTargetId(params: Record<string, any>): string {
    // Try common param names. `userId` added (m7 fix, S22 Phase 2 adversarial
    // review) for PATCH /admin/users/:userId/display-name — previously fell
    // through to '' since no prior param name matched.
    return params.id || params.roomId || params.name || params.discordId || params.userId || '';
}

/** Remove sensitive fields from request body before logging */
function sanitizeBody(body: any): any {
    if (!body || typeof body !== 'object') return body;
    const sanitized = { ...body };
    const sensitiveKeys = [
        'password', 'newPassword',
        'ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH', 'JWT_SECRET', 'SECRETS_KEY',
        'DISCORD_BOT_TOKEN',
    ];
    for (const key of sensitiveKeys) {
        if (key in sanitized) {
            sanitized[key] = '[REDACTED]';
        }
    }
    return sanitized;
}
