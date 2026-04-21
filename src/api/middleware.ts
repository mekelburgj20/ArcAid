import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from './auth.js';

// Augment Express Request to include user
declare global {
    namespace Express {
        interface Request {
            user?: TokenPayload;
        }
    }
}

/**
 * Validates JWT token, attaches decoded payload to req.user.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    const payload = verifyToken(token);
    if (!payload) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
    }

    req.user = payload;
    next();
}

/**
 * Checks req.user is super_admin OR has access to the room identified by req.params[paramName].
 */
export function requireRoomAccess(paramName: string = 'roomId') {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }

        // Super admins can access all rooms
        if (req.user.role === 'super_admin') {
            next();
            return;
        }

        const roomId = req.params[paramName] as string;
        if (!roomId) {
            res.status(400).json({ error: 'Room ID required' });
            return;
        }

        if (!req.user.gameRoomIds.includes(roomId)) {
            res.status(403).json({ error: 'Access denied to this room' });
            return;
        }

        next();
    };
}

/**
 * Conditional Discord login: only enforced when the room's
 * REQUIRE_DISCORD_LOGIN setting is 'true'. Otherwise passes through
 * untouched (submissions remain anonymous-friendly).
 *
 * When enforced, attaches req.user with discordId present.
 * Falls back to open access on setting-lookup errors (fail-open on infra
 * failure, not auth failure).
 */
export function conditionalRequireDiscordUser(roomIdParam = 'roomId') {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        const roomId = (req.params as any)[roomIdParam];
        if (!roomId) return next();

        let required = 'false';
        try {
            const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
            required = (await GameRoomSettingsService.get(roomId, 'REQUIRE_DISCORD_LOGIN')) || 'false';
        } catch {
            // Setting lookup failed — fall through to optional-auth path below (fail-open).
        }

        const authHeader = req.headers['authorization'];
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

        // v2.2.5: always try to decode the token when present, regardless of the
        // REQUIRE_DISCORD_LOGIN setting. Previously this middleware `return next()`'d
        // without looking at Authorization when the room was guest-allowed, which
        // meant a logged-in user's submission silently fell through as COMMUNITY.
        // Result: their score didn't fan out to Global and the avatar join failed.
        // Now: token present → decode + attach to req.user so downstream handlers
        // can attribute correctly. Token missing → only block when login is required.
        if (token) {
            const payload = verifyToken(token);
            if (payload?.discordId) req.user = payload;
        }

        if (required === 'true') {
            if (!req.user?.discordId) {
                res.status(401).json({ error: 'Discord login required for this room' });
                return;
            }
        }

        next();
    };
}

/**
 * Validates JWT and confirms the user has a Discord identity (any role).
 * Used for public features that require Discord login (e.g. game picking).
 */
export function requireDiscordUser(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        res.status(401).json({ error: 'Discord login required' });
        return;
    }

    const payload = verifyToken(token);
    if (!payload || !payload.discordId) {
        res.status(401).json({ error: 'Discord login required' });
        return;
    }

    req.user = payload;
    next();
}

/**
 * Checks req.user.role === 'super_admin'.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
    }

    if (req.user.role !== 'super_admin') {
        res.status(403).json({ error: 'Super admin access required' });
        return;
    }

    next();
}
