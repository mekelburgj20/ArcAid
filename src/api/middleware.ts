import { Request, Response, NextFunction } from 'express';
import { verifyToken, TokenPayload } from './auth.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { BanService } from '../services/BanService.js';
import { logError } from '../utils/logger.js';

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
 * Optional Discord identity — decode a Bearer token when present and attach the
 * payload to `req.user`, but NEVER block. Login is mandatory for all score
 * submissions unconditionally as of v2.79.0 (see `requireAuth`/`requireDiscordUser`
 * on those routes); this middleware is for the low-stakes social routes (game
 * comments/tips) that must stay open to guests regardless, while still
 * recognizing a token-bearing author/admin when the client does send one.
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
 * Optional identity — decode ANY valid Bearer token (regardless of whether it
 * carries a Discord identity) and attach it to `req.user`, but NEVER block.
 *
 * Differs from `optionalDiscordUser` above, which silently drops a valid
 * token that lacks `discordId`. That's the right behavior for a route gating
 * on Discord identity specifically (e.g. comment/rating authorship, since
 * only a Discord-linked identity can author one post-v2.86.0), but wrong for
 * a route that ALSO needs to recognize a password/local-admin token
 * (`localAdminId` set, no `discordId`) — otherwise a room_admin or
 * super_admin who logged in with a password loses their moderation
 * privileges on that route. Used on the room comment DELETE route so
 * `req.user.role`-based admin authz works for every login method, while the
 * author-match fallback there still reads `req.user?.discordId` /
 * `x-user-id` for guest and Discord-authenticated authors.
 */
export function optionalUser(req: Request, _res: Response, next: NextFunction): void {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (token) {
        const payload = verifyToken(token);
        if (payload) req.user = payload;
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
 * chain) and defer to RoomAccessService.canViewRoom, the same check the
 * WebSocket join handlers use. Guests (no token) and non-members always 403.
 *
 * S22 Phase 2 (v2.44.0) — a suspension check runs FIRST, ahead of the
 * approval-policy check: suspension blocks everyone except super-admins,
 * including the room's own admins (design decision #2 — "hidden +
 * inaccessible pending review"), which is strictly stronger than the
 * approval gate's member/admin allowance.
 */
export async function roomVisibilityGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const roomId = req.params.roomId as string;
    if (!roomId) return next();

    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const payload = token ? verifyToken(token) : null;

    try {
        const suspended = await RoomAccessService.isSuspended(roomId);
        if (suspended && payload?.role !== 'super_admin') {
            res.status(403).json({ error: 'This room has been suspended pending review.', code: 'ROOM_SUSPENDED' });
            return;
        }
    } catch {
        // Fail-open on infra failure, not auth failure.
    }

    let policy: 'open' | 'approval' = 'open';
    try {
        policy = await RoomAccessService.getJoinPolicy(roomId);
    } catch {
        // Fail-open on infra failure, not auth failure.
        return next();
    }
    if (policy !== 'approval') return next();

    const allowed = await RoomAccessService.canViewRoom(payload, roomId);
    if (!allowed) {
        res.status(403).json({ error: 'This room requires approval to join', code: 'APPROVAL_REQUIRED' });
        return;
    }
    next();
}

/**
 * v2.47.0 (S22 follow-ups Workstream 1) — per-submit ban enforcement.
 * No-op when `req.user?.discordId` is absent (anonymous writers aren't
 * bannable — nothing to check). Otherwise consults `BanService.isIdentityBanned`
 * (the ONE link-graph-aware ban predicate — see BanService's doc comment) and
 * 403s with the exact string used at login (`auth.ts`'s ACCOUNT_BANNED path)
 * when banned. Composes AFTER `requireDiscordUser` / `optionalDiscordUser`,
 * same as `requireRoomAccess`.
 *
 * v2.49.0 (room-tier bans) — auto-reads `req.params.roomId` (absent on
 * pure-global routes) and passes it through, so every room-shaped route
 * mounted behind this middleware becomes room-ban-aware for free, with zero
 * per-route changes. `BanService.isIdentityBanned` still checks global bans
 * too when a room id is present (decision: a global ban bites everywhere).
 */
export async function requireNotBanned(req: Request, res: Response, next: NextFunction): Promise<void> {
    const discordId = req.user?.discordId;
    if (!discordId) {
        next();
        return;
    }
    try {
        const roomId = req.params.roomId as string | undefined;
        const result = await BanService.isIdentityBanned(discordId, roomId ?? null);
        if (result.banned) {
            res.status(403).json({ error: 'This account is banned.' });
            return;
        }
    } catch (err) {
        // Fail-open on infra failure, not auth failure.
        // L1 hardening (S22 follow-ups) — fail-open must not be SILENT: a
        // sustained DB outage here would otherwise let bans go unenforced
        // with no signal in the logs.
        logError('requireNotBanned: ban check failed open', err);
    }
    next();
}

/**
 * v2.49.0 fix-round (tmp/room-bans-fixes.md #1) — GLOBAL-only ban gate,
 * deliberately ignoring `req.params.roomId` even when present.
 *
 * `requireNotBanned` auto-reads `req.params.roomId` so every room-shaped
 * route becomes room-ban-aware "for free". That's the right default for
 * routes where `:roomId` is the room the request ACTS in — but it's the
 * wrong default for a route where `:roomId` merely NAMES something (e.g. the
 * room being reported), because then a room admin could ban the reporter to
 * suppress escalation of their own room to super-admins, which violates the
 * settled contract decision that a room ban must never block global surfaces
 * (Global Scoreboard, friends, or moderation escalation about ANY room,
 * including the one that issued the ban).
 *
 * Use this on any route whose `:roomId` param is a report/flag TARGET rather
 * than an acting context. Do not "fix" this by having such a route omit its
 * `:roomId` param name or rename it — the next room-shaped global route
 * would just rediscover the same trap by using `requireNotBanned` naively.
 * Reach for this middleware by name instead.
 */
export async function requireNotBannedGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    const discordId = req.user?.discordId;
    if (!discordId) {
        next();
        return;
    }
    try {
        const result = await BanService.isIdentityBanned(discordId);
        if (result.banned) {
            res.status(403).json({ error: 'This account is banned.' });
            return;
        }
    } catch (err) {
        logError('requireNotBannedGlobal: ban check failed open', err);
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
