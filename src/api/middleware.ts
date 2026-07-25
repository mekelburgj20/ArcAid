import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from './auth.js';
import { providerOfUserId } from '../utils/identityProvider.js';
import { RoomAccessService } from '../services/RoomAccessService.js';

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
 * Conditional Discord login: enforced when the room's REQUIRE_DISCORD_LOGIN
 * setting is 'true' or 'discord'. Otherwise passes through untouched
 * (submissions remain anonymous-friendly).
 *
 * Three-value domain (Google-login contract, v2.35.0):
 *   - 'false'   — guests allowed, no login required.
 *   - 'true'    — any logged-in provider accepted (Discord OR Google). This
 *                 is a deliberate semantics broadening from the pre-Google
 *                 behavior (previously 'true' meant Discord specifically,
 *                 because Discord was the only provider) — existing Discord
 *                 users are unaffected, Google users are newly allowed.
 *   - 'discord' — provider must be Discord specifically. Rooms that rely on
 *                 Discord-integrated features (DMs, /pick-game, role-based
 *                 admin) opt into this to keep the Discord guarantee.
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

        if (required === 'true' || required === 'discord') {
            if (!req.user?.discordId) {
                res.status(401).json({ error: required === 'discord' ? 'Discord login required for this room' : 'Login required for this room' });
                return;
            }
            if (required === 'discord') {
                const provider = req.user.provider ?? providerOfUserId(req.user.discordId);
                if (provider !== 'discord') {
                    res.status(401).json({ error: 'Discord login required for this room' });
                    return;
                }
            }
        }

        next();
    };
}

/**
 * Optional Discord identity — decode a Bearer token when present and attach the
 * payload to `req.user`, but NEVER block. Unlike `conditionalRequireDiscordUser`,
 * this ignores the room's `REQUIRE_DISCORD_LOGIN` setting: it's for the low-stakes
 * social routes (game comments/tips) that must stay open to guests even in
 * login-required rooms, while still recognizing a token-bearing author/admin when
 * the client does send one.
 */
export function optionalDiscordUser(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const payload = verifyToken(token);
        if (payload?.discordId) req.user = payload;
    }
    next();
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
 * Approval-rooms (v2.39.0) hard view gate. Mounted ONCE via
 * `router.use('/:roomId', roomVisibilityGate)` in rooms.ts, registered AFTER
 * the portal + scoreboard-config route handlers so those two stay reachable
 * for everyone (structural bypass by registration order — Express never
 * reaches this middleware for a request those routes already answered).
 * Every other room-scoped route — public reads, submit paths, picks, lobby,
 * comments, stats, history, dashboard, game_library, tournaments,
 * games/active, and the admin routes — passes through it.
 *
 * 'open' policy (or the setting absent): next() immediately, zero extra
 * queries beyond the settings read. 'approval' policy: decode the Bearer
 * token independently (requireAuth hasn't run yet at this point in the
 * chain — mirrors conditionalRequireDiscordUser's decode pattern) and defer
 * to RoomAccessService.canViewRoom, the same check the WebSocket join
 * handlers use. Guests (no token) and non-members always 403.
 */
export async function roomVisibilityGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const roomId = req.params.roomId as string;
    if (!roomId) return next();

    let policy: 'open' | 'approval' = 'open';
    try {
        policy = await RoomAccessService.getJoinPolicy(roomId);
    } catch {
        // Fail-open on infra failure, not auth failure — matches
        // conditionalRequireDiscordUser's fail-open-on-lookup-error contract.
        return next();
    }
    if (policy !== 'approval') return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const payload = token ? verifyToken(token) : null;

    const allowed = await RoomAccessService.canViewRoom(payload, roomId);
    if (!allowed) {
        res.status(403).json({ error: 'This room requires approval to join', code: 'APPROVAL_REQUIRED' });
        return;
    }
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
